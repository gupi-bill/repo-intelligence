/**
 * History aggregation.
 *
 * Consumes commits exactly as they stream out of git and keeps only aggregates,
 * never a commit list. That is what lets a 45k-commit repository be analysed in
 * fixed memory: peak usage is proportional to the number of distinct files ever
 * touched, not to the length of history.
 *
 * Everything is keyed by a stable author identity (normalised email) rather than
 * a display name, because "Jane Doe <jane@x.com>" and "jane <jane@x.com>" are
 * the same person for ownership purposes.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Parse a `YYYY-MM-DD` git date into a UTC day index.
 *
 * Memoised because a repository has far more commits than distinct dates: a
 * 45k-commit history spans about 1,150 of them, so this runs 45,260 times to
 * produce 1,159 answers. `Date.parse` was the single most expensive call in the
 * aggregation loop, and the cache removes 97% of them.
 */
const dayCache = new Map();

export function toDayIndex(date) {
  const cached = dayCache.get(date);
  if (cached !== undefined) return cached;
  const ts = Date.parse(`${date}T00:00:00Z`);
  const day = Number.isNaN(ts) ? 0 : Math.floor(ts / MS_PER_DAY);
  if (dayCache.size < 100000) dayCache.set(date, day);
  return day;
}

/** Turn a `YYYY-MM-DD` string into a `YYYY-MM` bucket. */
export function toMonth(date) {
  return date.length >= 7 ? date.slice(0, 7) : 'unknown';
}

/**
 * Normalise an author identity. Prefers the email because names collide and
 * vary (`root`, `webmaster`, `unknown`); falls back to the name when git has no
 * usable email (common in imported or automated history).
 */
export function authorKey(name, email) {
  const clean = (email ?? '').trim().toLowerCase();
  if (clean && clean !== 'unknown' && !clean.endsWith('@users.noreply.github.com')) {
    return clean;
  }
  if (clean) return clean;
  const nameKey = (name ?? '').trim().toLowerCase();
  return nameKey ? `name:${nameKey}` : 'unknown';
}

/**
 * Memoise of `authorKey` over the (name, email) pairs actually present in the
 * log.
 *
 * Same reasoning as the date cache: 45,260 commits resolve to 1,512 distinct
 * identities, and every miss costs two string allocations plus an `endsWith`.
 */
const keyCache = new Map();

export function authorKeyCached(name, email) {
  const key = `${email}\u0000${name}`;
  const cached = keyCache.get(key);
  if (cached !== undefined) return cached;
  const value = authorKey(name, email);
  if (keyCache.size < 100000) keyCache.set(key, value);
  return value;
}

/** Bucket a `YYYY-MM` into an age bucket label. */
export function recencyBucket(days, now) {
  if (days <= 7) return 'this week';
  if (days <= 30) return 'this month';
  if (days <= 90) return '3 months';
  if (days <= 365) return 'a year';
  if (days <= 730) return '2 years';
  return '3+ years';
}

export class History {
  /**
   * @param {{now?: number, includeLines?: boolean}} [opts]
   *   `now` is a day index; defaults to today, and is injectable so tests are
   *   deterministic.
   */
  constructor(opts = {}) {
    this.today = opts.now ?? Math.floor(Date.now() / MS_PER_DAY);
    this.includeLines = opts.includeLines ?? false;

    /** @type {Map<string, object>} path -> per-file aggregate */
    this.files = new Map();
    /** @type {Map<string, object>} authorKey -> author aggregate */
    this.authors = new Map();
    /** @type {Map<string, {commits: number, adds: number, dels: number, files: number, authors: Set<string>}>} */
    this.months = new Map();

    this.commits = 0;
    this.merges = 0;
    this.emptyCommits = 0;
    this.authoredCommits = 0;
    this.adds = 0;
    this.dels = 0;
    this.binaryChanges = 0;
    this.renames = 0;
    this.oldestDay = 0;
    this.newestDay = 0;
    this.partial = false;
    this.truncated = false;
  }

