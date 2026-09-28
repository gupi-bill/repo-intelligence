/**
 * Git plumbing adapter.
 *
 * Everything oc knows about history comes from exactly one streaming pass of
 * `git log --numstat -z`, which for a 45k-commit repository emits ~100MB of
 * text. That stream is parsed with an incremental state machine (see
 * `parseHistoryChunk`) so peak memory stays proportional to a single record
 * rather than to the whole history.
 *
 * The wire format we rely on, produced by
 *
 *   git log --all -M --date=short \
 *     --pretty=format:"%x01%H%x02%an%x02%ae%x02%ad%x02%P%x02%s" --numstat -z
 *
 * is a sequence of records:
 *
 *   \x01 hash \x02 author \x02 email \x02 date \x02 parents \x02 subject
 *   \n
 *   add \t del \t path \0
 *   add \t del \t \0 oldPath \0 newPath \0      <- rename: path slot is empty
 *   -  \t -   \t path \0                        <- binary
 *   \0                                          <- record separator
 *   \x01 ...                                    <- next record (merges/empty
 *                                                 commits emit no numstat at all)
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const REC = '\x01';
const FLD = '\x02';

/** Maximum bytes we will buffer for one git subprocess' stdout. */
const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Run git and buffer stdout. Used for small queries.
 * @param {string[]} args
 * @param {{cwd: string, maxBuffer?: number, allowFail?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string}>}
 */
export function runGit(args, opts = {}) {
  const { cwd = process.cwd(), maxBuffer = 32 * 1024 * 1024, allowFail = false } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let outLen = 0;
    let settled = false;
    const fail = (message, code = 1) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    child.stdout.on('data', (chunk) => {
      outLen += chunk.length;
      if (outLen > maxBuffer) {
        child.kill('SIGKILL');
        fail(`git ${args[0]}: output exceeded ${maxBuffer} bytes`);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on('error', (error) => fail(`failed to spawn git: ${error.message}`));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(err).toString('utf8').trim();
      const result = {
        ok: code === 0,
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr,
      };
      if (!result.ok && !allowFail) {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr || 'no stderr'}`));
        return;
      }
      resolve(result);
    });
  });
}

/** Does a working directory belong to a git repository? */
export async function isRepo(dir) {
  try {
    const { ok, stdout } = await runGit(['rev-parse', '--git-dir'], { cwd: dir, allowFail: true });
    return ok && stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` looking for the repository root.
 * @param {string} start
 * @returns {Promise<{root: string, gitDir: string, bare: boolean}|null>}
 */
export async function discoverRepo(start) {
  try {
    const { ok, stdout } = await runGit(
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--is-bare-repository'],
      { cwd: start, allowFail: true },
    );
    if (!ok) return null;
    const [toplevel, gitDir, bare] = stdout.trim().split('\n');
    if (!toplevel) return null;
    // A bare repository has no worktree, so there is nothing to display as a path.
    return { root: toplevel, gitDir, bare: bare === 'true' };
  } catch {
    return null;
  }
}

/** Cheap repository identity: root, current branch, HEAD, first/last commit. */
export async function repoHead(cwd) {
  const { stdout } = await runGit(
    ['log', '-1', '--date=iso-strict', '--pretty=format:%H\t%ad\t%an\t%D'],
    { cwd, allowFail: true },
  );
  const line = stdout.trim();
  const [hash = '', date = '', author = '', ...refs] = line.split('\t');
  const branchOut = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, allowFail: true });
  let branch = branchOut.stdout.trim();
  if (branch === 'HEAD' || branch === '') {
    // A detached HEAD still has a describable name if it is exactly at a ref.
    const described = await runGit(['describe', '--all', '--exact-match', 'HEAD'], { cwd, allowFail: true });
    branch = described.stdout.trim() || 'detached';
  }
  return { hash, date, author, branch, refs: refs.join(' ').split(',').map((r) => r.trim()).filter(Boolean) };
}

/** Commit count across all refs. */
export async function commitCount(cwd) {
  const { stdout } = await runGit(['rev-list', '--all', '--count'], { cwd, allowFail: true });
  return Number.parseInt(stdout.trim(), 10) || 0;
}

/** Distinct author identities, newest-activity-first. */
export async function authors(cwd) {
  const { stdout } = await runGit(
    ['shortlog', '-sne', '--all', '--no-merges'],
    { cwd, maxBuffer: DEFAULT_MAX_BUFFER, allowFail: true },
  );
  const list = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\s*\d+)\s+(.*?)\s+<(.*)>\s*$/.exec(line);
    if (!match) continue;
    list.push({ name: match[2], email: match[3], commits: Number.parseInt(match[1], 10) });
  }
  return list;
}

