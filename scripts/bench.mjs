#!/usr/bin/env node
/**
 * Benchmark.
 *
 * Reports where the time actually goes rather than a single total, because a
 * tool that reads a 13k-file repository has two very different costs: reading
 * and measuring files, and asking git for history. Only the second one can grow
 * without bound, and knowing which one dominates tells you what to optimise.
 *
 *   node scripts/bench.mjs [path] [--repeat 2]
 */

import { resolve } from 'node:path';
import { discoverRepo, repoHead, commitCount, trackedFiles } from '../src/core/git.mjs';
import { collectFiles, scanRecords, buildIndex } from '../src/core/workspace.mjs';
import { Cache } from '../src/core/cache.mjs';
import { History } from '../src/analyze/history.mjs';
import { buildCoupling } from '../src/analyze/coupling.mjs';
import { buildReport } from '../src/analyze/report.mjs';
import { streamHistory } from '../src/core/git.mjs';
import { defaultConcurrency } from '../src/core/pool.mjs';
import { measurementFingerprint } from '../src/core/cache.mjs';
import { formatMs, formatBytes, formatCount, formatInt } from '../src/render/widgets.mjs';

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('-')) ?? process.cwd();
const repeatIndex = argv.indexOf('--repeat');
const repeats = repeatIndex === -1 ? 1 : Number(argv[repeatIndex + 1] ?? 1);

const found = await discoverRepo(resolve(target));
if (!found) {
  process.stderr.write(`bench: not a git repository: ${target}\n`);
  process.exit(1);
}

const head = await repoHead(found.root);
const totalCommits = await commitCount(found.root);
const tracked = await trackedFiles(found.root);
const fingerprint = await measurementFingerprint();

process.stdout.write(`\n  oc benchmark\n`);
process.stdout.write(`  ${found.root}\n`);
process.stdout.write(`  ${formatCount(tracked.length)} tracked files, ${formatInt(totalCommits)} commits, branch ${head.branch}\n\n`);

const columns = ['phase', 'cold', 'warm', 'notes'];
const rows = [];
const note = (name, cold, warm, extra) => rows.push([name, cold, warm, extra]);

const time = async (fn) => {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
};

let coldTotal = 0;
let warmTotal = 0;

for (let run = 0; run < repeats; run += 1) {
  const isCold = run === 0;
  // A cold run uses a throwaway cache so it measures real work, not a cache hit.
  const cache = new Cache({
    enabled: true,
    version: 'bench',
    fingerprint,
    dir: isCold ? undefined : undefined,
  });
  if (isCold) cache.enabled = true;

  const t0 = await time(() => collectFiles({ root: found.root }));
  const t1 = await time(() => scanRecords({ records: t0.value.records, cache, concurrency: defaultConcurrency() }));
  const index = buildIndex(t1.value ? t0.value.records : []);

  const history = new History({});
  const t2 = await time(async () => {
    await streamHistory({ cwd: found.root, mode: 'names' }, (commit) => history.add(commit));
  });

  const t3 = await time(() => buildCoupling({ records: t0.value.records, index, root: found.root }));
  history.finalize(new Set(t0.value.records.map((r) => r.rel)));
  const t4 = await time(() => buildReport({ records: t0.value.records, history, coupling: t3.value }));

  if (isCold) {
    const bytes = t0.value.records.reduce((sum, r) => sum + r.size, 0);
    note('collect', formatMs(t0.ms), '', `${formatCount(t0.value.records.length)} files, ${formatBytes(bytes)}`);
    note('scan', formatMs(t1.ms), '', `${t1.value.hits} cache hits, ${t1.value.scanned} measured, ${defaultConcurrency()} workers`);
    note('history', formatMs(t2.ms), '', `${formatCount(history.commits)} commits, ${formatCount(history.files.size)} paths`);
    note('coupling', formatMs(t3.ms), '', `${formatCount(t3.value.edges.size)} importers, ${t3.value.cycles.length} cycles`);
    note('analyse', formatMs(t4.ms), '', `health ${t4.value.health.grade} ${t4.value.health.value}`);
    coldTotal = t0.ms + t1.ms + t2.ms + t3.ms + t4.ms;
    note('TOTAL', formatMs(coldTotal), '', '');
  } else {
    const warm = t0.ms + t1.ms + t2.ms + t3.ms + t4.ms;
    warmTotal = warm;
    note('TOTAL', '', formatMs(warm), '');
  }
  process.stdout.write(`  run ${run + 1}/${repeats} done (rss ${formatBytes(process.memoryUsage().rss)})\n`);
}

const pad = (value, size) => String(value ?? '').padEnd(size);
const size = Math.max(...columns.map((c) => c.length), ...rows.map((r) => r[0].length));
const w1 = Math.max(...columns.slice(1).map((c) => c.length), ...rows.map((r) => r[1].length)) + 2;
const w2 = Math.max(...columns.slice(2).map((c) => c.length), ...rows.map((r) => r[2].length)) + 2;

process.stdout.write(`\n  ${pad(columns[0], size)}${pad(columns[1], w1)}${pad(columns[2], w2)}${columns[3]}\n`);
process.stdout.write(`  ${'-'.repeat(size + w1 + w2 + 20)}\n`);
for (const row of rows) {
  process.stdout.write(`  ${pad(row[0], size)}${pad(row[1], w1)}${pad(row[2], w2)}${row[3] ?? ''}\n`);
}
process.stdout.write('\n');
