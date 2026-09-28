/**
 * Static report rendering.
 *
 * The output is a fixed document: same repository, same options, same bytes.
 * It is built as an array of lines and joined once, so a caller can measure it,
 * wrap it, diff it or pipe it without any of that leaking into layout code.
 */

import {
  rule, section, barRow, meter, statRow, statGrid, sparkline, stackedBar, legend,
  table, boxed, formatCount, formatInt, formatBytes, formatDuration, formatPercent,
  formatDay, formatMs, pad, truncate, truncatePath, width, heatBar, bar,
} from './widgets.mjs';
import { Theme } from './theme.mjs';
import { RISK_WEIGHTS } from '../analyze/report.mjs';

const REASON_LABELS = {
  churn: 'churn',
  complexity: 'complexity',
  size: 'size',
  debt: 'debt',
  ownership: 'single-owner',
  blastRadius: 'blast radius',
  untested: 'untested',
  suppression: 'suppressed',
};

/**
 * @param {object} report
 * @param {object} options
 * @param {Theme} [options.theme]
 * @param {number} [options.width]
 * @param {object} [options.meta] repo identity and scan metadata
 * @param {string[]} [options.sections] subset to render, in order
 * @returns {string}
 */
export function renderReport(report, options = {}) {
  const theme = options.theme ?? new Theme(0, true);
  const W = options.width ?? 100;
  const meta = options.meta ?? {};
  const wanted = new Set(options.sections ?? SECTIONS);
  const lines = [];
  const out = (...values) => lines.push(...values);

  const limit = options.limit ?? report.hotspots.length;

  if (wanted.has('header')) out(...renderHeader(theme, W, report, meta));

  if (wanted.has('health')) out(...renderHealth(theme, W, report));

  if (wanted.has('activity')) out(...renderActivity(theme, W, report));

  if (wanted.has('glance')) out(...renderGlance(theme, W, report));

  if (wanted.has('hotspots')) out(...renderHotspots(theme, W, report, limit));

  if (wanted.has('ownership')) out(...renderOwnership(theme, W, report, limit));

  if (wanted.has('structure')) out(...renderStructure(theme, W, report, limit));

  if (wanted.has('debt')) out(...renderDebt(theme, W, report, limit));

  if (wanted.has('tests')) out(...renderTests(theme, W, report, limit));

  if (wanted.has('footer')) out(...renderFooter(theme, W, report, meta));

  return lines.join('\n');
}

/** Components larger than this are reported as clusters, not as fixable cycles. */
const CLUSTER_THRESHOLD = 8;

const SECTIONS = ['header', 'health', 'activity', 'glance', 'hotspots', 'ownership', 'structure', 'debt', 'tests', 'footer'];

// ---------------------------------------------------------------------------

function renderHeader(theme, W, report, meta) {
  const out = [];
  const name = meta.repoName ?? 'repository';
  const title = `  ${theme.c('brand', theme.bold('oc'))}  ${theme.c('text', theme.bold(name))}`;

  const facts = [];
  if (meta.branch) facts.push(meta.branch);
  if (report.history.commits) facts.push(`${formatInt(report.history.commits)} commits`);
  if (report.history.authors) facts.push(`${formatInt(report.history.authors)} authors`);
  if (report.history.spanDays > 0) facts.push(`${formatDuration(report.history.spanDays)} of history`);

  // Facts are dropped from the left until the header fits: on a narrow terminal
  // the repository name matters more than the contributor count.
  let right = '';
  let list = facts;
  while (list.length > 0) {
    right = theme.c('faint', list.join(theme.g.mid));
    if (width(title) + 2 + width(right) <= W) break;
    list = list.slice(1);
    right = '';
  }
  const gap = Math.max(2, W - width(title) - width(right));
  out.push('');
  out.push(truncate(title + ' '.repeat(gap) + right, W, theme.g.ellipsis));
  out.push(theme.c('rule', theme.g.h.repeat(W)));

  const pathLine = [];
  if (meta.root) pathLine.push(theme.c('faint', meta.root));
  if (meta.head) pathLine.push(theme.c('faint', `${theme.g.mid} ${String(meta.head).slice(0, 8)}`));
  if (meta.window) pathLine.push(theme.c('faint', `${theme.g.mid} window ${meta.window}`));
  if (meta.windowNote) pathLine.push(theme.c('warn', `${theme.g.mid} ${meta.windowNote}`));
  out.push(joinLine(pathLine, W, theme));
  out.push('');
  return out;
}