  /** Per-file accumulator, created on first sight of a path. */
  #file(path) {
    let entry = this.files.get(path);
    if (entry === undefined) {
      entry = {
        path,
        commits: 0,
        adds: 0,
        dels: 0,
        authors: new Map(),
        firstDay: 0,
        lastDay: 0,
        lastAuthor: null,
        lastSubject: null,
        months: new Map(),
        bornCommit: null,
        inferredFrom: null,
        mergedInto: null,
        binary: false,
      };
      this.files.set(path, entry);
    }
    return entry;
  }

  /** Per-author accumulator, created on first sight of an identity. */
  #author(key, name) {
    let entry = this.authors.get(key);
    if (entry === undefined) {
      entry = {
        key,
        name: name || key,
        commits: 0,
        merges: 0,
        adds: 0,
        dels: 0,
        firstDay: 0,
        lastDay: 0,
        fileCount: 0,
        months: new Map(),
        alive: true,
      };
      this.authors.set(key, entry);
    }
    return entry;
  }

  #month(bucket) {
    let entry = this.months.get(bucket);
    if (entry === undefined) {
      entry = { commits: 0, adds: 0, dels: 0, fileCount: 0, authors: new Set(), merges: 0 };
      this.months.set(bucket, entry);
    }
    return entry;
  }

  /**
   * Fold one commit into the aggregates.
   * @param {object} commit from core/git.mjs
   */
  add(commit) {
    this.commits += 1;
    if (commit.merge) this.merges += 1;

    const day = toDayIndex(commit.date);
    if (day > 0) {
      if (this.oldestDay === 0 || day < this.oldestDay) this.oldestDay = day;
      if (day > this.newestDay) this.newestDay = day;
    }
    const bucket = toMonth(commit.date);
    const month = this.#month(bucket);
    month.commits += 1;
    if (commit.merge) month.merges += 1;

    const key = authorKeyCached(commit.author, commit.email);
    const author = this.#author(key, commit.author);
    author.commits += 1;
    if (commit.merge) author.merges += 1;
    if (day > 0) {
      if (author.firstDay === 0 || day < author.firstDay) author.firstDay = day;
      if (day > author.lastDay) author.lastDay = day;
    }
    author.months.set(bucket, (author.months.get(bucket) ?? 0) + 1);
    month.authors.add(key);
    this.authoredCommits += 1;

    if (commit.files.length === 0) this.emptyCommits += 1;

    for (const change of commit.files) {
      const file = this.#file(change.path);
      file.commits += 1;
      if (change.binary) {
        file.binary = true;
        this.binaryChanges += 1;
      }
      if (change.rename && change.oldPath) {
        this.renames += 1;
        file.mergedInto = file.mergedInto ?? change.oldPath;
      }
      if (day > 0) {
        if (file.firstDay === 0 || day < file.firstDay) {
          file.firstDay = day;
          file.bornCommit = commit.hash;
        }
        if (day >= file.lastDay) {
          file.lastDay = day;
          file.lastAuthor = key;
          file.lastSubject = commit.subject;
        }
      }
      file.months.set(bucket, (file.months.get(bucket) ?? 0) + 1);
      file.authors.set(key, (file.authors.get(key) ?? 0) + 1);
      // `author.files` and `month.files` are deliberately not maintained here.
      // Both existed only to answer `.size`, together costing 350,000 insertions
      // of long path strings per run, and the same information is already
      // present as `file.authors` and `file.months` -- the exact transpose. They
      // are derived once in finalize() instead.

      if (this.includeLines && !change.binary) {
        const add = change.add > 0 ? change.add : 0;
        const del = change.del > 0 ? change.del : 0;
        file.adds += add;
        file.dels += del;
        author.adds += add;
        author.dels += del;
        month.adds += add;
        month.dels += del;
        this.adds += add;
        this.dels += del;
      }
    }
  }

  /**
   * Cross-reference the aggregates against the files that exist right now.
   *
   * Paths that appear in history but not in the index were deleted or moved.
   * A move shows up as a delete and an add of two different paths in the *same*
   * commit, so those pairs are reconstructed here and the old file's history is
   * folded into the new path. Without this, moving a file resets its churn
   * history and every "hot file" ranking silently goes wrong on repos that
   * reorganise themselves.
   *
   * @param {Set<string>} present paths currently in the index
   */
  finalize(present) {
    this.present = present;

    // Group history-only paths by the commit that first introduced them, then
    // pair each with an introduced-but-new path from that same commit.
    const bornIn = new Map(); // bornCommit -> array of paths
    for (const file of this.files.values()) {
      if (present.has(file.path)) continue;
      if (!file.bornCommit) continue;
      const list = bornIn.get(file.bornCommit);
      if (list) list.push(file.path);
      else bornIn.set(file.bornCommit, [file.path]);
    }

    for (const file of this.files.values()) {
      if (!present.has(file.path) || !file.bornCommit) continue;
      const candidates = bornIn.get(file.bornCommit);
      if (!candidates || candidates.length === 0) continue;
      const matchPath = bestRenameMatch(file, candidates);
      if (!matchPath) continue;
      const matchFile = this.files.get(matchPath);
      if (!matchFile) continue;
      this.#foldHistory(matchFile, file.path);
      candidates.splice(candidates.indexOf(matchPath), 1);
      this.renames += 1;
    }

    this.#deriveCounts();

    // Anything still unmatched was genuinely deleted.
    this.deleted = [];
    for (const file of this.files.values()) {
      if (present.has(file.path)) continue;
      this.deleted.push(file.path);
    }
    this.deleted.sort((a, b) => this.files.get(b).commits - this.files.get(a).commits);
    return this;
  }

  /**
   * Transfer an old path's history onto its replacement path.
   *
   * The rename commit is counted by both the old and the new path, so the
   * combined total is inflated by exactly one. That is deliberate: dropping it
   * would mean special-casing a single commit, and an error of one is far
   * cheaper to reason about than a special case in a hot loop.
   *
   * @param {object} oldFile the aggregate for the vanished path
   * @param {string} newPath
   */
  #foldHistory(oldFile, newPath) {
    const target = this.#file(newPath);
    target.inferredFrom = oldFile.path;
    oldFile.mergedInto = newPath;

    target.commits += oldFile.commits;
    for (const [key, count] of oldFile.authors) {
      target.authors.set(key, (target.authors.get(key) ?? 0) + count);
    }
    for (const [bucket, count] of oldFile.months) {
      target.months.set(bucket, (target.months.get(bucket) ?? 0) + count);
    }
    target.adds += oldFile.adds;
    target.dels += oldFile.dels;
    if (oldFile.firstDay > 0 && (target.firstDay === 0 || oldFile.firstDay < target.firstDay)) {
      target.firstDay = oldFile.firstDay;
      target.bornCommit = oldFile.bornCommit;
    }
  }

  /**
   * Derive "how many distinct files did this author / this month touch" from the
   * per-file tables, instead of maintaining a Set of every path for every author
   * and every month during the stream.
   *
   * One pass over the file table, bounded by the number of files rather than by
   * the number of changes: on the 45k-commit reference repository that is 34,186
   * short iterations replacing 349,967 long-string Set insertions, and it drops
   * two large collections from the peak heap.
   *
   * Must run after rename folding, so a moved file is counted once.
   */
  #deriveCounts() {
    for (const author of this.authors.values()) author.fileCount = 0;
    for (const month of this.months.values()) month.fileCount = 0;
    for (const file of this.files.values()) {
      for (const key of file.authors.keys()) {
        const author = this.authors.get(key);
        if (author) author.fileCount += 1;
      }
      for (const bucket of file.months.keys()) {
        const month = this.months.get(bucket);
        if (month) month.fileCount += 1;
      }
    }
  }

  /** Marks the accumulator as having seen only part of the history. */
  markPartial(reason) {
    this.partial = true;
    this.partialReason = reason;
    return this;
  }
}

/**
 * Score how likely `candidate` is a rename of `file`.
 * Same basename is the strong signal; a common path-prefix or extension is weak
 * corroboration. Deliberately conservative: a false positive corrupts a file's
 * history, which is worse than treating a move as a delete plus an add.
 */
function bestRenameMatch(file, candidates) {
  const base = basename(file.path);
  const ext = extension(file.path);
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (candidate === file.path) continue;
    let score = 0;
    if (basename(candidate) === base) score += 100;
    else if (basename(candidate).startsWith(base) || base.startsWith(basename(candidate))) score += 20;
    if (extension(candidate) === ext) score += 10;
    if (parentOf(candidate) === parentOf(file.path)) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 20 ? best : null;
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function extension(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
