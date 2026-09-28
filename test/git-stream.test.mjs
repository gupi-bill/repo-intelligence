import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { streamHistory } from '../src/core/git.mjs';
import { makeFixture, write, gitLogHashes, gitShowNames } from './helpers/fixture.mjs';

/**
 * Build a history that exercises every shape the parser claims to handle.
 * Returns the fixture directory.
 */
async function awkwardHistory() {
  return makeFixture(async (git, dir) => {
    // 1. plain commit, simple file
    await write(dir, 'a.txt', 'one\ntwo\nthree\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);

    // 2. path with spaces + non-ASCII
    await write(dir, 'dir with space/héllo wörld.txt', 'ünïcödé\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'spaces and unicode']);

    // 3. empty commit (no file changes at all)
    await git(['commit', '-q', '--allow-empty', '-m', 'empty commit']);

    // 4. rename
    await git(['mv', 'a.txt', 'renamed.txt']);
    await git(['commit', '-q', '-m', 'rename a']);

    // 5. binary file
    await write(dir, 'img.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'binary']);

    // 6. side branch + merge commit
    await git(['checkout', '-q', '-b', 'feature']);
    await write(dir, 'feature.txt', 'feature\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'feature work']);
    await git(['checkout', '-q', 'main']);
    await write(dir, 'main-only.txt', 'main\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'main work']);
    await git(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);

    // 7. delete a file
    await git(['rm', '-q', 'main-only.txt']);
    await git(['commit', '-q', '-m', 'delete main-only']);

    // 8. commit touching many files at once (batch record)
    for (let i = 0; i < 25; i += 1) {
      await write(dir, `batch/file-${i}.txt`, `content ${i}\n`.repeat(i + 1));
    }
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'batch of 25 files']);

    // 9. commit subject containing REAL control bytes that collide with the
    //    stream's own framing characters. A naive parser mis-frames here.
    await write(dir, 'tricky.txt', 'x\n');
    await git(['add', '-A']);
    await write(dir, '.git/COMMIT_EDITMSG_TRICKY', 'subject with \x01 and \x02 framing bytes\n');
    await git(['commit', '-q', '-F', '.git/COMMIT_EDITMSG_TRICKY']);
    await rm(join(dir, '.git/COMMIT_EDITMSG_TRICKY'), { force: true });

    // 10. another empty commit at the tip
    await git(['commit', '-q', '--allow-empty', '-m', 'tip empty']);
  });
}

test('stream parser sees exactly the commits git sees (names mode)', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const expected = await gitLogHashes(dir);
  const seen = [];
  await streamHistory({ cwd: dir, mode: 'names' }, (c) => seen.push(c));

  assert.equal(seen.length, expected.length, 'commit count must match git exactly');
  assert.deepEqual(seen.map((c) => c.hash), expected, 'hashes and order must match git');
});

test('stream parser sees exactly the commits git sees (lines mode)', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const expected = await gitLogHashes(dir);
  const seen = [];
  await streamHistory({ cwd: dir, mode: 'lines', renames: true }, (c) => seen.push(c));

  assert.equal(seen.length, expected.length);
  assert.deepEqual(seen.map((c) => c.hash), expected);
});

test('file lists match git exactly, commit by commit', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const seen = [];
  await streamHistory({ cwd: dir, mode: 'names' }, (c) => seen.push(c));

  // Oracle: ask git about each commit individually.
  for (const commit of seen) {
    const want = await gitShowNames(dir, commit.hash);
    const got = commit.files.map((f) => f.path).sort();
    assert.deepEqual(got, want, `file list for ${commit.hash.slice(0, 8)} (${commit.subject})`);
  }
});

test('a subject containing framing bytes cannot corrupt the stream', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const expected = await gitLogHashes(dir);
  const seen = [];
  await streamHistory({ cwd: dir, mode: 'names' }, (c) => seen.push(c));

  assert.deepEqual(
    seen.map((c) => c.hash),
    expected,
    'framing bytes in a subject must not shift or drop records',
  );
  const hostile = seen.find((c) => c.subject.includes('and'));
  assert.ok(hostile, 'the hostile-subject commit was still parsed');
  assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(hostile.subject), 'control bytes are neutralised');
});

test('merge and empty commits are recognised', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const seen = [];
  await streamHistory({ cwd: dir, mode: 'names' }, (c) => seen.push(c));
  const merges = seen.filter((c) => c.merge);
  const empties = seen.filter((c) => c.files.length === 0);
  assert.ok(merges.length >= 1, 'at least one merge commit');
  assert.ok(empties.length >= 2, 'at least two commits with no file changes');
  assert.ok(seen.some((c) => c.subject.includes('empty commit')));
});

test('paths with spaces and unicode survive intact', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const paths = new Set();
  await streamHistory({ cwd: dir, mode: 'names' }, (c) => {
    for (const f of c.files) paths.add(f.path);
  });
  assert.ok(paths.has('dir with space/héllo wörld.txt'), `got: ${[...paths].join(' | ')}`);
  assert.ok(paths.has('batch/file-24.txt'));
});

test('renames are detected in lines mode', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const renames = [];
  await streamHistory({ cwd: dir, mode: 'lines', renames: true }, (c) => {
    for (const f of c.files) if (f.rename) renames.push([f.oldPath, f.path]);
  });
  assert.deepEqual(renames, [['a.txt', 'renamed.txt']]);
});

test('line counts are parsed', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  await streamHistory({ cwd: dir, mode: 'lines', renames: true }, (c) => {
    if (c.subject === 'first') {
      const file = c.files.find((f) => f.path === 'a.txt');
      assert.ok(file, 'a.txt present in first commit');
      assert.equal(file.add, 3);
      assert.equal(file.del, 0);
    }
    if (c.subject === 'delete main-only') {
      const file = c.files.find((f) => f.path === 'main-only.txt');
      assert.ok(file);
      assert.equal(file.del, 1);
    }
  });
});

test('binary files are flagged', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  let sawBinary = false;
  await streamHistory({ cwd: dir, mode: 'lines', renames: true }, (c) => {
    for (const f of c.files) if (f.path === 'img.bin' && f.binary) sawBinary = true;
  });
  assert.ok(sawBinary, 'img.bin reported as binary');
});

test('shards partition the history exactly', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const expected = await gitLogHashes(dir);
  const all = [];
  const shards = [
    { skip: 0, count: 3 },
    { skip: 3, count: 3 },
    { skip: 6, count: 100 },
  ];
  for (const shard of shards) {
    await streamHistory({ cwd: dir, mode: 'names', shard }, (c) => all.push(c.hash));
  }
  assert.deepEqual([...all].sort(), [...expected].sort());
  assert.equal(new Set(all).size, all.length, 'no duplicates across shards');
});

test('maxCommits limits history', async (t) => {
  const { dir, cleanup } = await awkwardHistory();
  t.after(cleanup);

  const seen = [];
  await streamHistory({ cwd: dir, mode: 'names', maxCommits: 4 }, (c) => seen.push(c));
  assert.equal(seen.length, 4);
});
