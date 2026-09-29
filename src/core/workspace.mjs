/**
 * Workspace scanning.
 *
 * Turns "a git repository" into "a map of every tracked file, its shape, and
 * whether we had to work for it". Cache hits are resolved first so a repeat run
 * does almost no I/O, and only the residue is handed to the worker pool.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { trackedFiles, untrackedFiles } from './git.mjs';
import { languageFor, isBinaryPath, isVendorPath, isGeneratedPath, isTestPath } from './lang.mjs';
import { mapWithPool, defaultConcurrency } from './pool.mjs';
import { shapeOf, measureCode, extractImports, releaseCode } from './scan.mjs';

/**
 * @typedef {object} FileRecord
 * @property {string} rel
 * @property {string} abs
 * @property {number} size
 * @property {number} mtimeMs
 * @property {string|null} language
 * @property {boolean} test
 * @property {boolean} vendor
 * @property {boolean} generated
 * @property {object} shape
 */

/**
 * Enumerate candidate files.
 * @param {object} opts
 * @param {string} opts.root
 * @param {boolean} [opts.includeUntracked]
 * @param {string[]} [opts.pathspec]
 * @param {boolean} [opts.includeVendor]
 * @param {number} [opts.maxBytes]
 * @param {string[]} [opts.exclude]  user-supplied path substrings to skip
 * @returns {Promise<{records: FileRecord[], scanned: number, total: number, skipped: object}>}
 */
export async function collectFiles(opts) {
  const {
    root, includeUntracked = false, pathspec = [], includeVendor = false,
    maxBytes = 1_500_000, exclude = [],
  } = opts;
  let rels = await trackedFiles(root, pathspec);
  if (includeUntracked) rels = rels.concat(await untrackedFiles(root));

  const total = rels.length;
  const records = [];
  // Every path that was considered and not analysed, with a reason. Reported in
  // the footer, because a metric that silently drops a third of the repository
  // is a metric nobody should trust.
  const skipped = { vendor: 0, binary: 0, large: 0, missing: 0, excluded: 0, empty: 0, other: 0 };
  // Vendor trees are skipped without a stat(): they are never interesting and
  // there can be tens of thousands of them.
  const candidates = [];
  const excludes = exclude.filter((e) => e !== '');
  for (const rel of rels) {
    // A user-supplied exclusion outranks every built-in rule: it is the only one
    // that can know where *this* repository keeps its third-party code.
    if (excludes.some((needle) => rel.includes(needle))) {
      skipped.excluded += 1;
      continue;
    }
    if (!includeVendor && isVendorPath(rel)) {
      skipped.vendor += 1;
      continue;
    }
    if (isBinaryPath(rel)) {
      skipped.binary += 1;
      continue;
    }
    candidates.push(rel);
  }

  const statResults = await Promise.all(
    candidates.map(async (rel) => {
      const abs = join(root, rel);
      try {
        const info = await stat(abs);
        if (!info.isFile()) return { rel, skip: 'not-regular' };
        if (info.size === 0) return { rel, skip: 'empty' };
        if (info.size > maxBytes) return { rel, skip: 'large', size: info.size };
        return { rel, abs, size: info.size, mtimeMs: Math.round(info.mtimeMs) };
      } catch {
        return { rel, skip: 'missing' };
      }
    }),
  );

  for (const result of statResults) {
    if (result.skip) {
      if (result.skip === 'large') skipped.large += 1;
      else if (result.skip === 'missing') skipped.missing += 1;
      else if (result.skip === 'empty') skipped.empty += 1;
      else skipped.other += 1;
      continue;
    }
    const lang = languageFor(result.rel);
    records.push({
      rel: result.rel,
      abs: result.abs,
      size: result.size,
      mtimeMs: result.mtimeMs,
      language: lang?.name ?? null,
      test: isTestPath(result.rel, lang),
      vendor: false,
      generated: isGeneratedPath(result.rel),
      shape: null,
    });
  }

  records.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { records, scanned: records.length, total, skipped };
}

/**
 * Populate `record.shape` for every record, using the cache where possible.
 *
 * @param {object} opts
 * @param {FileRecord[]} opts.records
 * @param {import('./cache.mjs').Cache} opts.cache
 * @param {number} [opts.concurrency]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{hits: number, scanned: number}>}
 */