function joinLine(parts, W, theme) {
  const line = parts.filter(Boolean).join('');
  return truncate(line, W, theme.g.ellipsis);
}

function renderHealth(theme, W, report) {
  const { health } = report;
  const out = [''];
  out.push(
    section(theme, W, 'HEALTH', `${health.grade}  ${health.value}/100`),
  );
  const labelWidth = Math.min(22, Math.max(14, Math.floor(W * 0.2)));
  for (const component of health.components) {
    out.push('  ' + meter(theme, W - 4, {
      label: component.label,
      labelWidth,
      value: component.value / 100,
      detail: component.detail,
    }));
  }
  out.push('');
  return out;
}

function renderActivity(theme, W, report) {
  const { timeline } = report;
  if (!timeline || timeline.months.length === 0) return [];
  const out = [''];
  const peak = timeline.months.reduce((best, m) => (m.commits > best.commits ? m : best), timeline.months[0]);
  const context = [];
  if (peak && peak.commits > 0) context.push(`peak ${formatInt(peak.commits)} in ${peak.month}`);
  context.push(`last ${timeline.months.length} months`);
  out.push(section(theme, W, 'ACTIVITY', context.join(theme.g.mid)));

  const chartWidth = Math.max(20, W - 6);
  const spark = sparkline(theme, timeline.months.map((m) => m.commits), chartWidth);
  out.push('  ' + spark);

  const first = theme.c('faint', timeline.months[0].month);
  const last = theme.c('faint', timeline.months[timeline.months.length - 1].month);
  // The right-hand label has to come out of the same budget as the chart, or
  // the row is exactly as wide as the chart plus the label.
  out.push('  ' + pad(first, Math.max(0, W - 2 - width(last))) + last);

  // A second, dimmer row for distinct contributors shows whether activity is
  // broadening or narrowing -- a single sparkline cannot tell you that.
  if (timeline.months.some((m) => m.authors > 0)) {
    out.push('  ' + theme.c('faint', `contributors ${sparkline(theme, timeline.months.map((m) => m.authors), chartWidth)}`));
  }
  out.push('');
  return out;
}

function renderGlance(theme, W, report) {
  const { totals, languages, tests, debt, coupling, ownership } = report;
  const out = [''];
  out.push(section(theme, W, 'AT A GLANCE'));

  const stats = [
    { value: formatCount(totals.files), label: 'files' },
    { value: formatCount(totals.code), label: 'code lines' },
    { value: formatPercent(tests.ratio), label: 'test reach' },
    { value: formatCount(languages.length), label: 'languages' },
    { value: formatCount(report.history.authors), label: 'contributors' },
    { value: formatCount(debt.total), label: 'debt markers' },
    { value: String(ownership.busFactor), label: 'bus factor' },
    { value: formatCount(coupling.cycles.length), label: 'import cycles' },
    { value: formatBytes(totals.bytes), label: 'source size' },
    { value: formatCount(report.history.commits), label: 'commits' },
    { value: formatCount(coupling.externalCount), label: 'dependencies' },
    { value: formatCount(totals.suppressed), label: 'suppressions' },
  ];
  const columns = W >= 110 ? 4 : W >= 80 ? 3 : 2;
  out.push(...statGrid(theme, W - 2, stats, columns).map((line) => '  ' + line));

  // Composition bar: what the codebase is actually made of.
  if (totals.lines > 0) {
    out.push('');
    out.push('  ' + stackedBar(theme, W - 4, [
      { value: totals.code, color: 'brand', label: 'code' },
      { value: totals.comment, color: 'info', label: 'comment' },
      { value: totals.blank, color: 'rule', label: 'blank' },
    ]));
    out.push('  ' + legend(theme, W - 4, [
      { value: totals.code, color: 'brand', label: 'code' },
      { value: totals.comment, color: 'info', label: 'comment' },
      { value: totals.blank, color: 'rule', label: 'blank' },
    ]).join('\n  '));
  }

  out.push('');
  return out;
}

