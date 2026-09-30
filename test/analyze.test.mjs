import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, write } from './helpers/fixture.mjs';
import { analyse } from '../src/cli.mjs';
import { Cache } from '../src/core/cache.mjs';
import { discoverRepo } from '../src/core/git.mjs';
import { History, toDayIndex, toMonth, authorKey } from '../src/analyze/history.mjs';
import { buildCoupling, findCycles, resolve, externalName } from '../src/analyze/coupling.mjs';
import { buildIndex, collectFiles, scanRecords } from '../src/core/workspace.mjs';
import { RISK_WEIGHTS, buildTimeline } from '../src/analyze/report.mjs';

/**
 * A repository with a known shape, so every assertion below is against a fact
 * that was constructed on purpose rather than against whatever the analyser
 * happened to produce.
 */
async function sampleRepo() {
  return makeFixture(async (git, dir) => {
    // A diamond: a -> b, a -> c, b -> d, c -> d. No cycles.
    await write(dir, 'src/a.js', [
      "import b from './b.js';",
      "import c from './c.js';",
      'export function a(x) {',
      '  if (x) { return b(x); }',
      '  return c(x);',
      '}',
    ].join('\n') + '\n');
    await write(dir, 'src/b.js', "import d from './d.js';\nexport function b(x) { return d(x); }\n");
    await write(dir, 'src/c.js', "import d from './d.js';\nexport function c(x) { return d(x); }\n");
    await write(dir, 'src/d.js', 'export function d(x) { return x * 2; }\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'diamond dependency graph']);

    // A genuine cycle: e <-> f.
    await write(dir, 'src/e.js', "import { f } from './f.js';\nexport const e = () => f();\n");
    await write(dir, 'src/f.js', "import { e } from './e.js';\nexport const f = () => e;\n");
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'introduce a cycle']);

    // A file with debt, a suppression, and heavy branching.
    const hotSource = [
      '// TODO: rewrite this',
      '// FIXME and another',
      '/* eslint-disable no-console */',
      'export function hot(a, b, c) {',
      '  if (a && b || c) { return 1; }',
      '  for (const x of [a, b, c]) { if (x) { console.log(x); } }',
      '  try { risky(); } catch (e) { if (e) { return 2; } }',
      '  return a ? b : c;',
      '}',
    ].join('\n') + '\n';
    await write(dir, 'src/hot.js', hotSource);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'add a hot messy file']);

    // A test that covers d.
    await write(dir, 'test/d.test.js', "import { d } from '../src/d.js';\nif (d(1) !== 2) { throw new Error('bad'); }\n");
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'test d']);

    // A python package, to exercise root-relative imports.
    await write(dir, 'api/svc/user.py', 'def get():\n    return 1\n');
    await write(dir, 'api/tests/test_user.py', 'from svc.user import get\n\ndef test_get():\n    assert get() == 1\n');
    await write(dir, 'requirements.txt', 'requests==2.0.0\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'python package']);

    // Repeat edits so one file accumulates churn. The edits append rather than
    // replace, because the scanner reads the working tree: a fixture that
    // overwrites the file would delete the very markers it is testing for.
    for (let i = 0; i < 5; i += 1) {
      await write(dir, 'src/hot.js', `${hotSource}\n// revision ${i}\nexport const v${i} = ${i};\n`);
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', `rework hot ${i}`]);
    }

    // A file nobody touches again, to create a stale/orphan case.
    await write(dir, 'src/legacy.js', 'export const legacy = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'legacy']);
  });
}

async function analyseFixture(dir) {
  const found = await discoverRepo(dir);
  assert.ok(found, 'fixture must be a repository');
  return analyse({ found, head: { hash: 'fixture' }, options: { top: 50 }, cache: new Cache({ enabled: false }) });
}

test('the import graph resolves relative specifiers', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const a = report.signals.find((s) => s.record.rel === 'src/a.js');
  assert.ok(a, 'src/a.js was analysed');
  assert.equal(a.fanOut, 2, 'a imports b and c');
  assert.equal(a.fanIn, 0);

  const d = report.signals.find((s) => s.record.rel === 'src/d.js');
  assert.equal(d.fanIn, 3, 'd is imported by b, c, and the test that covers it');
  assert.equal(d.fanOut, 0);
});

