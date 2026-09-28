/**
 * Command-line interface.
 *
 * Argument parsing is hand-rolled rather than pulled from a dependency: the
 * surface is small, and owning it means the tool installs with nothing but
 * Node itself. Every flag has a documented default, and `--help` is generated
 * from the same table the parser uses, so the two can never disagree.
 */

import { resolve, relative, basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { discoverRepo, repoHead, commitCount } from './core/git.mjs';
import { collectFiles, scanRecords, buildIndex } from './core/workspace.mjs';
import { Cache, measurementFingerprint } from './core/cache.mjs';
import { History } from './analyze/history.mjs';
import { buildCoupling } from './analyze/coupling.mjs';
import { buildReport } from './analyze/report.mjs';
import { streamHistory } from './core/git.mjs';
import { detect } from './render/ansi.mjs';
import { Theme } from './render/theme.mjs';
import { renderReport, SECTIONS } from './render/report.mjs';
import { runInteractive } from './render/tui.mjs';
import { Progress } from './render/progress.mjs';
import { formatMs, formatInt } from './render/widgets.mjs';
import { VERSION } from './version.mjs';

/** @type {Array<{name: string, alias?: string, type: 'boolean'|'string'|'number', describe: string, default?: any}>} */
export const FLAGS = [
  { name: 'help', alias: 'h', type: 'boolean', describe: 'show this help' },
  { name: 'version', alias: 'V', type: 'boolean', describe: 'print version' },
  { name: 'repo', alias: 'C', type: 'string', describe: 'repository to analyse (default: cwd)' },
  { name: 'json', type: 'boolean', describe: 'emit the full report as JSON' },
  { name: 'tui', alias: 't', type: 'boolean', describe: 'interactive explorer' },
  { name: 'watch', alias: 'w', type: 'boolean', describe: 're-analyse when files change' },
  { name: 'since', type: 'string', describe: 'history window, e.g. 18.months.ago' },
  { name: 'all', type: 'boolean', describe: 'walk every ref instead of HEAD only' },
  { name: 'lines', type: 'boolean', describe: 'compute line-level churn (slower)' },
  { name: 'max-commits', type: 'number', describe: 'stop after N commits' },
  { name: 'top', type: 'number', describe: 'rows per section (default 20)' },
  { name: 'sections', type: 'string', describe: `comma list of: ${SECTIONS.join(',')}` },
  { name: 'lang', type: 'string', describe: 'restrict the analysis to one language' },
  { name: 'path', type: 'string', describe: 'restrict the analysis to a pathspec' },
  { name: 'include-untracked', type: 'boolean', describe: 'also scan untracked files' },
  { name: 'include-vendor', type: 'boolean', describe: 'do not skip vendored directories' },
  { name: 'no-cache', type: 'boolean', describe: 'ignore and do not write the cache' },
  { name: 'cache-dir', type: 'string', describe: 'override the cache directory' },
  { name: 'prune', type: 'boolean', describe: 'delete stale cache entries and exit' },
  { name: 'concurrency', type: 'number', describe: 'worker threads (0 = inline)' },
  { name: 'no-color', type: 'boolean', describe: 'disable colour' },
  { name: 'color', type: 'string', describe: 'auto | always | never' },
  { name: 'unicode', type: 'string', describe: 'auto | always | never' },
  { name: 'width', type: 'number', describe: 'force output width' },
  { name: 'profile', type: 'boolean', describe: 'print phase timings to stderr' },
  { name: 'quiet', alias: 'q', type: 'boolean', describe: 'suppress the progress indicator' },
  { name: 'fail-on', type: 'string', describe: 'exit 1 if health grade is at or below this letter' },
];

const ALIASES = new Map(FLAGS.filter((f) => f.alias).map((f) => [f.alias, f.name]));
const BY_NAME = new Map(FLAGS.map((f) => [f.name, f]));

/**
 * Parse argv into options. Unknown flags are an error rather than a silent
 * no-op: a typo in a metric tool should never quietly change what you measure.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      options._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      options._.push(token);
      continue;
    }
    let name;
    let inlineValue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      const letters = token.slice(1);
      name = ALIASES.get(letters[0]) ?? letters[0];
      if (letters.length > 1) inlineValue = letters.slice(1);
    }

    const flag = BY_NAME.get(name);
    if (!flag) {
      const suggestion = suggest(name);
      throw new UsageError(`unknown option ${token.startsWith('--') ? '--' : '-'}${name}${suggestion}`);
    }
    if (flag.type === 'boolean') {
      if (inlineValue !== undefined) options[flag.name] = inlineValue !== 'false' && inlineValue !== '0';
      else options[flag.name] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined || (inlineValue === undefined && value.startsWith('-') && value !== '-')) {
      throw new UsageError(`option --${flag.name} needs a value`);
    }
    if (flag.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new UsageError(`option --${flag.name} needs a number, got ${JSON.stringify(value)}`);
      options[flag.name] = parsed;
    } else {
      options[flag.name] = value;
    }
  }
  return options;
}

class UsageError extends Error {}

function suggest(name) {
  const candidates = FLAGS.map((f) => f.name).filter((f) => f.startsWith(name[0] ?? ''));
  if (candidates.length === 0 || candidates.length > 3) return '';
  return `\n  did you mean: ${candidates.map((c) => `--${c}`).join(', ')}?`;
}

/** Render `--help` from the flag table. */
export function helpText() {
  const lines = [];
  lines.push(`${'oc'} ${VERSION} ${theme0()}`);
  lines.push('');
  lines.push('  A terminal intelligence tool for git repositories.');
  lines.push('  Zero dependencies, one binary, no telemetry, no network access.');
  lines.push('');
  lines.push('USAGE');
  lines.push('  oc [path] [options]');
  lines.push('');
  lines.push('  path            directory inside the repository to analyse (default: cwd)');
  lines.push('');
  lines.push('OPTIONS');
  const labelWidth = Math.max(...FLAGS.map((f) => flagLabel(f).length)) + 2;
  for (const flag of FLAGS) {
    const label = flagLabel(flag);
    lines.push(`  ${label.padEnd(labelWidth)}${flag.describe}`);
  }
  lines.push('');
  lines.push('EXAMPLES');
  lines.push('  oc                          analyse the repository containing cwd');
  lines.push('  oc ../other-repo            analyse another repository');
  lines.push('  oc --tui                    open the interactive explorer');
  lines.push('  oc --json | jq .health     machine-readable output');
  lines.push('  oc --since 6.months.ago     look at recent history only');
  lines.push('  oc --lang python            restrict the analysis to one language');
  lines.push('  oc --no-color > report.txt  plain output for a file');
  lines.push('');
  lines.push('EXIT CODES');
  lines.push('  0  success');
  lines.push('  1  a runtime error, or --fail-on was not met');
  lines.push('  2  usage error');
  lines.push('');
  return lines.join('\n');
}

function flagLabel(flag) {
  const alias = flag.alias ? `-${flag.alias}, ` : '    ';
  const value = flag.type === 'boolean' ? '' : ` <${flag.type === 'number' ? 'n' : 'value'}>`;
  return `${alias}--${flag.name}${value}`;
}

function theme0() {
  return '— repository intelligence';
}

/**
 * Main entry point.
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, env?: object, cwd?: string}} [io]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`oc: ${error.message}\n`);
    return 2;
  }

  if (options.help) {
    stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  const cache = new Cache({
    enabled: !options['no-cache'],
    dir: options['cache-dir'],
    version: VERSION,
    fingerprint: await measurementFingerprint(),
  });

  if (options.prune) {
    const removed = await cache.prune();
    stdout.write(`removed ${removed} stale cache shard${removed === 1 ? '' : 's'} from ${cache.dir}\n`);
    return 0;
  }

  const start = process.hrtime.bigint();
  const phases = {};
  const mark = (name) => {
    const now = process.hrtime.bigint();
    phases[name] = Number(now - start) / 1e6;
  };

  // Progress goes to stderr so that `oc --json | jq` and `oc > report.txt` stay
  // byte-for-byte clean.
  const progress = new Progress({
    stream: stderr,
    enabled: stderr.isTTY === true && !options.json && !options.quiet,
    unicode: detect({ stream: stderr, env }).unicode,
    width: stderr.columns ?? 80,
    verbose: options.profile === true,
  });

  const target = options.repo ?? options._[0] ?? cwd;
  const found = await discoverRepo(resolve(cwd, target));
  if (!found) {
    stderr.write(`oc: not a git repository: ${resolve(cwd, target)}\n`);
    stderr.write('    run this from inside a repository, or pass a path with -C\n');
    return 1;
  }

  const head = await repoHead(found.root);
  if (!head.hash) {
    const { records } = await collectFiles({ root: found.root, includeUntracked: true });
    if (records.length === 0) {
      stderr.write('oc: this repository has no commits and no files yet.\n');
      stderr.write('    make a commit, then run oc again\n');
      return 1;
    }
  }

  let report;
  try {
    report = await analyse({ found, head, options, cache, mark, progress });
  } finally {
    progress.stop();
  }
  mark('report');

  if (options.watch) {
    return runWatch({ found, head, options, cache, stdout, stderr, caps, progress });
  }

  const caps = detect({
    stream: stdout,
    env,
    color: options['no-color'] ? 'never' : options.color,
    unicode: options.unicode,
    width: options.width,
  });
  const capsRef = caps;
  const theme = new Theme(caps.depth, caps.unicode);
  const meta = {
    repoName: basename(found.root) || found.root,
    root: relative(cwd, found.root) || '.',
    branch: head.branch,
    head: head.hash,
    elapsed: phases.report,
    cacheHitRate: report.meta.cacheHitRate,
    mode: options.lines ? 'full history + line churn' : 'full history',
    window: options.since ?? 'all time',
  };
  if (report.history.partial) {
    meta.windowNote = `partial history: ${report.history.partialReason ?? 'windowed'}`;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(toJson(report, meta), null, 2)}\n`);
  } else if (options.tui) {
    if (!caps.isTTY) {
      stderr.write('oc: --tui needs an interactive terminal; falling back to the static report\n');
      stdout.write(`${renderReport(report, { theme, width: caps.width, meta, limit: options.top })}\n`);
    } else {
      return runInteractive({ report, theme, caps, meta });
    }
  } else {
    const sections = options.sections ? options.sections.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    if (sections) {
      for (const name of sections) {
        if (!SECTIONS.includes(name)) {
          stderr.write(`oc: unknown section ${JSON.stringify(name)}. known: ${SECTIONS.join(', ')}\n`);
          return 2;
        }
      }
    }
    stdout.write(`${renderReport(report, { theme, width: caps.width, meta, limit: options.top, sections })}\n`);
  }

  if (options.profile) {
    const entries = Object.entries(phases).sort((a, b) => a[1] - b[1]);
    stderr.write(`\nphases${theme0()}\n`);
    for (const [name, ms] of entries) {
      stderr.write(`  ${name.padEnd(12)} ${formatMs(ms).padStart(8)}\n`);
    }
  }

  if (options['fail-on']) {
    const target = String(options['fail-on']).toUpperCase().charAt(0);
    const order = { A: 5, B: 4, C: 3, D: 2, E: 1 };
    if (!(target in order)) {
      stderr.write('oc: --fail-on expects a grade letter A-E\n');
      return 2;
    }
    const current = { A: 5, B: 4, C: 3, D: 2, E: 1 }[report.health.grade] ?? 0;
    if (current <= order[target]) {
      stderr.write(`oc: health grade ${report.health.grade} is at or below ${target}\n`);
      return 1;
    }
  }

  void cwd;
  return 0;
}

/**
 * Re-run the analysis whenever the working tree changes.
 *
 * Uses git's own index mtime as the change signal rather than a filesystem
 * watcher: a 13k-file repository watched with `fs.watch` produces a stream of
 * events that coalesce badly and re-analyse many times for one edit, whereas the
 * index file is written exactly once per index-changing operation.
 */
async function runWatch({ found, head, options, cache, stdout, stderr, caps, progress }) {
  const indexPath = join(found.root, '.git', 'index');
  const theme = new Theme(caps.depth, caps.unicode);
  const width = caps.width;

  let lastIndex = await statSafe(indexPath);
  let running = false;
  let queued = false;
  let closed = false;
  let timer = null;

  const emit = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const started = Date.now();
    try {
      const report = await analyse({ found, head, options, cache, progress });
      const meta = {
        repoName: basename(found.root) || found.root,
        root: '.',
        branch: head.branch,
        head: head.hash,
        elapsed: Date.now() - started,
        cacheHitRate: report.meta.cacheHitRate,
        mode: options.lines ? 'full history + line churn' : 'full history',
        window: options.since ?? 'all time',
      };
      const text = renderReport(report, { theme, width, meta, limit: options.top });
      if (caps.isTTY) {
        // Clear and redraw so the terminal does not fill with scrollback.
        stdout.write(`\x1b[2J\x1b[H${text}\n`);
      } else {
        stdout.write(`${text}\n`);
      }
    } catch (error) {
      stderr.write(`oc: ${error?.message ?? error}\n`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await emit();
      }
    }
  };

  await emit();

  const check = async () => {
    if (closed) return;
    const current = await statSafe(indexPath);
    if (current !== lastIndex) {
      lastIndex = current;
      // Debounce: a checkout or a rebase writes the index repeatedly.
      clearTimeout(timer);
      timer = setTimeout(emit, 250);
      if (timer.unref) timer.unref();
    }
    if (!closed) poll = setTimeout(check, 750);
    if (poll.unref) poll.unref();
  };
  let poll = setTimeout(check, 750);
  if (poll.unref) poll.unref();

  stderr.write(`\noc: watching ${found.root} for changes (ctrl-c to stop)\n`);

  return new Promise((resolve) => {
    const stop = () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(poll);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function statSafe(path) {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'none';
  }
}

/**
 * Run the full pipeline. Split out from `main` so tests can call it directly
 * with a fixture repository and assert on the report.
 */
export async function analyse({ found, head, options = {}, cache, mark = () => {}, progress = null }) {
  const root = found.root;
  const effectiveCache = cache ?? new Cache({
    enabled: false,
    version: VERSION,
    fingerprint: await measurementFingerprint(),
  });

  progress?.begin('collect', 'scanning', 0);
  // With no commits yet, `git ls-files` is empty and the report would claim
  // "0 files" while the working tree is full of them. That is exactly the state
  // of a repository between `git init` and the first commit, so fall back to
  // what is actually on disk.
  const hasCommits = Boolean(head?.hash);
  const { records, skipped } = await collectFiles({
    root,
    includeUntracked: options['include-untracked'] ?? !hasCommits,
    pathspec: options.path ? [options.path] : [],
    includeVendor: options['include-vendor'] ?? false,
  });
  mark('collect');
  progress?.end(`${records.length} files`);

  // Language filter runs before scanning so filtered-out files cost nothing.
  const filtered = options.lang
    ? records.filter((r) => (r.language ?? '').toLowerCase() === String(options.lang).toLowerCase())
    : records;
  mark('filter');

  progress?.begin('scan', 'reading', filtered.length);
  const scan = await scanRecords({
    records: filtered,
    cache: effectiveCache,
    concurrency: options.concurrency,
    onProgress: (done, total) => progress?.update(done, `${formatInt(done)}/${formatInt(total)}`),
  });
  mark('scan');
  progress?.end(
    scan.hits > 0 ? `${scan.hits} cached, ${scan.scanned} measured` : `${scan.scanned} measured`,
  );

  const index = buildIndex(filtered);

  const history = new History({ includeLines: Boolean(options.lines) });
  const total = await commitCount(root);
  const mode = options.lines ? 'lines' : 'names';
  let scannedCommits = 0;

  if (options.since || options.maxCommits || options['max-commits']) {
    // A bounded window is explicitly partial; say so rather than implying we
    // saw everything.
    history.markPartial('windowed by --since/--max-commits');
  } else if (!hasCommits) {
    history.markPartial('repository has no commits yet');
  }
  progress?.begin('history', 'history', 0);
  const historyResult = await streamHistory(
    {
      cwd: root,
      mode,
      all: options.all !== false,
      since: options.since,
      maxCommits: options['max-commits'],
      pathspec: options.path ? [options.path] : [],
      renames: options.lines,
    },
    (commit) => {
      scannedCommits += 1;
      history.add(commit);
      if ((scannedCommits & 0x3ff) === 0) {
        progress?.update(scannedCommits, `${formatInt(scannedCommits)} commits`);
      }
    },
    (bytes) => progress?.update(null, `${(bytes / 1048576).toFixed(0)} MB of history`),
  );
  mark('history');
  void historyResult;
  progress?.end(`${formatInt(scannedCommits)} commits`);

  progress?.begin('coupling', 'dependencies', 0);
  const coupling = await buildCoupling({ records: filtered, index, root });
  mark('coupling');
  progress?.end(`${coupling.cycles.length} cycles`);

  history.finalize(new Set(filtered.map((r) => r.rel)));

  progress?.begin('analyse', 'scoring', 0);
  const report = buildReport({
    records: filtered,
    history,
    coupling,
    limit: options.top ?? 20,
  });
  mark('analyse');
  progress?.end(`health ${report.health.grade}`);

  const after = effectiveCache.stats();
  report.meta = {
    ...report.meta,
    cacheHitRate: after.hits + after.misses === 0 ? 0 : after.hits / (after.hits + after.misses),
    cache: after,
    scannedCommits,
    totalCommits: total,
    skipped,
    cacheHits: scan.hits,
    filesScanned: scan.scanned,
    head: head?.hash ?? null,
  };
  return report;
}

/** JSON projection. Drops the internal per-file signal array to keep it usable. */
export function toJson(report, meta) {
  return {
    meta: { ...meta, version: VERSION },
    health: report.health,
    totals: report.totals,
    languages: report.languages,
    history: report.history,
    tests: report.tests,
    debt: { byType: report.debt.byType, total: report.debt.total, oldest: report.debt.oldest, suppressed: report.debt.suppressed },
    ownership: {
      busFactor: report.ownership.busFactor,
      total: report.ownership.total,
      authors: report.ownership.authors,
      singleOwnerCount: report.ownership.singleOwnerCount,
    },
    structure: {
      cycles: report.coupling.cycles,
      cycleFileCount: report.coupling.cycleFileCount,
      undeclared: report.coupling.undeclared,
      unused: report.coupling.unused,
      externals: report.coupling.externals,
    },
    timeline: report.timeline,
    hotspots: report.hotspots.map((s) => ({
      path: s.record.rel,
      risk: Math.round(s.risk),
      commits: s.commits,
      complexity: s.complexity,
      perFunction: Number(s.perFunction.toFixed(2)),
      depth: s.shape.depth,
      functions: s.funcs,
      code: s.code,
      debt: s.debt,
      authors: s.authors,
      fanIn: s.fanIn,
      fanOut: s.fanOut,
      tested: s.isTested,
      inCycle: s.inCycle,
      reasons: s.reasons.map((r) => ({ key: r.key, points: Number(r.contribution.toFixed(1)) })),
    })),
  };
}

export { UsageError, formatInt, SECTIONS };