export async function scanRecords({ records, cache, concurrency, onProgress, root }) {
  let hits = 0;
  const pending = [];

  for (const record of records) {
    const cached = await cache.get(record.rel, record.size, record.mtimeMs);
    if (cached) {
      record.shape = cached;
      hits += 1;
    } else {
      pending.push(record);
    }
  }

  let done = hits;
  if (pending.length > 0) {
    const results = await mapWithPool(
      pending,
      {
        concurrency: concurrency ?? defaultConcurrency(),
        onProgress: (d) => {
          done = hits + d;
          onProgress?.(done, records.length);
        },
      },
      async (batch) => {
        // Inline fallback: identical logic, same module, so results cannot drift.
        const out = [];
        for (const record of batch) {
          const { readFile } = await import('node:fs/promises');
          let buf;
          try {
            buf = await readFile(record.abs);
          } catch {
            out.push({ rel: record.rel, skip: 'unreadable', language: record.language });
            continue;
          }
          out.push(measureBuffer(buf, record));
        }
        return out;
      },
    );
    void root;

    const pendingByRel = new Map(pending.map((r) => [r.rel, r]));
    for (const shape of results) {
      const record = pendingByRel.get(shape.rel);
      if (!record) continue;
      record.shape = shape;
      await cache.put(record.rel, record.size, record.mtimeMs, shape);
    }
  }

  onProgress?.(records.length, records.length);
  await cache.flush();
  return { hits, scanned: pending.length };
}

/** Shared measurement path so the pool and the inline fallback cannot diverge. */
export function measureBuffer(buf, record) {
  const lang = languageFor(record.rel);
  const base = {
    rel: record.rel,
    language: lang?.name ?? null,
    skip: null,
    total: 0, code: 0, comment: 0, blank: 0, comments: 0,
    decisions: 0, depth: 0, funcs: 0, suppressed: 0, complexity: 0,
    debt: [], imports: [], bytes: buf.length, error: null,
  };
  if (!lang) return { ...base, skip: 'unknown-language' };
  let text;
  try {
    text = buf.toString('utf8');
  } catch {
    return { ...base, skip: 'binary' };
  }
  try {
    const shape = shapeOf(text, lang);
    measureCode(shape, lang);
    const imports = extractImports(shape, lang);
    releaseCode(shape);
    shape.debt.sort((a, b) => b.weight - a.weight);
    return {
      rel: record.rel,
      language: lang.name,
      skip: null,
      total: shape.total,
      code: shape.code,
      comment: shape.comment,
      blank: shape.blank,
      comments: shape.comments,
      decisions: shape.decisions,
      depth: shape.maxDepth,
      funcs: shape.funcs,
      suppressed: shape.suppressed,
      complexity: shape.complexity,
      debt: shape.debt,
      imports,
      bytes: buf.length,
      error: null,
    };
  } catch (error) {
    return { ...base, error: String(error?.message ?? error) };
  }
}

/** Extensions probed when an import omits one, in preference order. */
const PROBE_EXT = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.cs', '.php', '.vue', '.svelte', '.dart',
];

const INDEX_NAMES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs',
  'index.py', 'index.vue', 'index.go', 'index.rs', 'index.dart',
];

/**
 * Convenience: build a lookup index over records for import resolution.
 *
 * Besides the path lookup itself, this precomputes the *probe candidates*:
 * the subset of extensions and `index.*` names that actually exist in this
 * repository. Import resolution tries each candidate against every candidate
 * base directory, and that inner loop is the hottest code in the analysis --
 * probing 20 extensions for a repository that only ever uses `.py` and `.ts`
 * is 10x the work for no chance of a hit.
 */
export function buildIndex(records) {
  const byPath = new Map();
  const byStem = new Map();
  const byDirIndex = new Map();
  const presentExt = new Set();
  const presentIndex = new Set();
  for (const record of records) {
    byPath.set(record.rel, record);
    const slash = record.rel.lastIndexOf('/');
    const base = slash === -1 ? record.rel : record.rel.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot === -1 ? base : base.slice(0, dot);
    if (!byStem.has(base)) byStem.set(base, record);
    if (!byStem.has(stem)) byStem.set(stem, record);
    const dir = slash === -1 ? '' : record.rel.slice(0, slash);
    if (!byDirIndex.has(dir)) byDirIndex.set(dir, []);
    byDirIndex.get(dir).push(record);
    if (dot > 0) presentExt.add(base.slice(dot));
  }
  // A repository "has" an index file if any tracked path ends with it, so build
  // the suffix set in one pass rather than rescanning every path per name.
  for (const path of byPath.keys()) {
    const slash = path.lastIndexOf('/');
    const base = slash === -1 ? path : path.slice(slash + 1);
    if (base.startsWith('index.')) presentIndex.add(base);
  }

  // Keep the canonical preference order, not discovery order, so a hit is the
  // same one the full list would have produced.
  const probeExtensions = PROBE_EXT.filter((ext) => presentExt.has(ext));
  const probeIndexes = INDEX_NAMES.filter((name) => presentIndex.has(name));

  return {
    byPath,
    byStem,
    byDirIndex,
    probeExtensions: probeExtensions.length > 0 ? probeExtensions : PROBE_EXT,
    probeIndexes,
    size: records.length,
  };
}