/** Currently tracked files (index), optionally filtered by pathspec. */
export async function trackedFiles(cwd, pathspec = []) {
  const args = ['ls-files', '-z'];
  if (pathspec.length) args.push('--', ...pathspec);
  const { stdout } = await runGit(args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER });
  return stdout.split('\0').filter(Boolean);
}

/** Files that exist on disk but are not tracked (uncommitted new work). */
export async function untrackedFiles(cwd) {
  const { stdout } = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd,
    maxBuffer: DEFAULT_MAX_BUFFER,
    allowFail: true,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Stream the history through `onCommit`.
 *
 * `mode` selects how much git has to compute:
 *
 *   'names'  `--name-only --no-renames` -- per-commit file lists only. This is
 *            the default because it is roughly 16x cheaper than diffing and
 *            still yields commit frequency, ownership, births, deaths and the
 *            timeline. Churn frequency is a better hot-spot signal than raw
 *            line counts anyway.
 *   'lines'  `--numstat` -- additionally pays for line-level diffs. Enable with
 *            `--lines` when you want added/removed line totals.
 *
 * `shard` splits the commit range across processes. The ranges are disjoint and
 * provably complete because `git log` emits newest-first and `--skip` /
 * `--max-count` slice that deterministic order.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {'names'|'lines'} [opts.mode]
 * @param {boolean} [opts.all]              include all refs (default true)
 * @param {boolean} [opts.renames]
 * @param {string} [opts.since]             e.g. '18.months.ago'
 * @param {string} [opts.until]
 * @param {number} [opts.maxCommits]        hard cap, newest first
 * @param {{skip: number, count: number}} [opts.shard]
 * @param {string[]} [opts.pathspec]
 * @param {(commit: object) => void} onCommit
 * @param {(bytes: number) => void} [onProgress]
 * @returns {Promise<{bytes: number}>}
 */
export function streamHistory(opts, onCommit, onProgress) {
  const {
    cwd,
    mode = 'names',
    all = true,
    since,
    until,
    maxCommits,
    pathspec = [],
    shard = null,
  } = opts;

  const args = ['log', '--no-color', '--date=short', '-z'];
  if (mode === 'lines') {
    args.push('--numstat');
    if (opts.renames !== false) args.push('-M');
    else args.push('--no-renames');
  } else {
    args.push('--name-only', '--no-renames');
  }
  if (all) args.push('--all');
  else args.push('HEAD');
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  if (shard) {
    args.push(`--skip=${shard.skip}`, `--max-count=${shard.count}`);
  } else if (maxCommits) {
    args.push(`--max-count=${maxCommits}`);
  }
  if (pathspec.length) args.push('--', ...pathspec);
  args.push('--pretty=format:%x01%H%x02%an%x02%ae%x02%ad%x02%P%x02%s');

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const decoder = new StringDecoder('utf8');
    const state = {
      buffer: '',
      pos: 0,
      header: null,
      inFiles: false,
      firstToken: true,
      renameAdd: 0,
      renameDel: 0,
      renameOld: null,
      renameNew: null,
      awaitingRename: 0,
      bytes: 0,
    };

    child.stdout.on('data', (chunk) => {
      state.bytes += chunk.length;
      state.buffer += decoder.write(chunk);
      drainHistory(state, onCommit);
      if (onProgress) onProgress(state.bytes);
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => reject(new Error(`failed to run git log: ${error.message}`)));    child.on('close', () => {
      state.buffer += decoder.end();
      drainHistory(state, onCommit, true);
      resolve({ bytes: state.bytes });
    });
  });
}

