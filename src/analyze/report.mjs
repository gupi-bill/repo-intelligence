/**
 * Report assembly.
 *
 * Turns the raw ingredients -- file shapes, history aggregates, coupling graph --
 * into the numbers and rankings the renderers display.
 *
 * Two principles hold throughout:
 *
 *  1. Every score is explainable. A file's risk is a sum of named, individually
 *     visible contributions, not an opaque number. If oc says a file is
 *     dangerous, the report can always say which three facts made it dangerous.
 *  2. Normalisation is logarithmic and relative to this repository. There is no
 *     global threshold table, because "200 lines" means something completely
 *     different in a config file and in a protocol parser.
 */

import { History, toDayIndex, toMonth, authorKey, recencyBucket } from './history.mjs';

const MS_PER_DAY = 86_400_000;

/** Risk weights. They sum to 1 and are asserted in tests so they stay honest. */
export const RISK_WEIGHTS = {
  churn: 0.20,
  complexity: 0.22,
  size: 0.10,
  debt: 0.12,
  ownership: 0.10,
  blastRadius: 0.10,
  untested: 0.10,
  suppression: 0.06,
};

/** Log-scaled normalisation against the repository maximum. */
function normalize(value, max) {
  if (!max || value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(max));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index];
}

/**
 * @param {object} opts
 * @param {object[]} opts.records
 * @param {History} opts.history
 * @param {object} opts.coupling
 * @param {number} [opts.now] day index, injectable for deterministic tests
 * @param {number} [opts.limit] rows per section
 * @returns {object} report
 */
