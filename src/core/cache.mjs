/**
 * Analysis cache.
 *
 * The expensive part of a run is re-reading and re-measuring every source file.
 * Results are cached on disk, sharded by directory so that editing one file
 * invalidates only its own shard instead of the whole run.
 *
 * Cache location defaults to a `.oc-cache` directory next to the tool itself,
 * deliberately: analysing a repository should never write into that repository,
 * and a tool someone leaves on disk for years should not litter their home
 * directory either. If the install directory is not writable, the OS temp
 * directory is used instead. Everything here fails soft -- a cache miss or an
 * unwritable directory costs time, never correctness.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Bumped whenever the shape of a cached entry changes. */
export const CACHE_VERSION = 3;

/**
 * Modules whose *contents* determine what a cached entry means.
 *
 * A version string alone is not enough: change the scanner so that `?:` no
 * longer counts as a branch, and every cache entry written by the old scanner
 * still looks valid -- so the tool cheerfully reports last week's numbers. This
 * hashes the source of the measurement code itself, which makes stale cache
 * entries structurally impossible rather than a thing to remember.
 */
// Paths relative to this file (`src/core/`), not to the project root: the
// original version used root-relative names, every read failed, and the hash was
// taken over the string "missing" -- so the fingerprint never changed and no
// cache entry was ever invalidated, no matter how the measurement code evolved.
const MEASUREMENT_MODULES = ['scan.mjs', 'lang.mjs'];

let cachedFingerprint = null;

/**
 * A short hash of the measurement code.
 *
 * @param {boolean} [refresh] bypass the per-process memo (used by the tests)
 * @returns {Promise<{fingerprint: string, sources: Array<{file: string, bytes: number, found: boolean}>}>}
 */
export async function fingerprintSources(refresh = false) {
  const here = dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha1');
  const sources = [];
  for (const relative of MEASUREMENT_MODULES) {
    const path = join(here, relative);
    hash.update(relative);
    try {
      const contents = await readFile(path);
      hash.update(contents);
      sources.push({ file: relative, bytes: contents.length, found: true });
    } catch (error) {
      // A missing module is a bug, not something to paper over: hashing a
      // placeholder would silently freeze the fingerprint.
      hash.update(`missing:${error.code ?? 'unknown'}`);
      sources.push({ file: relative, bytes: 0, found: false });
    }
  }
  return { fingerprint: hash.digest('base64url').slice(0, 12), sources };
}

/**
 * A short hash of the measurement code, memoised per process.
 * @returns {Promise<string>}
 */
export async function measurementFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  const { fingerprint, sources } = await fingerprintSources();
  const missing = sources.filter((s) => !s.found);
  if (missing.length > 0) {
    // Loudly, because a frozen fingerprint means a stale cache: the tool would
    // keep reporting numbers produced by code that no longer exists.
    throw new Error(
      `cannot fingerprint the measurement modules (${missing.map((m) => m.file).join(', ')}); `
      + 'refusing to use a cache that cannot detect changes to its own inputs',
    );
  }
  cachedFingerprint = fingerprint;
  return cachedFingerprint;
}

/**
 * `<install-dir>/.oc-cache`. `core/cache.mjs` sits two directories below the
 * project root, so `../..` from here is the folder the tool lives in.
 */
function defaultCacheDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '.oc-cache');
}