/**
 * Incremental record parser.
 *
 * Wire format, precisely (this is the whole contract):
 *
 *   record := \x01 hash \x02 author \x02 email \x02 date \x02 parents \x02 subject
 *             [ \n ] token \0 token \0 ... \0
 *
 * The subject is `%s`, which git defines as a single line, so it is terminated
 * by whichever of `\n`, `\0` or `\x01` comes first. The optional `\n` is the
 * only thing separating the header from the file list, and it is absent for
 * merges and empty commits -- which is precisely the case that a
 * newline-terminated-header parser silently corrupts.
 *
 * Every field after the subject is NUL terminated, and the final token of a
 * record is always empty. So "empty token" is an unambiguous end-of-record
 * marker, and the whole record structure is recoverable from a single scan with
 * no lookahead beyond the current record.
 *
 * The parser keeps a cursor (`pos`) into `buffer` and compacts lazily, so cost
 * is linear in bytes rather than quadratic in record length.
 *
 * @param {object} state
 * @param {(commit: object) => void} onCommit
 * @param {boolean} [flush] the stream has ended; consume any trailing partial
 */
export function drainHistory(state, onCommit, flush = false) {
  const buf = state.buffer;
  let pos = state.pos;

  for (;;) {
    if (!state.inFiles) {
      // ---- header state: find a record start ----
      const recAt = buf.indexOf(REC, pos);
      if (recAt === -1) {
        // Nothing usable can start before the next record marker.
        pos = buf.endsWith(REC) ? buf.length - 1 : buf.length;
        break;
      }
      if (recAt > pos) pos = recAt;

      // Five field separators follow, then the subject.
      let cursor = pos + 1;
      const fields = [];
      for (let i = 0; i < 5; i += 1) {
        const at = buf.indexOf(FLD, cursor);
        if (at === -1) {
          if (flush) {
            // Truncated final record: nothing usable remains.
            pos = buf.length;
            break;
          }
          break;
        }
        fields.push(buf.slice(cursor, at));
        cursor = at + 1;
      }
      if (fields.length < 5) break;

      // The subject is `%s`, which git defines as a single line and which can
      // never contain a NUL (git refuses to write one). So the subject ends at
      // the first `\n` or `\0` after it. Notably it is NOT terminated by \x01:
      // commit messages may legally contain \x01, and treating that as a record
      // boundary is how a naive parser silently loses commits.
      const tNewline = buf.indexOf('\n', cursor);
      const tNul = buf.indexOf('\0', cursor);
      let subjectEnd;
      if (tNewline !== -1 && (tNul === -1 || tNewline < tNul)) subjectEnd = tNewline;
      else if (tNul !== -1) subjectEnd = tNul;
      else {
        if (!flush) break;
        subjectEnd = buf.length;
      }
      if (subjectEnd < cursor) break;

      const subject = buf.slice(cursor, subjectEnd);
      const parents = fields[4].trim().split(/\s+/).filter(Boolean);
      state.header = {
        hash: fields[0],
        author: fields[1],
        email: fields[2],
        date: fields[3],
        merge: parents.length > 1,
        subject: sanitizeSubject(subject),
        files: [],
      };
      state.renameAdd = 0;
      state.renameDel = 0;
      state.renameOld = null;
      state.renameNew = null;
      state.awaitingRename = 0;
      state.inFiles = true;
      state.firstToken = true;
      // Step over the terminator that ended the subject. A `\0` here means the
      // commit had no file list at all (merge or empty commit) and is already
      // fully consumed, so emit straight away.
      pos = subjectEnd;
      if (buf[pos] === '\0') {
        onCommit(state.header);
        state.header = null;
        state.inFiles = false;
        pos += 1;
        continue;
      }
      pos += 1; // step over the newline that introduces the file list
      continue;
    }

    // ---- file state: read NUL-terminated tokens until an empty one ----
    const nulAt = buf.indexOf('\0', pos);
    if (nulAt === -1) {
      if (!flush) break;
      // Stream ended mid-token: commit what we have and close the record.
      const tail = buf.slice(pos);
      pos = buf.length;
      if (state.header) {
        if (state.firstToken && tail.startsWith('\n')) {
          consumeToken(state, state.header, tail.slice(1), onCommit);
        } else if (tail) {
          consumeToken(state, state.header, tail, onCommit);
        }
        onCommit(state.header);
        state.header = null;
      }
      state.inFiles = false;
      break;
    }

    let token = buf.slice(pos, nulAt);
    pos = nulAt + 1;
    if (state.firstToken) {
      state.firstToken = false;
      if (token.startsWith('\n')) token = token.slice(1);
      else if (token.startsWith('\r\n')) token = token.slice(2);
    }

    if (token === '') {
      // End-of-record terminator.
      if (state.header) {
        onCommit(state.header);
        state.header = null;
      }
      state.inFiles = false;
      continue;
    }
    consumeToken(state, state.header, token, onCommit);
  }

  // Lazy compaction keeps the buffer bounded without copying per token.
  if (pos > 0 && (pos > 4096 || pos * 2 > buf.length)) {
    state.buffer = buf.slice(pos);
    state.pos = 0;
  } else {
    state.buffer = buf;
    state.pos = pos;
  }
}