export function buildReport({ records, history, coupling, now, limit = 20 }) {
  const today = now ?? Math.floor(Date.now() / MS_PER_DAY);
  const index = new Map(records.map((r) => [r.rel, r]));

  // Files that participate in at least one import cycle. Local, never module
  // state: a report must be a pure function of its inputs so that two runs over
  // the same tree always produce byte-identical output.
  const cyclicFiles = new Set();
  for (const component of coupling.cycles) {
    for (const path of component) cyclicFiles.add(path);
  }

  // ---------------------------------------------------------------- files ---
  const files = [];
  for (const record of records) {
    const shape = record.shape;
    if (!shape || shape.skip) continue;
    files.push({ record, shape });
  }

  const sourceFiles = files.filter(({ record, shape }) => !record.test && !record.vendor);
  const testFiles = files.filter(({ record }) => record.test);

  // ------------------------------------------------------- language totals ---
  const languages = new Map();
  for (const { record, shape } of files) {
    const name = shape.language ?? 'Other';
    let lang = languages.get(name);
    if (!lang) {
      lang = { name, files: 0, code: 0, comment: 0, blank: 0, total: 0, testFiles: 0, sourceFiles: 0, decisions: 0, bytes: 0, debt: 0 };
      languages.set(name, lang);
    }
    lang.files += 1;
    if (record.test) lang.testFiles += 1;
    else lang.sourceFiles += 1;
    lang.code += shape.code ?? 0;
    lang.comment += shape.comment ?? 0;
    lang.blank += shape.blank ?? 0;
    lang.total += shape.total ?? 0;
    lang.decisions += shape.decisions ?? 0;
    lang.bytes += shape.bytes ?? 0;
    lang.debt += shape.debt?.length ?? 0;
  }
  const languageList = [...languages.values()].sort((a, b) => b.code - a.code);

  const totals = {
    files: files.length,
    sourceFiles: sourceFiles.length,
    testFiles: testFiles.length,
    code: 0,
    comment: 0,
    blank: 0,
    lines: 0,
    bytes: 0,
    decisions: 0,
    debt: 0,
    suppressed: 0,
  };
  for (const { shape } of files) {
    totals.code += shape.code ?? 0;
    totals.comment += shape.comment ?? 0;
    totals.blank += shape.blank ?? 0;
    totals.lines += shape.total ?? 0;
    totals.bytes += shape.bytes ?? 0;
    totals.decisions += shape.decisions ?? 0;
    totals.debt += shape.debt?.length ?? 0;
    totals.suppressed += shape.suppressed ?? 0;
  }

  // ------------------------------------------------------------- testing ---
  // "Which source file is exercised by a test?" is answered by pointing the
  // coupling graph backwards: if no test file imports a source file, and the
  // file is not itself named like a test, it has no direct test.
  const importers = coupling.edges;
  const tested = new Set();
  for (const [from, tos] of importers) {
    const fromRecord = index.get(from);
    if (!fromRecord?.test) continue;
    for (const to of tos) {
      if (!to.startsWith('ext:')) tested.add(to);
    }
  }
  // Naming a file `foo.test.ts` also covers `foo.ts` directly.
  for (const { record } of testFiles) {
    const base = record.rel
      .replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '')
      .replace(/[/\\](tests?|__tests__)[/\\]/i, '/')
      .replace(/\/(test|tests)_/i, '/')
      .replace(/_test\.[a-z]+$/i, '')
      .replace(/\/test\.[a-z]+$/i, '');
    if (index.has(base)) tested.add(base);
  }

  const testCoverage = {
    sourceFiles: sourceFiles.length,
    covered: 0,
    ratio: 0,
    byDirectory: [],
  };
  for (const { record } of sourceFiles) {
    if (tested.has(record.rel)) testCoverage.covered += 1;
  }
  testCoverage.ratio = sourceFiles.length === 0 ? 0 : testCoverage.covered / sourceFiles.length;

  const dirStats = new Map();
  for (const { record, shape } of files) {
    const dir = topDirs(record.rel, 2);
    let entry = dirStats.get(dir);
    if (!entry) {
      entry = { dir, source: 0, tests: 0, covered: 0, code: 0 };
      dirStats.set(dir, entry);
    }
    if (record.test) entry.tests += 1;
    else {
      entry.source += 1;
      entry.code += shape.code ?? 0;
      if (tested.has(record.rel)) entry.covered += 1;
    }
  }
  testCoverage.byDirectory = [...dirStats.values()]
    .filter((d) => d.source > 0)
    .map((d) => ({ ...d, ratio: d.source === 0 ? 0 : d.covered / d.source, codePerTest: d.tests === 0 ? null : d.code / d.tests }))
    .sort((a, b) => a.ratio - b.ratio || b.code - a.code);

  // --------------------------------------------------------------- risk ----
  // Pass 1: raw signals, so each can be normalised against the repo maximum.
  const signals = [];
  for (const { record, shape } of files) {
    const hist = history.files.get(record.rel);
    const commits = hist?.commits ?? 0;
    const funcs = Math.max(1, shape.funcs ?? 0);
    const complexity = shape.complexity ?? 0;
    const perFunction = complexity / funcs;
    const authors = hist ? hist.authors.size : 0;
    let ownershipRisk = 0;
    if (hist && commits > 0) {
      // Herfindahl concentration: 1.0 means one person wrote every line of
      // history for this file. That is the definition of a bus-factor-1 file.
      let hhi = 0;
      for (const count of hist.authors.values()) hhi += (count / commits) ** 2;
      ownershipRisk = hhi;
    }
    const daysSince = hist && hist.lastDay > 0 ? today - hist.lastDay : null;
    signals.push({
      record,
      shape,
      commits,
      complexity,
      perFunction,
      funcs,
      code: shape.code ?? 0,
      debt: shape.debt?.length ?? 0,
      debtWeight: (shape.debt ?? []).reduce((sum, d) => sum + d.weight, 0),
      suppressed: shape.suppressed ?? 0,
      ownershipRisk,
      authors,
      fanIn: coupling.fanIn.get(record.rel) ?? 0,
      fanOut: coupling.fanOut.get(record.rel) ?? 0,
      isTest: record.test,
      isGenerated: record.generated,
      isTested: tested.has(record.rel),
      daysSince,
      lastDay: hist?.lastDay ?? 0,
      firstDay: hist?.firstDay ?? 0,
      lastAuthor: hist?.lastAuthor ?? null,
      inCycle: cyclicFiles.has(record.rel),
    });
  }

  const maxes = {
    commits: 0,
    complexity: 0,
    perFunction: 0,
    code: 0,
    debtWeight: 0,
    suppressed: 0,
    fanIn: 0,
  };
  for (const s of signals) {
    maxes.commits = Math.max(maxes.commits, s.commits);
    maxes.complexity = Math.max(maxes.complexity, s.complexity);
    maxes.perFunction = Math.max(maxes.perFunction, s.perFunction);
    maxes.code = Math.max(maxes.code, s.code);
    maxes.debtWeight = Math.max(maxes.debtWeight, s.debtWeight);
    maxes.suppressed = Math.max(maxes.suppressed, s.suppressed);
    maxes.fanIn = Math.max(maxes.fanIn, s.fanIn);
  }

  for (const s of signals) {
    const parts = {
      churn: normalize(s.commits, maxes.commits),
      complexity: 0.5 * normalize(s.complexity, maxes.complexity) + 0.5 * normalize(s.perFunction, maxes.perFunction),
      size: normalize(s.code, maxes.code),
      debt: normalize(s.debtWeight, maxes.debtWeight),
      ownership: s.commits > 0 ? s.ownershipRisk : 0,
      blastRadius: normalize(s.fanIn, maxes.fanIn),
      untested: 0,
      suppression: normalize(s.suppressed, maxes.suppressed),
    };
    // A generated or test file is not "untested" for risk purposes, and neither
    // is a file nobody has ever touched (it cannot be a hot spot).
    if (!s.isTest && !s.isGenerated && !s.isTested) parts.untested = s.commits > 0 ? 1 : 0.35;

    let score = 0;
    const reasons = [];
    for (const [key, weight] of Object.entries(RISK_WEIGHTS)) {
      const contribution = parts[key] * weight * 100;
      score += contribution;
      if (contribution >= 3) reasons.push({ key, contribution });
    }
    s.parts = parts;
    s.risk = Math.min(100, score);
    s.reasons = reasons.sort((a, b) => b.contribution - a.contribution);
  }

  // Generated and test code is reported but never promoted into the hot list;
  // mixing vendored or fixture files into "most dangerous files" is noise.
  const rankable = signals.filter((s) => !s.record.test && !s.record.generated && s.shape.code > 0);
  const hotspots = [...rankable].sort((a, b) => b.risk - a.risk).slice(0, limit);

  // --------------------------------------------------------- ownership ----
  const authorList = [...history.authors.values()].map((author) => {
    const recentDays = today - author.lastDay;
    return {
      key: author.key,
      name: author.name,
      commits: author.commits,
      merges: author.merges,
      nonMerge: author.commits - author.merges,
      firstDay: author.firstDay,
      lastDay: author.lastDay,
      tenureDays: author.firstDay > 0 ? author.lastDay - author.firstDay : 0,
      files: author.fileCount,
      lines: author.adds + author.dels,
      lastActive: recentDays,
      lastActiveLabel: recentDays <= 30 ? 'active' : recentDays <= 180 ? 'recent' : recentDays <= 365 ? 'lurking' : 'dormant',
      activeMonths: author.months.size,
    };
  }).sort((a, b) => b.commits - a.commits);

  // Bus factor: the smallest number of people whose combined history accounts
  // for at least half of all commits in the window.
  const totalCommits = authorList.reduce((sum, a) => sum + a.commits, 0);
  let busFactor = 0;
  let accumulated = 0;
  for (const author of authorList) {
    accumulated += author.commits;
    busFactor += 1;
    if (totalCommits > 0 && accumulated / totalCommits >= 0.5) break;
  }

  // Knowledge concentration: files that only one person has ever touched.
  const singleOwner = [];
  for (const s of rankable) {
    if (s.commits < 2) continue;
    if (s.authors === 1) singleOwner.push(s);
  }
  singleOwner.sort((a, b) => b.risk - a.risk);

  const orphanFiles = signals
    .filter((s) => !s.record.test && s.commits === 0 && s.code > 0)
    .sort((a, b) => b.code - a.code)
    .slice(0, 20);

  const staleFiles = rankable
    .filter((s) => s.daysSince !== null && s.daysSince > 365 && s.code > 200)
    .sort((a, b) => b.code - a.code)
    .slice(0, 20);

  // --------------------------------------------------------------- debt ----
  const debtByType = new Map();
  let oldestDebt = null;
  for (const s of signals) {
    for (const marker of s.shape.debt ?? []) {
      const entry = debtByType.get(marker.marker) ?? { marker: marker.marker, count: 0, weight: 0, files: new Set() };
      entry.count += 1;
      entry.weight += marker.weight;
      entry.files.add(s.record.rel);
      debtByType.set(marker.marker, entry);
      if (marker.weight >= 2) {
        // "Oldest debt" means the debt sitting in files nobody has opened in
        // the longest time -- that is the part everyone has forgotten exists.
        if (s.daysSince !== null && (oldestDebt === null || s.daysSince > oldestDebt.daysSince)) {
          oldestDebt = { rel: s.record.rel, marker: marker.marker, text: marker.text, line: marker.line, daysSince: s.daysSince, code: s.code };
        }
      }
    }
  }
  const debtList = [...debtByType.values()]
    .map((d) => ({ marker: d.marker, count: d.count, files: d.files.size, weight: d.weight }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count);

  // ----------------------------------------------------------- timeline ----
  const timeline = buildTimeline(history, today);

  // ------------------------------------------------------------- health ---
  const health = buildHealth({
    signals, rankable, totals, testCoverage, coupling, authorList, busFactor, timeline, cyclicFiles,
  });

  return {
    generatedAt: new Date().toISOString(),
    today,
    totals,
    languages: languageList,
    hotspots,
    signals,
    maxes,
    ownership: {
      authors: authorList,
      total: authorList.length,
      busFactor,
      singleOwner: singleOwner.slice(0, limit),
      singleOwnerCount: singleOwner.length,
      orphanFiles,
      staleFiles,
    },
    coupling: {
      edges: coupling.edges,
      fanIn: coupling.fanIn,
      fanOut: coupling.fanOut,
      cycles: coupling.cycles,
      cycleFileCount: cyclicFiles.size,
      undeclared: coupling.undeclared,
      unused: coupling.unused,
      externals: [...coupling.externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      externalCount: coupling.externals.size,
    },
    debt: {
      byType: debtList,
      total: debtList.reduce((sum, d) => sum + d.count, 0),
      oldest: oldestDebt,
      suppressed: totals.suppressed,
    },
    tests: testCoverage,
    timeline,
    health,
    history: {
      commits: history.commits,
      merges: history.merges,
      emptyCommits: history.emptyCommits,
      authors: history.authors.size,
      firstDay: history.oldestDay,
      lastDay: history.newestDay,
      spanDays: history.newestDay - history.oldestDay,
      adds: history.adds,
      dels: history.dels,
      renames: history.renames,
      partial: history.partial,
      partialReason: history.partialReason,
      deleted: history.deleted?.length ?? 0,
    },
  };
}

/** Composite 0-100 health index with named, individually-scored components. */
function buildHealth({ signals, rankable, totals, testCoverage, coupling, authorList, busFactor, timeline, cyclicFiles }) {
  const components = [];

  const add = (key, label, value, detail) => {
    components.push({ key, label, value: Math.round(value * 100), detail });
  };

  // --- complexity: median decisions per function, mapped onto a sane range.
  const perFunctionValues = rankable.map((s) => s.perFunction).sort((a, b) => a - b);
  const medianPerFunction = percentile(perFunctionValues, 0.5);
  add(
    'maintainability',
    'Maintainability',
    1 - Math.min(1, Math.max(0, (medianPerFunction - 2) / 10)),
    `median ${medianPerFunction.toFixed(1)} decision points per function`,
  );

  // --- tests
  add(
    'tests',
    'Test coverage',
    Math.min(1, testCoverage.ratio * 1.6),
    `${testCoverage.covered}/${testCoverage.sourceFiles} source files reached by a test (${(testCoverage.ratio * 100).toFixed(0)}%)`,
  );

  // --- ownership
  const activeAuthors = authorList.filter((a) => a.lastActive <= 180).length;
  const ownershipSpread = authorList.length === 0 ? 1 : Math.min(1, activeAuthors / Math.max(2, authorList.length * 0.25));
  add(
    'ownership',
    'Ownership spread',
    ownershipSpread,
    `${activeAuthors} of ${authorList.length} authors active in the last 6 months, bus factor ${busFactor}`,
  );

  // --- debt load
  const debtPerKloc = totals.code === 0 ? 0 : (totals.debt / (totals.code / 1000));
  add('debt', 'Debt load', 1 - Math.min(1, debtPerKloc / 20), `${debtPerKloc.toFixed(1)} markers per 1k lines`);

  // --- structure
  const cyclicRatio = signals.length === 0 ? 0 : cyclicFiles.size / signals.length;
  add('structure', 'Structure', 1 - Math.min(1, cyclicRatio * 8), `${coupling.cycles.length} import cycles touching ${cyclicFiles.size} files`);

  // --- churn concentration.
  // Measured as: what share of all changes did the most-changed 10% of files
  // make? Around 30% means change is spread across the codebase; 70% or more
  // means a small group of files absorbs almost every edit, and each of them is
  // a merge conflict waiting to happen.
  const churnShare = churnConcentration(rankable);
  add(
    'focus',
    'Change concentration',
    1 - Math.min(1, Math.max(0, (churnShare - 0.3) / 0.4)),
    `most-changed 10% of files account for ${(churnShare * 100).toFixed(0)}% of all commits`,
  );

  // --- velocity / consistency
  const recent = (timeline?.months ?? []).slice(-6);
  const activeMonths = recent.filter((m) => m.commits > 0).length;
  add('velocity', 'Maintenance cadence', activeMonths / 6, `${activeMonths} of the last 6 months have commits`);

  const value = components.reduce((sum, c) => sum + c.value, 0) / components.length;
  return {
    value: Math.round(value),
    grade: grade(value),
    components,
  };
}

/** Share of all file-level commits made by the most-changed 10% of files. */
function churnConcentration(rankable) {
  const withChurn = rankable.filter((s) => s.commits > 0);
  if (withChurn.length === 0) return 0;
  const sorted = [...withChurn].sort((a, b) => b.commits - a.commits);
  const decile = Math.max(1, Math.floor(sorted.length * 0.1));
  const top = sorted.slice(0, decile).reduce((sum, s) => sum + s.commits, 0);
  const total = sorted.reduce((sum, s) => sum + s.commits, 0);
  return total === 0 ? 0 : top / total;
}

function grade(value) {
  if (value >= 85) return 'A';
  if (value >= 72) return 'B';
  if (value >= 58) return 'C';
  if (value >= 42) return 'D';
  return 'E';
}

/** Monthly commit series, oldest first, including empty months. */
export function buildTimeline(history, today, months = 26) {
  // Step by calendar months, not by 30-day chunks. Thirty-day steps drift: a
  // 26-point series built that way eventually produces two buckets for the same
  // month and misses another entirely, which silently mislabels the sparkline.
  const end = new Date(today * MS_PER_DAY);
  // Absolute month index, so stepping back never has to reason about borrowing
  // across a year boundary. (Subtracting from a raw month number and taking
  // `% 12` afterwards is wrong in JavaScript: `-1 % 12` is `-1`, not `11`.)
  const endIndex = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const buckets = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const index = endIndex - i;
    const year = Math.floor(index / 12);
    const month = index - year * 12;
    buckets.push(`${year}-${String(month + 1).padStart(2, '0')}`);
  }
  const series = buckets.map((bucket) => {
    const entry = history.months.get(bucket);
    return {
      month: bucket,
      commits: entry?.commits ?? 0,
      merges: entry?.merges ?? 0,
      authors: entry?.authors.size ?? 0,
      files: entry?.fileCount ?? 0,
      adds: entry?.adds ?? 0,
      dels: entry?.dels ?? 0,
    };
  });
  const max = series.reduce((m, s) => Math.max(m, s.commits), 0);
  return { months: series, max };
}

function topDirs(rel, depth) {
  const parts = rel.split('/');
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

export { toDayIndex, toMonth, authorKey, recencyBucket, History };