export class Cache {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]          explicit cache directory
   * @param {boolean} [opts.enabled]
   * @param {string} opts.version        program version, part of every key
   * @param {string} [opts.fingerprint]   hash of the measurement code
   * @param {boolean} [opts.readonly]
   */
  constructor({ dir, enabled = true, version = '0', fingerprint = 'unfingerprinted', readonly = false } = {}) {
    this.enabled = enabled;
    this.readonly = readonly;
    this.version = version;
    this.fingerprint = fingerprint;
    this.dir = dir ?? defaultCacheDir();
    this.dirReady = false;
    this.shards = new Map();
    this.dirty = new Set();
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.errors = 0;
  }

  /** Stable cache key for one file's analysis. */
  keyFor(rel, size, mtimeMs) {
    const hash = createHash('sha1');
    hash.update(`${this.version}\u0000${this.fingerprint}\u0000${rel}\u0000${size}\u0000${mtimeMs}`);
    return hash.digest('base64url').slice(0, 22);
  }

  /** Group files into cache shards keyed by their directory prefix. */
  shardFor(rel) {
    const parts = rel.split('/');
    const prefix = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '_root';
    let shard = this.shards.get(prefix);
    if (!shard) {
      shard = { prefix, name: `${createHash('sha1').update(prefix).digest('base64url').slice(0, 16)}.json`, entries: null, loaded: false };
      this.shards.set(prefix, shard);
    }
    return shard;
  }

  async load(prefix) {
    const shard = this.shards.get(prefix) ?? this.shardFor(`${prefix}/x`);
    if (shard.loaded) return shard;
    shard.loaded = true;
    if (!this.enabled || this.readonly) {
      shard.entries = new Map();
      return shard;
    }
    try {
      const raw = await readFile(join(this.dir, shard.name), 'utf8');
      const parsed = JSON.parse(raw);
      shard.entries = parsed && parsed.v === CACHE_VERSION ? new Map(Object.entries(parsed.e)) : new Map();
    } catch {
      shard.entries = new Map();
    }
    return shard;
  }

  async get(rel, size, mtimeMs) {
    if (!this.enabled) {
      this.misses += 1;
      return undefined;
    }
    const key = this.keyFor(rel, size, mtimeMs);
    const shard = await this.load(this.shardFor(rel).prefix);
    if (shard.entries.has(key)) {
      this.hits += 1;
      return shard.entries.get(key);
    }
    this.misses += 1;
    return undefined;
  }

  async put(rel, size, mtimeMs, value) {
    if (!this.enabled || this.readonly) return;
    const key = this.keyFor(rel, size, mtimeMs);
    const shard = this.shardFor(rel);
    if (!shard.loaded) await this.load(shard.prefix);
    shard.entries.set(key, value);
    this.dirty.add(shard);
  }

  /**
   * Create the cache directory, falling back to the OS temp directory when the
   * preferred location cannot be made (a global install, a read-only mount).
   * Never throws; disables the cache instead if even that fails.
   */
  async ensureDir() {
    if (this.dirReady) return this.enabled ? this.dir : null;
    for (const candidate of [this.dir, join(tmpdir(), `oc-cache-${process.getuid?.() ?? 'user'}`)]) {
      try {
        await mkdir(candidate, { recursive: true, mode: 0o700 });
        this.dir = candidate;
        this.dirReady = true;
        return candidate;
      } catch {
        this.errors += 1;
      }
    }
    this.enabled = false;
    this.dirReady = true;
    return null;
  }

  /** Persist dirty shards. Best effort; never throws. */
  async flush() {
    if (!this.enabled || this.readonly || this.dirty.size === 0) return;
    const dir = await this.ensureDir();
    if (!dir) return;
    const jobs = [];
    for (const shard of this.dirty) {
      const payload = JSON.stringify({ v: CACHE_VERSION, e: Object.fromEntries(shard.entries) });
      jobs.push(
        writeFile(join(dir, shard.name), payload, 'utf8')
          .then(() => {
            this.writes += 1;
          })
          .catch(() => {
            this.errors += 1;
          }),
      );
    }
    this.dirty.clear();
    await Promise.all(jobs);
  }

  /** Delete cache shards not touched within `maxAgeMs`. */
  async prune(maxAgeMs = 14 * 24 * 60 * 60 * 1000) {
    if (!this.enabled) return 0;
    let removed = 0;
    try {
      const files = await readdir(this.dir);
      const cutoff = Date.now() - maxAgeMs;
      for (const name of files) {
        if (!name.endsWith('.json')) continue;
        const path = join(this.dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      return removed;
    }
    return removed;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      errors: this.errors,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
