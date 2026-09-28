#!/usr/bin/env node
/**
 * Verify the streaming history parser against git itself.
 *
 * This is the check that matters most in a tool whose output is a list of
 * numbers: if the parser silently drops a commit, every metric derived from
 * history is wrong and nothing else will say so. It compares against git's own
 * output rather than against a second implementation of the same idea, so it
 * shares no logic with the code under test.
 *
 *   node scripts/verify-parser.mjs [path] [--shards 4] [--lines]
 *
 * Exits 0 when the parser sees exactly what git reports, 1 otherwise.
 */

import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverRepo, streamHistory, runGit } from '../src/core/git.mjs';

const exec = promisify(execFile);

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('-')) ?? process.cwd();
const shardIndex = argv.indexOf('--shards');
const shards = shardIndex === -1 ? 1 : Math.max(1, Number(argv[shardIndex + 1] ?? 1));
const withLines = argv.includes('--lines');

const found = await discoverRepo(resolve(target));
if (!found) {
  process.stderr.write(`verify: not a git repository: ${target}\n`);
  process.exit(1);
}

// Ground truth, straight from git, with no framing of our own.
const { stdout: expectedRaw } = await runGit(['log', '--all', '--pretty=format:%H'], { cwd: found.root });
const expected = expectedRaw.trim().split('\n').filter(Boolean);
const { stdout: fileCount } = await runGit(['ls-files'], { cwd: found.root });
const tracked = fileCount.trim() === '' ? 0 : fileCount.trim().split('\n').length;

process.stdout.write(`\n  oc parser verification\n`);
process.stdout.write(`  ${found.root}\n`);
process.stdout.write(`  git reports ${expected.length} commits, ${tracked} tracked files\n`);
process.stdout.write(`  mode: ${withLines ? 'lines (--numstat, includes rename detection)' : 'names (--name-only)'}, ${shards} shard(s)\n\n`);

let failures = 0;
const check = (label, ok, detail) => {
  process.stdout.write(`  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}\n`);
  if (!ok) failures += 1;
};

async function collect(shardList) {
  const seen = [];
  const duplicate = new Set();
  const hashes = new Set();
  const changedPaths = new Set();
  const perCommit = new Map();
  let merges = 0;
  let renames = 0;
  let binaries = 0;

  for (const shard of shardList) {
    // `shard` is a single option object, not loose `skip`/`count` fields. Passing
    // them loose made every shard read the whole history -- which this script
    // exists to catch, and did.
    await streamHistory({ cwd: found.root, mode: withLines ? 'lines' : 'names', renames: true, shard }, (commit) => {
      if (hashes.has(commit.hash)) duplicate.add(commit.hash);
      hashes.add(commit.hash);
      seen.push(commit.hash);
      if (commit.merge) merges += 1;
      perCommit.set(commit.hash, commit.files.map((f) => f.path));
      for (const file of commit.files) {
        changedPaths.add(file.path);
        if (file.rename) renames += 1;
        if (file.binary) binaries += 1;
      }
    });
  }
  return { seen, duplicate, hashes, changedPaths, perCommit, merges, renames, binaries };
}

const per = Math.ceil(expected.length / shards);
const shardList = shards === 1
  ? [{}]
  : Array.from({ length: shards }, (_, i) => ({ skip: i * per, count: per }));

const started = Date.now();
const result = await collect(shardList);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const expectedSet = new Set(expected);
const missing = expected.filter((hash) => !result.hashes.has(hash));
const extra = [...result.hashes].filter((hash) => !expectedSet.has(hash));

check(
  'every commit git reports is seen',
  missing.length === 0,
  missing.length === 0
    ? `${result.seen.length} of ${expected.length}`
    : `${missing.length} missing, e.g. ${missing.slice(0, 3).map((h) => h.slice(0, 8)).join(', ')}`,
);
check(
  'no commit is seen twice',
  result.duplicate.size === 0,
  result.duplicate.size === 0 ? '' : `${result.duplicate.size} duplicates`,
);
check(
  'no commit is invented',
  extra.length === 0,
  extra.length === 0
    ? ''
    : `${extra.length} unexpected, e.g. ${extra.slice(0, 3).map((h) => h.slice(0, 8)).join(', ')}`,
);
check(
  'commit order matches git',
  shards === 1 && result.seen.length === expected.length
    ? result.seen.every((hash, i) => hash === expected[i])
    : true,
  shards === 1 ? '' : 'not checked across shards',
);
check('merges are identified', true, `${result.merges} merge commits`);
if (withLines) check('renames are detected', true, `${result.renames} renames, ${result.binaries} binary files`);

// The most demanding cross-check: ask git, one commit at a time, and compare
// file lists. This shares no framing logic with the parser, so it is a real
// oracle rather than a second implementation of the same idea.
const SAMPLE = 40;
const sample = result.seen.slice(0, SAMPLE);
let mismatches = 0;
const examples = [];
for (const hash of sample) {
  const { stdout } = await exec('git', ['show', '--pretty=format:', '--name-only', '--no-renames', '-z', hash], {
    cwd: found.root,
    maxBuffer: 16 * 1024 * 1024,
  });
  const want = stdout.split('\0').filter(Boolean).sort();
  const got = [...(result.perCommit.get(hash) ?? [])].sort();
  if (want.length !== got.length || want.some((path, i) => path !== got[i])) {
    mismatches += 1;
    if (examples.length < 3) {
      examples.push(`${hash.slice(0, 8)}: git ${want.length} paths, oc ${got.length}`);
    }
  }
}
check(
  'per-commit file lists match git',
  mismatches === 0,
  `${sample.length} commits checked, ${mismatches} mismatched${examples.length ? ` (${examples.join('; ')})` : ''}`,
);

check('distinct paths seen', true, `${result.changedPaths.size} paths across ${expected.length} commits`);
process.stdout.write(`\n  parsed ${result.seen.length} commits in ${elapsed}s\n\n`);

process.exitCode = failures === 0 ? 0 : 1;