/**
 * Commit subjects and author names are attacker-controlled text. A raw \x01 in
 * a subject would otherwise be able to forge a record boundary, so any framing
 * character is neutralised before the value is stored.
 */
function sanitizeSubject(subject) {
  if (subject.indexOf('\x01') === -1 && subject.indexOf('\x02') === -1) return subject;
  return subject.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

/** Interpret one file token in either `--name-only` or `--numstat` mode. */
function consumeToken(state, header, token, onCommit) {
  if (token === '' || header === null) return;
  void onCommit;

  if (state.awaitingRename > 0) {
    if (state.awaitingRename === 2) state.renameOld = token;
    else state.renameNew = token;
    state.awaitingRename -= 1;
    if (state.awaitingRename === 0) {
      header.files.push({
        path: state.renameNew,
        oldPath: state.renameOld,
        add: state.renameAdd,
        del: state.renameDel,
        binary: state.renameAdd < 0,
        rename: true,
      });
    }
    return;
  }

  if (!token.includes('\t')) {
    // `--name-only` mode: the token is a bare path.
    header.files.push({ path: token, oldPath: null, add: 0, del: 0, binary: false, rename: false });
    return;
  }

  const firstTab = token.indexOf('\t');
  const secondTab = token.indexOf('\t', firstTab + 1);
  const addRaw = token.slice(0, firstTab);
  const delRaw = secondTab === -1 ? '' : token.slice(firstTab + 1, secondTab);
  const path = secondTab === -1 ? '' : token.slice(secondTab + 1);

  const add = addRaw === '-' ? -1 : Number.parseInt(addRaw, 10) || 0;
  const del = delRaw === '-' ? -1 : Number.parseInt(delRaw, 10) || 0;

  if (path === '') {
    state.renameAdd = add;
    state.renameDel = del;
    state.renameOld = null;
    state.renameNew = null;
    state.awaitingRename = 2;
    return;
  }

  header.files.push({ path, oldPath: null, add, del, binary: add < 0 || del < 0, rename: false });
}