function renderHotspots(theme, W, report, limit) {
  const { hotspots } = report;
  if (hotspots.length === 0) return [];
  const out = [''];
  out.push(section(theme, W, 'HOT SPOTS', `top ${hotspots.length} by composite risk`));
  out.push('');

  // Column budget: path first (it is the identifier), numbers after.
  const narrow = W < 92;
  const riskW = 4;
  const churnW = 6;
  const cxW = 6;
  const sizeW = 6;
  const ownerW = narrow ? 0 : 12;
  const gaps = narrow ? 1 : 2;
  const used = riskW + churnW + cxW + sizeW + (narrow ? 0 : ownerW) + gaps * (narrow ? 4 : 5);
  const pathW = Math.max(24, W - 4 - used);

  const header = [
    pad(theme.c('faint', 'risk'), riskW, 'right'),
    pad(theme.c('faint', 'churn'), churnW, 'right'),
    pad(theme.c('faint', 'cx/fn'), cxW, 'right'),
    pad(theme.c('faint', 'lines'), sizeW, 'right'),
    ...(narrow ? [] : [pad(theme.c('faint', 'owner'), ownerW)]),
    theme.c('faint', 'file'),
  ].join(' '.repeat(gaps));
  out.push('  ' + header);
  out.push('  ' + theme.c('rule', theme.g.h.repeat(Math.min(W - 4, used + pathW))));

  for (const spot of hotspots) {
    const riskColor = spot.risk >= 70 ? 'critical' : spot.risk >= 50 ? 'bad' : spot.risk >= 30 ? 'warn' : 'ok';
    const cells = [
      pad(theme.score(spot.risk, String(Math.round(spot.risk))), riskW, 'right'),
      pad(theme.c('text', formatCount(spot.commits)), churnW, 'right'),
      pad(theme.c(spot.perFunction > 10 ? 'bad' : spot.perFunction > 5 ? 'warn' : 'muted', spot.perFunction.toFixed(1)), cxW, 'right'),
      pad(theme.c('muted', formatCount(spot.code)), sizeW, 'right'),
    ];
    if (!narrow) {
      const owner = ownerLabel(report, spot);
      cells.push(pad(theme.c(spot.authors <= 1 ? 'warn' : 'muted', owner), ownerW));
    }
    const path = theme.c(pathColor(spot), truncatePath(spot.record.rel, pathW));
    out.push('  ' + cells.join(' '.repeat(gaps)) + gaps + path);
    if (!narrow && W >= 100) {
      const why = spot.reasons.slice(0, 3).map((r) => `${REASON_LABELS[r.key] ?? r.key} ${r.contribution.toFixed(0)}`).join(theme.g.mid);
      out.push(' '.repeat(4 + used + gaps) + theme.c('faint', why));
    }
  }

  out.push('');
  return out;
}

function pathColor(spot) {
  if (spot.risk >= 70) return 'critical';
  if (spot.risk >= 50) return 'bad';
  if (spot.risk >= 30) return 'warn';
  return 'text';
}

function ownerLabel(report, spot) {
  if (spot.authors <= 0) return '-';
  if (spot.authors === 1) {
    const author = report.ownership.authors.find((a) => a.key === spot.lastAuthor);
    return author ? author.name : 'unknown';
  }
  return `${spot.authors} people`;
}