test('import cycles are found, and only real ones', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const cycles = report.coupling.cycles;
  assert.equal(cycles.length, 1, `expected exactly one cycle, got ${JSON.stringify(cycles)}`);
  const members = cycles[0].slice().sort();
  assert.deepEqual(members, ['src/e.js', 'src/f.js']);
  assert.equal(report.coupling.cycleFileCount, 2);

  // The diamond must not be reported as a cycle.
  const inCycle = report.signals.filter((s) => s.inCycle).map((s) => s.record.rel).sort();
  assert.deepEqual(inCycle, ['src/e.js', 'src/f.js']);
});

test('python root-relative imports resolve', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const testFile = report.signals.find((s) => s.record.rel === 'api/tests/test_user.py');
  assert.ok(testFile, 'the python test was analysed');
  assert.equal(testFile.fanOut, 1, 'the test imports svc.user');

  const user = report.signals.find((s) => s.record.rel === 'api/svc/user.py');
  assert.equal(user.fanIn, 1, 'svc/user.py is reached by the test');
});

test('test reach is measured by real imports, not by guessing', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const covered = report.signals.filter((s) => s.isTested).map((s) => s.record.rel).sort();
  assert.ok(covered.includes('src/d.js'), `d.js has a test: ${covered.join(', ')}`);
  assert.ok(covered.includes('api/svc/user.py'), `user.py has a test: ${covered.join(', ')}`);
  assert.ok(!covered.includes('src/a.js'), 'nothing imports a.js, so nothing tests it');
  assert.ok(report.tests.covered >= 2);
  assert.ok(report.tests.ratio > 0 && report.tests.ratio < 1);
});

test('debt markers and suppressions are attributed to their file', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const byType = Object.fromEntries(report.debt.byType.map((d) => [d.marker, d.count]));
  assert.equal(byType.TODO, 1);
  assert.equal(byType.FIXME, 1);
  assert.ok(report.debt.suppressed >= 1, 'the eslint-disable was counted');

  const hot = report.signals.find((s) => s.record.rel === 'src/hot.js');
  assert.equal(hot.debt, 2);
  assert.equal(hot.suppressed, 1);
  assert.ok(hot.complexity > 4, `branching file should score high, got ${hot.complexity}`);
});

test('the file with the most churn and branching ranks as the hottest', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  assert.equal(report.hotspots[0].record.rel, 'src/hot.js',
    `hottest was ${report.hotspots[0]?.record.rel}`);
  const top = report.hotspots[0];
  assert.ok(top.reasons.length > 0, 'the score is explained');
  assert.ok(top.reasons.some((r) => r.key === 'churn'), 'churn is among the reasons');
  assert.ok(top.reasons.some((r) => r.key === 'complexity'), 'complexity is among the reasons');

  // Reasons must be ordered and account for the score.
  for (let i = 1; i < top.reasons.length; i += 1) {
    assert.ok(top.reasons[i - 1].contribution >= top.reasons[i].contribution);
  }
});