function renderOwnership(theme, W, report, limit) {
  const { ownership } = report;
  if (ownership.authors.length === 0) return [];
  const out = [''];
  out.push(section(theme, W, 'OWNERSHIP', `${formatInt(ownership.total)} contributors · bus factor ${ownership.busFactor}`));
  out.push('');

  const barCells = Math.max(8, Math.min(24, Math.floor(W * 0.2)));
  const nameW = Math.max(16, Math.floor(W * 0.28));
  const maxCommits = ownership.authors[0]?.commits ?? 1;

  out.push('  ' + pad(theme.c('faint', 'contributor'), nameW)
    + ' ' + pad(theme.c('faint', 'commits'), 8, 'right')
    + ' ' + pad(theme.c('faint', 'share'), 7, 'right')
    + '  ' + barCells
    + (W >= 90 ? '  ' + pad(theme.c('faint', 'last seen'), 12, 'right') : ''));

  const shown = ownership.authors.slice(0, Math.min(limit, 15));
  for (const author of shown) {
    const share = report.history.commits > 0 ? author.commits / report.history.commits : 0;
    const nameColor = author.lastActive <= 180 ? 'text' : author.lastActive <= 365 ? 'muted' : 'faint';
    let line = '  ' + pad(theme.c(nameColor, truncate(author.name, nameW)), nameW)
      + ' ' + pad(theme.c('text', formatInt(author.commits)), 8, 'right')
      + ' ' + pad(theme.c('faint', formatPercent(share, 1)), 7, 'right')
      + '  ' + bar(theme, author.commits, maxCommits, barCells, 'brand');
    if (W >= 90) {
      const seen = author.lastDay ? formatDuration(report.today - author.lastDay) : 'unknown';
      line += '  ' + pad(theme.c(author.lastActive <= 180 ? 'muted' : 'faint', seen), 12, 'right');
    }
    out.push(line);
  }

  if (ownership.singleOwnerCount > 0) {
    out.push('');
    out.push('  ' + theme.c('warn', `${theme.g.warnMark} `)
      + theme.c('text', `${ownership.singleOwnerCount} files`)
      + theme.c('muted', ' have a single historical author'));
    out.push('  ' + truncate(theme.c('faint', 'Knowledge that exists in exactly one person is the most expensive kind.'), W - 2, theme.g.ellipsis));
  }
  if (ownership.orphanFiles.length > 0) {
    out.push('  ' + theme.c('faint', `${theme.g.mid} ${ownership.orphanFiles.length} large source files have no recorded history in this window`));
  }
  out.push('');
  return out;
}

function renderStructure(theme, W, report, limit) {
  const { coupling } = report;
  const out = [''];
  out.push(section(theme, W, 'STRUCTURE'));
  out.push('');

  if (coupling.cycles.length > 0) {
    // Split the components by whether a reader could act on them. A two-file
    // cycle is a bug report; a four-hundred-file component is an architectural
    // property of a package layout, and printing five arbitrary members of it
    // under the heading "cycle" would be misleading rather than useful.
    const small = coupling.cycles.filter((c) => c.length <= CLUSTER_THRESHOLD);
    const clusters = coupling.cycles.filter((c) => c.length > CLUSTER_THRESHOLD)
      .sort((a, b) => b.length - a.length);

    out.push('  ' + theme.c('bad', `${theme.g.warnMark} ${coupling.cycles.length} import cycles`)
      + theme.c('muted', ` touching ${coupling.cycleFileCount} files`));
    out.push('');

    for (const component of small.slice(0, Math.min(4, limit))) {
      out.push('    ' + theme.c('bad', theme.bold(`cycle of ${component.length}`)));
      for (const path of component) {
        out.push('      ' + theme.c('muted', theme.g.tree) + ' ' + theme.c('text', truncatePath(path, W - 10, theme.g.ellipsis)));
      }
    }
    if (small.length > 4) {
      out.push('    ' + theme.c('faint', `${theme.g.mid} ${small.length - 4} more small cycles`));
    }

    for (const cluster of clusters.slice(0, 2)) {
      out.push('');
      out.push('    ' + theme.c('warn', theme.bold(`${cluster.length} files form one dependency cluster`)));
      out.push('      ' + theme.c('faint', 'Mutually reachable, so nothing here can be extracted in isolation.'));
      out.push('      ' + theme.c('faint', 'Most depended upon inside the cluster:'));
      const inside = new Set(cluster);
      const ranked = cluster
        .map((path) => [path, coupling.fanIn.get(path) ?? 0])
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);
      for (const [path, count] of ranked) {
        out.push('        ' + theme.c('muted', theme.g.tree) + ' '
          + theme.c('text', truncatePath(path, W - 24, theme.g.ellipsis))
          + theme.c('faint', `  ${count} in-cluster importers`));
      }
      void inside;
    }
    if (clusters.length > 2) {
      out.push('    ' + theme.c('faint', `${theme.g.mid} ${clusters.length - 2} more clusters`));
    }
    out.push('');
  } else {
    out.push('  ' + theme.c('good', `${theme.g.check} no import cycles detected`));
    out.push('');
  }

  // Blast radius: the files whose breakage breaks the most things.
  const hot = [...coupling.fanIn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(10, limit));
  if (hot.length > 0) {
    out.push('  ' + theme.c('text', theme.bold('Highest blast radius'))
      + theme.c('faint', `  ${theme.g.mid} files most depended upon`));
    const nameW = Math.max(24, W - 40);
    const maxIn = hot[0][1];
    for (const [path, count] of hot) {
      out.push('    ' + barRow(theme, {
        label: path,
        labelWidth: nameW,
        path: true,
        value: count,
        max: maxIn,
        valueText: `${count} importers`,
        valueColor: count > 30 ? 'warn' : 'muted',
        colorName: 'accent',
        totalWidth: W,
        indent: 4,
        minBar: 6,
      }));
    }
    out.push('');
  }

  if (coupling.undeclared.length > 0) {
    out.push('  ' + theme.c('warn', `${theme.g.warnMark} ${coupling.undeclared.length} imported packages are not declared in any manifest`));
    for (const entry of coupling.undeclared.slice(0, 8)) {
      out.push('    ' + theme.c('text', entry.name)
        + theme.c('faint', `  ${entry.importers} importer${entry.importers === 1 ? '' : 's'}`));
    }
    out.push('');
  }
  if (coupling.unused.length > 0) {
    out.push('  ' + theme.c('faint', `${theme.g.mid} ${coupling.unused.length} declared dependencies are never imported`));
    out.push('    ' + theme.c('faint', truncate(coupling.unused.join(', '), W - 6)));
    out.push('');
  }
  return out;
}

function renderDebt(theme, W, report, limit) {
  const { debt } = report;
  if (debt.total === 0) {
    const out = [''];
    out.push(section(theme, W, 'DEBT'));
    out.push('  ' + theme.c('good', `${theme.g.check} no TODO-style markers found`));
    out.push('');
    return out;
  }
  const out = [''];
  const debtContext = debt.suppressed > 0
    ? ` ${theme.g.mid} ${formatInt(debt.suppressed)} suppressions`
    : '';
  out.push(section(theme, W, 'DEBT', `${formatInt(debt.total)} markers${debtContext}`));
  out.push('');

  const markerW = 14;
  const barCells = Math.max(6, Math.min(18, Math.floor(W * 0.16)));
  const maxCount = debt.byType[0]?.count ?? 1;
  for (const entry of debt.byType.slice(0, 10)) {
    out.push('  ' + barRow(theme, {
      label: entry.marker,
      labelWidth: markerW,
      value: entry.count,
      max: maxCount,
      valueText: formatInt(entry.count),
      valueColor: 'text',
      colorName: entry.weight >= 3 ? 'warn' : 'accent',
      totalWidth: W,
      indent: 2,
      note: `${entry.files} files`,
      minBar: 6,
    }));
  }

  if (debt.oldest) {
    out.push('');
    out.push('  ' + theme.c('text', theme.bold('Oldest untouched debt'))
      + theme.c('faint', `  ${theme.g.mid} in a file untouched for ${formatDuration(debt.oldest.daysSince)}`));
    out.push('    ' + theme.c('muted', truncatePath(debt.oldest.rel, W - 12))
      + theme.c('faint', `:${debt.oldest.line}`));
    out.push('    ' + theme.c(debt.oldest.marker === 'FIXME' ? 'bad' : 'warn', `${debt.oldest.marker} `)
      + theme.c('text', truncate(debt.oldest.text, W - 14, theme.g.ellipsis)));
  }
  out.push('');
  return out;
}