test('risk weights are a probability distribution', () => {
  const total = Object.values(RISK_WEIGHTS).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}, expected 1`);
  for (const [key, weight] of Object.entries(RISK_WEIGHTS)) {
    assert.ok(weight > 0, `${key} has a positive weight`);
  }
});

test('every risk score equals the sum of its weighted parts', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  for (const signal of report.signals) {
    let sum = 0;
    for (const [key, weight] of Object.entries(RISK_WEIGHTS)) {
      sum += (signal.parts[key] ?? 0) * weight * 100;
    }
    assert.ok(Math.abs(signal.risk - Math.min(100, sum)) < 1e-6,
      `${signal.record.rel}: risk ${signal.risk} vs parts ${sum}`);
  }
});

test('ownership and bus factor are computed from real history', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  assert.ok(report.history.commits >= 10, `saw ${report.history.commits} commits`);
  assert.equal(report.ownership.total, 1, 'the fixture has a single author');
  assert.equal(report.ownership.busFactor, 1);
  assert.equal(report.ownership.authors[0].commits, report.history.commits);
});

test('the language breakdown adds up', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  const code = report.languages.reduce((sum, l) => sum + l.code, 0);
  assert.equal(code, report.totals.code);
  const files = report.languages.reduce((sum, l) => sum + l.files, 0);
  assert.equal(files, report.totals.files);
  assert.ok(report.languages.some((l) => l.name === 'JavaScript'));
  assert.ok(report.languages.some((l) => l.name === 'Python'));
  // Test files are counted separately from source files.
  assert.ok(report.totals.testFiles >= 2);
});

test('the health index is in range and every component is explained', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  assert.ok(report.health.value >= 0 && report.health.value <= 100);
  assert.ok(['A', 'B', 'C', 'D', 'E'].includes(report.health.grade));
  assert.equal(report.health.components.length, 7);
  for (const component of report.health.components) {
    assert.ok(component.value >= 0 && component.value <= 100, `${component.key} out of range`);
    assert.ok(component.detail && component.detail.length > 0, `${component.key} has no explanation`);
  }
});

test('the timeline has one bucket per month with no gaps', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const report = await analyseFixture(dir);

  assert.equal(report.timeline.months.length, 26);
  for (let i = 1; i < report.timeline.months.length; i += 1) {
    const previous = report.timeline.months[i - 1].month;
    const current = report.timeline.months[i].month;
    const [py, pm] = previous.split('-').map(Number);
    const [cy, cm] = current.split('-').map(Number);
    assert.equal(cy * 12 + cm, py * 12 + pm + 1, `${previous} -> ${current} must be consecutive`);
  }
  const total = report.timeline.months.reduce((sum, m) => sum + m.commits, 0);
  assert.equal(total, report.history.commits, 'every commit lands in exactly one month');
});

test('analysis is deterministic: two runs produce identical reports', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);
  const first = await analyseFixture(dir);
  const second = await analyseFixture(dir);
  const strip = (report) => JSON.stringify({
    health: report.health,
    hotspots: report.hotspots.map((s) => [s.record.rel, Math.round(s.risk)]),
    cycles: report.coupling.cycles,
    tests: report.tests,
  });
  assert.equal(strip(first), strip(second));
});

test('the scan is identical with and without a warm cache', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);

  const cold = new Cache({ enabled: false });
  const found = await discoverRepo(dir);
  const coldReport = await analyse({ found, head: { hash: 'x' }, options: {}, cache: cold });

  // Second run with a writable cache: same repository, same answers.
  const warm = new Cache({ enabled: true, dir: undefined, version: 'test-fp', fingerprint: 'fp' });
  await warm.flush();
  const warmReport = await analyse({ found, head: { hash: 'x' }, options: {}, cache: warm });
  const warmReport2 = await analyse({ found, head: { hash: 'x' }, options: {}, cache: warm });

  const shape = (report) => JSON.stringify(
    report.signals
      .map((s) => [s.record.rel, s.code, s.comment, s.blank, s.complexity, s.funcs, s.debt, s.fanIn])
      .sort(),
  );
  assert.equal(shape(coldReport), shape(warmReport), 'a cached run matches a cold one');
  assert.equal(shape(warmReport), shape(warmReport2), 'a cached run is stable');
  assert.ok(warm.stats().hitRate > 0, 'the second run actually hit the cache');
});

test('changing a file invalidates only that file in the cache', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);

  const cache = new Cache({ enabled: true, version: 'test-fp', fingerprint: 'fp' });
  const { records } = await collectFiles({ root: dir });
  await scanRecords({ records, cache });
  const first = cache.stats();
  assert.equal(first.misses, records.length);

  const second = new Cache({ enabled: true, version: 'test-fp', fingerprint: 'fp' });
  const { records: again } = await collectFiles({ root: dir });
  await scanRecords({ records: again, cache: second });
  const hits = second.stats();
  assert.equal(hits.misses, 0, 'everything was served from the cache');
  assert.equal(hits.hits, records.length);

  // Touch one file, and exactly one file is re-measured. A whole millisecond
  // forward: `utimes` is specified to millisecond precision, so anything finer
  // would silently become a no-op on some filesystems and pass for the wrong
  // reason.
  const { stat, utimes } = await import('node:fs/promises');
  const target = `${dir}/src/b.js`;
  const info = await stat(target, { bigint: true });
  const bumped = new Date(Number(info.mtimeNs / 1000000n) + 1);
  await utimes(target, bumped, bumped);
  const third = new Cache({ enabled: true, version: 'test-fp', fingerprint: 'fp' });
  const { records: thirdRecords } = await collectFiles({ root: dir });
  await scanRecords({ records: thirdRecords, cache: third });
  assert.equal(third.stats().misses, 1, 'exactly one file was re-measured');
});

test('a different measurement fingerprint invalidates every entry', async (t) => {
  const { dir, cleanup } = await sampleRepo();
  t.after(cleanup);

  const a = new Cache({ enabled: true, version: 'v1', fingerprint: 'hash-of-scanner-A' });
  const { records } = await collectFiles({ root: dir });
  await scanRecords({ records, cache: a });

  const b = new Cache({ enabled: true, version: 'v1', fingerprint: 'hash-of-scanner-B' });
  const { records: again } = await collectFiles({ root: dir });
  await scanRecords({ records: again, cache: b });
  assert.equal(b.stats().hits, 0, 'changed measurement code means nothing is reusable');
});

// ---------------------------------------------------------------------------
// Unit-level checks
// ---------------------------------------------------------------------------

test('date helpers', () => {
  assert.equal(toDayIndex('2026-01-01'), Math.floor(Date.parse('2026-01-01T00:00:00Z') / 86400000));
  assert.equal(toDayIndex('nonsense'), 0);
  assert.equal(toMonth('2026-03-15'), '2026-03');
  assert.equal(toMonth('x'), 'unknown');
});

test('author identity prefers email and handles github no-reply', () => {
  assert.equal(authorKey('Jane', 'Jane@Example.COM'), 'jane@example.com');
  assert.equal(authorKey('Jane', '1234+Jane@users.noreply.github.com'), '1234+jane@users.noreply.github.com');
  assert.equal(authorKey('Root', ''), 'name:root');
  assert.equal(authorKey('', ''), 'unknown');
});

test('import resolution rules', () => {
  const index = buildIndex([
    { rel: 'src/b.js' }, { rel: 'src/nested/deep.js' }, { rel: 'api/svc/user.py' },
  ]);
  assert.equal(resolve('./b.js', 'src/a.js', index), 'src/b.js');
  assert.equal(resolve('./b', 'src/a.js', index), 'src/b.js', 'extension is probed');
  assert.equal(resolve('../src/b.js', 'src/a.js', index), 'src/b.js');
  assert.equal(resolve('svc.user', 'api/tests/test_user.py', index), 'api/svc/user.py',
    'python resolves from the package root, walking up from the importer');
  assert.equal(resolve('some-unlisted-package', 'src/a.js', index), null);
});

test('external specifiers reduce to package names', () => {
  assert.equal(externalName('react'), 'react');
  assert.equal(externalName('@scope/pkg/deep/path'), '@scope/pkg');
  assert.equal(externalName('lodash/fp'), 'lodash');
  assert.equal(externalName('package:flutter/material.dart'), 'flutter');
  assert.equal(externalName(''), null);
});

test('cycle detection on a hand-built graph', () => {
  const edges = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
    ['c', new Set(['d'])],
    ['d', new Set(['c', 'e'])],
    ['e', new Set(['f'])],
    ['f', new Set(['c'])],
  ]);
  const index = buildIndex(['a', 'b', 'c', 'd', 'e', 'f'].map((rel) => ({ rel })));
  const cycles = findCycles(edges, index);
  assert.equal(cycles.length, 2);
  // c -> d -> e -> f -> c, so all four belong to one component, not two.
  const sizes = cycles.map((c) => c.length).sort();
  assert.deepEqual(sizes, [2, 4]);
});

test('history aggregates only, never the commit list', () => {
  const history = new History({ now: 20000, includeLines: true });
  for (let i = 0; i < 100; i += 1) {
    history.add({
      hash: `h${i}`, author: 'A', email: 'a@x.com', date: '2026-05-01',
      merge: false, subject: 's', files: [{ path: 'f.ts', add: 1, del: 0, binary: false, rename: false }],
    });
  }
  assert.equal(history.commits, 100);
  assert.equal(history.files.get('f.ts').commits, 100);
  assert.equal(history.files.get('f.ts').adds, 100);
  assert.equal(history.adds, 100);
  assert.equal(Object.keys(history).includes('commits_list'), false, 'no unbounded list is retained');
});

test('line totals are only accumulated in line mode', () => {
  const commit = {
    hash: 'h', author: 'A', email: 'a@x.com', date: '2026-05-01',
    merge: false, subject: 's',
    files: [{ path: 'f.ts', add: 7, del: 3, binary: false, rename: false }],
  };
  const off = new History();
  off.add(commit);
  assert.equal(off.adds, 0, 'names mode does not pay for line diffs');

  const on = new History({ includeLines: true });
  on.add(commit);
  assert.equal(on.adds, 7);
  assert.equal(on.dels, 3);
  assert.equal(on.files.get('f.ts').adds, 7);
});

test('merge commits are counted separately and contribute no churn', () => {
  const history = new History();
  history.add({ hash: 'm', author: 'A', email: 'a@x.com', date: '2026-01-01', merge: true, subject: 'merge', files: [] });
  assert.equal(history.commits, 1);
  assert.equal(history.merges, 1);
  assert.equal(history.emptyCommits, 1);
  assert.equal(history.adds, 0);
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

test('the cache fingerprint is derived from the real measurement code', async () => {
  const { fingerprintSources, measurementFingerprint } = await import('../src/core/cache.mjs');
  const { fingerprint, sources } = await fingerprintSources(true);
  assert.ok(fingerprint.length > 0);

  // The modules that define what a measurement *means* must actually be read.
  // A wrong path here silently yields a constant fingerprint, and then no cache
  // entry is ever invalidated no matter how the scanner changes.
  for (const source of sources) {
    assert.equal(source.found, true, `${source.file} was not found; the fingerprint would be frozen`);
    assert.ok(source.bytes > 1000, `${source.file} is only ${source.bytes} bytes, which is not a real source file`);
  }
  const names = sources.map((s) => s.file).sort();
  assert.deepEqual(names, ['lang.mjs', 'scan.mjs']);
  void measurementFingerprint;
});

test('a fingerprint that cannot read its inputs fails loudly', async () => {
  const { fingerprintSources } = await import('../src/core/cache.mjs');
  const { sources } = await fingerprintSources(true);
  assert.equal(sources.filter((s) => !s.found).length, 0,
    'every measurement module must be readable from src/core/');
});

test('excluded paths are skipped and accounted for, not silently dropped', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'src/a.js', 'export const a = 1;\n');
    await write(d, 'node_modules/pkg/index.js', 'export const p = 1;\n');
    // `public/vs` is the shape used by projects that copy a third-party editor
    // (Monaco and friends) into a static directory: it is not under a directory
    // name oc recognises, which is exactly why --exclude has to exist.
    await write(d, 'web/public/vs/language/js.js', 'export const v = 1;\n');
    await write(d, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t.after(cleanup);

  const base = await collectFiles({ root: dir });
  assert.equal(base.total, 4, 'every tracked path is accounted for');
  assert.equal(base.records.length, 2, 'our source and the unrecognised vendored copy');
  assert.equal(base.skipped.vendor, 1, 'node_modules is skipped');
  assert.equal(base.skipped.binary, 1, 'the png is skipped');

  const excluded = await collectFiles({ root: dir, exclude: ['/public/'] });
  assert.equal(excluded.records.length, 1, 'the excluded path is gone');
  assert.equal(excluded.skipped.excluded, 1, 'and it is reported as excluded');
  assert.equal(excluded.total, 4, 'the denominator is unchanged');

  // Every path lands in exactly one bucket: analysed, or skipped with a reason.
  const skippedTotal = Object.values(excluded.skipped).reduce((a, b) => a + b, 0);
  assert.equal(excluded.records.length + skippedTotal, excluded.total,
    'nothing is dropped without a reason');
});

test('a directory literally named vendor is treated as vendored', async (t) => {
  // Deliberate. `vendor/` is where cargo, composer and bundlers put third-party
  // code, so the rule matches the name wherever it appears. A project that keeps
  // its own code there can say so with --include-vendor, and the footer always
  // reports how many files were dropped as vendored.
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'vendor/ours/thing.js', 'export const t = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t.after(cleanup);

  const skipped = await collectFiles({ root: dir });
  assert.equal(skipped.records.length, 0);
  assert.equal(skipped.skipped.vendor, 1);

  const kept = await collectFiles({ root: dir, includeVendor: true });
  assert.equal(kept.records.length, 1, '--include-vendor overrides it');
});

test('an exclusion outranks the built-in vendor rule', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'node_modules/pkg/index.js', 'export const p = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t.after(cleanup);

  const kept = await collectFiles({ root: dir, includeVendor: true, exclude: [] });
  assert.equal(kept.records.length, 1, '--include-vendor keeps it');

  const dropped = await collectFiles({ root: dir, includeVendor: true, exclude: ['node_modules'] });
  assert.equal(dropped.records.length, 0);
  assert.equal(dropped.skipped.excluded, 1, 'reported as user-excluded, not as vendor');
  assert.equal(dropped.skipped.vendor, 0);
});

test('cache identity distinguishes edits that share a millisecond', () => {
  // The bug CI caught on macOS. Rounding `mtimeMs` to an integer collapses
  // sub-millisecond differences, so two saves inside one millisecond could
  // share a cache key and be served a stale analysis. Cache identity is a pure
  // function of its inputs, so it is tested directly rather than through a
  // filesystem whose timestamp granularity varies by platform.
  const cache = new Cache({ enabled: false });
  const withinOneMillisecond = [
    '1790682006505000114', // 1790682006505.000114 ms
    '1790682006505000999', // 1790682006505.000999 ms
    '1790682006505999999', // 1790682006505.999999 ms
  ];
  const keys = new Set(withinOneMillisecond.map((mtime) => cache.keyFor('a.js', 100, mtime)));
  assert.equal(keys.size, withinOneMillisecond.length,
    'every distinct modification time gets its own key');

  // Rounded to whole milliseconds these would have collapsed to two values, and
  // the first and third would have been indistinguishable.
  const rounded = new Set(withinOneMillisecond.map((m) => String(Math.round(Number(BigInt(m) / 1000n)))));
  assert.ok(rounded.size < withinOneMillisecond.length,
    'which is exactly what the old rounding-based key lost');

  // Identity must be stable, and must still depend on every input.
  assert.equal(cache.keyFor('a.js', 100, 'x'), cache.keyFor('a.js', 100, 'x'));
  assert.notEqual(cache.keyFor('a.js', 100, 'x'), cache.keyFor('a.js', 101, 'x'), 'size matters');
  assert.notEqual(cache.keyFor('a.js', 100, 'x'), cache.keyFor('b.js', 100, 'x'), 'path matters');
});

test('the fingerprint still invalidates everything it used to', () => {
  // Re-asserted after the key change, because the two interact: a key that
  // forgot the fingerprint would make every measurement-code change invisible.
  const a = new Cache({ enabled: false, version: 'v1', fingerprint: 'scanner-A' });
  const b = new Cache({ enabled: false, version: 'v1', fingerprint: 'scanner-B' });
  assert.notEqual(a.keyFor('x', 1, '2'), b.keyFor('x', 1, '2'));
  const c = new Cache({ enabled: false, version: 'v2', fingerprint: 'scanner-A' });
  assert.notEqual(a.keyFor('x', 1, '2'), c.keyFor('x', 1, '2'));
});

test('the timeline window ends on the local calendar month, not the UTC one', () => {
  // Regression: the window used to be derived from `Math.floor(Date.now() /
  // MS_PER_DAY)` plus getUTC*(). Commit months come from git's YYYY-MM-DD,
  // which git renders in local time. At 00:30 on 1 October in UTC+8 the two
  // disagreed by a month, and every commit made that morning fell one month
  // past the end of the window -- so the timeline silently showed 0 commits
  // while the repo clearly had some. See 191ceba.
  //
  // This asserts the invariant directly, without depending on what day the
  // suite happens to run: whatever "now" is, the window's last bucket must be
  // the current local month, and a commit dated in that month must land inside.
  const now = new Date();
  const localMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const localDayIndex = Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000,
  );
  const utcDayIndex = Math.floor(Date.now() / 86_400_000);

  const history = {
    months: new Map([[localMonth, {
      commits: 11, merges: 0, authors: new Set(), fileCount: 0, adds: 0, dels: 0,
    }]]),
  };

  const t = buildTimeline(history, localDayIndex);
  assert.equal(t.months.at(-1).month, localMonth,
    'the newest bucket must be the current local month');
  assert.equal(t.months.reduce((sum, m) => sum + m.commits, 0), 11,
    'a commit dated this local month must not fall outside the window');

  // `buildTimeline` now reads `today` as a local-calendar day. During the first
  // hours of a month in some timezone the UTC day index is yesterday, and
  // feeding that in must not quietly claim this month -- it would mean the
  // window had drifted the other way. (Before the fix this direction was
  // untested; only the "commits vanish" direction showed up.)
  if (utcDayIndex !== localDayIndex) {
    const stale = buildTimeline(history, utcDayIndex);
    assert.notEqual(stale.months.at(-1).month, localMonth,
      'yesterday\'s day index must not be read as the current month');
  }
});

test('the timeline window is consecutive and covers the requested span', () => {
  const t = buildTimeline({ months: new Map() }, Math.floor(Date.now() / 86_400_000), 12);
  assert.equal(t.months.length, 12);
  for (let i = 1; i < t.months.length; i += 1) {
    const [py, pm] = t.months[i - 1].month.split('-').map(Number);
    const [cy, cm] = t.months[i].month.split('-').map(Number);
    assert.equal(cy * 12 + cm, py * 12 + pm + 1, `${t.months[i - 1].month} -> ${t.months[i].month}`);
  }
  assert.ok(t.months.every((m) => m.commits === 0), 'an empty history yields an empty series');
});