function renderTests(theme, W, report, limit) {
  const { tests, hotspots } = report;
  const out = [''];
  const reached = tests.sourceFiles === 0
    ? 'no source files'
    : `${formatInt(tests.covered)}/${formatInt(tests.sourceFiles)} source files reached by a test`;
  out.push(section(theme, W, 'TESTS', reached));
  out.push('');

  if (tests.byDirectory.length > 0) {
    const nameW = Math.max(20, W - 46);
    out.push('  ' + theme.c('text', theme.bold('Least-covered areas')));
    const worst = tests.byDirectory.filter((d) => d.tests === 0).slice(0, Math.min(10, limit));
    const list = worst.length > 0 ? worst : tests.byDirectory.slice(0, Math.min(6, limit));
    const maxCode = list.reduce((m, d) => Math.max(m, d.code), 0) || 1;
    for (const dir of list) {
      out.push('    ' + barRow(theme, {
        label: dir.dir,
        labelWidth: nameW,
        value: dir.code,
        max: maxCode,
        valueText: `${formatPercent(dir.ratio)} covered`,
        valueColor: dir.ratio === 0 ? 'bad' : dir.ratio < 0.4 ? 'warn' : 'muted',
        colorName: dir.tests === 0 ? 'bad' : 'accent',
        totalWidth: W,
        indent: 4,
        note: `${formatCount(dir.code)} lines`,
        minBar: 6,
      }));
    }
  }

  const untestedHot = hotspots.filter((s) => !s.isTested && !s.isTest && s.commits > 3).slice(0, 6);
  if (untestedHot.length > 0) {
    out.push('');
    out.push('  ' + theme.c('warn', `${theme.g.warnMark} Most-changed files with no test reaching them`));
    for (const spot of untestedHot) {
      out.push('    ' + pad(theme.c('text', truncatePath(spot.record.rel, W - 20)), W - 20)
        + theme.c('faint', `${spot.commits} changes`));
    }
  }
  out.push('');
  return out;
}

function renderFooter(theme, W, report, meta) {
  const out = [''];
  out.push(theme.c('rule', theme.g.h.repeat(W)));
  const bits = [];
  if (meta.elapsed) bits.push(`${theme.c('faint', 'scanned in ')}${theme.c('muted', formatMs(meta.elapsed))}`);
  if (meta.cacheHitRate !== undefined) {
    bits.push(`${theme.c('faint', 'cache ')}${theme.c(meta.cacheHitRate > 0.5 ? 'good' : 'muted', formatPercent(meta.cacheHitRate))}`);
  }
  if (meta.mode) bits.push(`${theme.c('faint', 'mode ')}${theme.c('muted', meta.mode)}`);
  const left = bits.join(theme.g.mid + '  ');
  const right = theme.c('faint', 'oc --help');
  const gap = Math.max(2, W - width(left) - width(right));
  out.push(left + ' '.repeat(gap) + right);
  return out;
}

export { SECTIONS, RISK_WEIGHTS };
