/**
 * Interactive explorer.
 *
 * Design rule: every view is a pure function of state that returns a list of
 * lines plus the row the cursor is on. Input handling, terminal setup and
 * teardown live entirely outside them. That split is what lets the whole UI be
 * rendered and asserted on in a test with no terminal at all.
 *
 * The terminal is put in raw mode on the alternate screen and restored on every
 * exit path, including SIGINT and an uncaught exception -- leaving a user's
 * terminal in a broken state is the one unforgivable bug in a TUI.
 */

import {
  section, rule, barRow, sparkline, formatCount, formatInt, formatBytes,
  formatDuration, formatPercent, formatDay, pad, truncate, truncatePath, width, heatBar, bar,
} from './widgets.mjs';

/** Screen-control sequences. Kept as constants so teardown cannot drift. */
const ESC = '\x1b';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J`;
const HOME = `${ESC}[H`;
const RESET = `${ESC}[0m`;

/** Key names, normalised out of the raw byte stream. */
const KEY = {
  up: 'up', down: 'down', left: 'left', right: 'right',
  enter: 'enter', escape: 'escape', tab: 'tab', backtab: 'backtab',
  pageUp: 'pageup', pageDown: 'pagedown', home: 'home', end: 'end',
  backspace: 'backspace', delete: 'delete',
};

const VIEWS = [
  { key: '1', id: 'overview', label: 'overview' },
  { key: '2', id: 'hotspots', label: 'hot files' },
  { key: '3', id: 'ownership', label: 'people' },
  { key: '4', id: 'structure', label: 'structure' },
  { key: '5', id: 'debt', label: 'debt' },
];

/**
 * Parse a chunk of stdin into key events.
 * @param {Buffer|string} chunk
 * @returns {Array<{name: string, char?: string}>}
 */
export function parseKeys(chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const keys = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ESC) {
      // CSI sequences
      if (text[i + 1] === '[') {
        // e.g. \x1b[A (cursor), \x1b[5~ (page up), \x1b[1;5C (ctrl-right)
        const match = /^\x1b\[(\d*)(?:;(\d+))?([A-Za-z~])/.exec(text.slice(i));
        if (match) {
          // Group 1: leading digits (numeric final). Group 2: modifier. Group 3:
          // the final byte. Using the wrong index here silently produces no
          // keys at all, which looks exactly like a dead keyboard.
          const params = match[1] ?? '';
          const final = match[3];
          const map = {
            A: KEY.up, B: KEY.down, C: KEY.right, D: KEY.left,
            H: KEY.home, F: KEY.end, Z: KEY.backtab,
          };
          if (map[final]) keys.push({ name: map[final] });
          else if (final === '~') {
            const byCode = {
              1: KEY.home, 3: KEY.delete, 4: KEY.end, 5: KEY.pageUp,
              6: KEY.pageDown, 7: KEY.home, 8: KEY.end,
            };
            if (byCode[params]) keys.push({ name: byCode[params] });
          }
          i += match[0].length;
          continue;
        }
      }
      // SS3 (application cursor mode sends \x1bOA etc.)
      if (text[i + 1] === 'O' && text[i + 2]) {
        const map = { A: KEY.up, B: KEY.down, C: KEY.right, D: KEY.left, H: KEY.home, F: KEY.end };
        const name = map[text[i + 2]];
        if (name) {
          keys.push({ name });
          i += 3;
          continue;
        }
      }
      // Lone ESC, or an unknown sequence we cannot classify.
      if (i + 1 >= text.length) {
        keys.push({ name: KEY.escape });
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      keys.push({ name: KEY.enter });
      i += 1;
      continue;
    }
    if (ch === '\t') {
      keys.push({ name: KEY.tab });
      i += 1;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      keys.push({ name: KEY.backspace });
      i += 1;
      continue;
    }
    if (ch < ' ') {
      i += 1; // ignore other control bytes
      continue;
    }
    keys.push({ name: 'char', char: ch });
    i += 1;
  }
  return keys;
}

/** Mutable view state, kept separate from rendering so it can be tested. */
export function initialState(report, meta) {
  return {
    view: 'overview',
    cursor: { overview: 0, hotspots: 0, ownership: 0, structure: 0, debt: 0 },
    detail: null,
    detailScroll: 0,
    filter: '',
    filtering: false,
    message: '',
    report,
    meta,
    showHelp: false,
  };
}

/** Apply a key to the state. Pure: returns a new state object. */
export function applyKey(state, key) {
  const next = { ...state, cursor: { ...state.cursor }, detail: state.detail, detailScroll: state.detailScroll };
  const rows = rowCount(next);

  if (key.name === 'char') {
    const char = key.char;

    if (next.filtering) {
      if (char === '\x1b') return { ...next, filtering: false, filter: '' };
      if (char === '\r') return { ...next, filtering: false };
      if (char === '\x7f') return { ...next, filter: next.filter.slice(0, -1), cursor: { ...next.cursor, [next.view]: 0 } };
      // Control characters never belong in a filter.
      if (char >= ' ') return { ...next, filter: next.filter + char, cursor: { ...next.cursor, [next.view]: 0 } };
      return next;
    }

    if (char === 'q') return { ...next, quit: true };
    if (char === '?') return { ...next, showHelp: !next.showHelp };
    if (char === '/') return { ...next, filtering: true, message: '' };
    if (char === 'g') return { ...next, cursor: { ...next.cursor, [next.view]: 0 } };
    if (char === 'G') return { ...next, cursor: { ...next.cursor, [next.view]: Math.max(0, rows - 1) } };
    if (char === '[' || char === 'h') return withView(next, 'prev');
    if (char === ']' || char === 'l') return withView(next, 'next');

    const view = VIEWS.find((v) => v.key === char);
    if (view) {
      return { ...next, view: view.id, detail: null, message: '' };
    }
    if (char === 'j' || char === 'k') {
      const delta = char === 'j' ? 1 : -1;
      return moveCursor(next, delta);
    }
    if (char === 'r') return { ...next, message: 'press r again to re-analyse' };
    return next;
  }

  switch (key.name) {
    // These must work while a filter is being typed: you cannot finish typing a
    // filter if escape and backspace are swallowed, and that reads as a hang.
    case KEY.escape:
      if (next.filtering) {
        return { ...next, filtering: false, filter: '', cursor: { ...next.cursor, [next.view]: 0 } };
      }
      if (next.showHelp) return { ...next, showHelp: false };
      if (next.detail) return { ...next, detail: null, detailScroll: 0 };
      if (next.filter) return { ...next, filter: '', cursor: { ...next.cursor, [next.view]: 0 } };
      return next;
    case KEY.backspace:
      if (next.filtering) {
        return { ...next, filter: next.filter.slice(0, -1), cursor: { ...next.cursor, [next.view]: 0 } };
      }
      return next;
    case KEY.enter:
      if (next.filtering) return { ...next, filtering: false };
      break;
    default:
      break;
  }

  if (next.filtering) return next;

  switch (key.name) {
    case KEY.down:
    case 'j':
      return moveCursor(next, 1);
    case KEY.up:
    case 'k':
      return moveCursor(next, -1);
    case KEY.pageDown:
      return moveCursor(next, 10);
    case KEY.pageUp:
      return moveCursor(next, -10);
    case KEY.home:
      return { ...next, cursor: { ...next.cursor, [next.view]: 0 } };
    case KEY.end:
      return { ...next, cursor: { ...next.cursor, [next.view]: Math.max(0, rows - 1) } };
    case KEY.tab:
      return withView(next, 'next');
    case KEY.backtab:
      return withView(next, 'prev');
    case KEY.enter:
      return openDetail(next);
    default:
      return next;
  }
}

function withView(state, direction) {
  const index = VIEWS.findIndex((v) => v.id === state.view);
  const delta = direction === 'next' ? 1 : -1;
  const target = VIEWS[(index + delta + VIEWS.length) % VIEWS.length];
  return { ...state, view: target.id, detail: null, message: '' };
}

function moveCursor(state, delta) {
  const rows = rowCount(state);
  if (rows === 0) return state;
  const current = state.cursor[state.view] ?? 0;
  const target = Math.max(0, Math.min(rows - 1, current + delta));
  if (state.view === 'overview' || state.view === 'structure' || state.view === 'debt') {
    // These views scroll rather than select.
    const max = Math.max(0, rows - 1);
    return { ...state, cursor: { ...state.cursor, [state.view]: Math.max(0, Math.min(max, target)) } };
  }
  return { ...state, cursor: { ...state.cursor, [state.view]: target } };
}

function openDetail(state) {
  if (state.view !== 'hotspots') return state;
  const item = visibleHotspots(state)[state.cursor.hotspots];
  if (!item) return state;
  return { ...state, detail: item.record.rel, detailScroll: 0 };
}

/** Hot spots after the active filter. */
export function visibleHotspots(state) {
  const needle = state.filter.toLowerCase();
  if (!needle) return state.report.hotspots;
  return state.report.hotspots.filter((s) => s.record.rel.toLowerCase().includes(needle));
}

function visibleAuthors(state) {
  const needle = state.filter.toLowerCase();
  const list = state.report.ownership.authors;
  if (!needle) return list;
  return list.filter((a) => a.name.toLowerCase().includes(needle) || a.key.includes(needle));
}

function rowCount(state) {
  if (state.view === 'hotspots') return visibleHotspots(state).length;
  if (state.view === 'ownership') return visibleAuthors(state).length;
  return 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the whole screen.
 * @returns {{lines: string[], cursor: number}}
 */
export function renderFrame(state, theme, W, height) {
  const lines = [];
  const push = (...values) => lines.push(...values);

  if (state.showHelp) {
    push(...renderHelp(theme, W));
    return { lines: fit(lines, height), cursor: -1 };
  }
  if (state.detail) {
    const detail = renderFileDetail(state, theme, W);
    push(...detail.lines);
    return { lines: fit(lines, height, detail.cursor), cursor: -1 };
  }

  push(...renderChrome(state, theme, W));

  let cursor = -1;
  switch (state.view) {
    case 'overview': push(...renderOverview(state, theme, W)); break;
    case 'hotspots': cursor = renderHotspotTable(state, theme, W, push); break;
    case 'ownership': cursor = renderAuthorTable(state, theme, W, push); break;
    case 'structure': push(...renderStructureView(state, theme, W)); break;
    case 'debt': push(...renderDebtView(state, theme, W)); break;
    default: push(...renderOverview(state, theme, W));
  }

  push(...renderStatus(state, theme, W));
  return { lines: fit(lines, height, cursor), cursor };
}

function fit(lines, height, cursor = -1) {
  if (height <= 0) return lines;
  if (lines.length <= height) return lines;
  // Scroll so the cursor stays on screen.
  const top = cursor >= 0 ? Math.max(0, Math.min(cursor - height + 3, lines.length - height)) : 0;
  return lines.slice(top, top + height);
}

function renderChrome(state, theme, W) {
  const { meta, report } = state;
  const grade = report.health.grade;
  const right = theme.c('faint', `${meta?.repoName ?? ''} ${theme.g.mid} ${grade} ${report.health.value}`);
  const rightWidth = width(right);
  const budget = Math.max(10, W - rightWidth - 3 - width(theme.c('brand', theme.bold('oc'))));

  // Two tab layouts: full labels when there is room, bare numbers when there is
  // not. A tab bar that wraps is worse than an abbreviated one.
  const long = VIEWS.map((v) => (v.id === state.view ? theme.c('brand', theme.bold(`[${v.key} ${v.label}]`)) : theme.c('faint', ` ${v.key} ${v.label} `)));
  const short = VIEWS.map((v) => (v.id === state.view ? theme.c('brand', theme.bold(`[${v.key}]`)) : theme.c('faint', ` ${v.key} `)));
  const tabs = width(long.join('')) <= budget ? long : short;

  const left = `${theme.c('brand', theme.bold('oc'))} ${tabs.join(theme.c('rule', '|'))}`;
  const gap = Math.max(1, W - width(left) - rightWidth);
  return [
    truncate(`${left}${' '.repeat(gap)}${right}`, W, theme.g.ellipsis),
    theme.c('rule', theme.g.h.repeat(W)),
  ];
}

function renderStatus(state, theme, W) {
  const parts = [];
  if (state.filtering) parts.push(theme.c('brand', `filter: ${state.filter}${theme.g.spark[0]}`));
  else if (state.filter) parts.push(theme.c('brand', `filter: ${state.filter}`));
  if (state.message) parts.push(theme.c('warn', state.message));
  parts.push(theme.c('faint', '? help   / filter   [ ] views   q quit'));

  const line = parts.join(theme.g.mid);
  const count = state.view === 'hotspots'
    ? `${visibleHotspots(state).length} files`
    : state.view === 'ownership' ? `${visibleAuthors(state).length} people` : '';
  const right = theme.c('faint', count);
  const left = ' ' + truncate(line, Math.max(0, W - width(right) - 2));
  const gap = Math.max(1, W - width(left) - width(right));
  return ['', left + ' '.repeat(gap) + right];
}

function renderOverview(state, theme, W) {
  const { report } = state;
  const out = [''];

  out.push(section(theme, W, 'HEALTH', `${report.health.grade} ${report.health.value}/100`));
  const labelWidth = Math.min(20, Math.max(13, Math.floor(W * 0.19)));
  const barWidth = Math.max(8, Math.min(30, W - 4 - labelWidth - 40));
  const detailBudget = Math.max(8, W - 2 - labelWidth - 1 - barWidth - 1 - 4 - 2);
  for (const component of report.health.components) {
    // Truncate the label: `pad` only widens, so a label longer than the column
    // would silently push every following column to the right.
    const label = theme.c('text', truncate(component.label, labelWidth, theme.g.ellipsis));
    out.push('  ' + pad(label, labelWidth)
      + ' ' + heatBar(theme, 1 - (component.value / 100), 1, barWidth)
      + ' ' + pad(theme.c('text', String(component.value)), 4, 'right')
      + '  ' + theme.c('faint', truncate(component.detail, detailBudget, theme.g.ellipsis)));
  }

  if (report.timeline?.months?.length) {
    out.push('');
    out.push(section(theme, W, 'ACTIVITY', `peak ${formatInt(Math.max(...report.timeline.months.map((m) => m.commits)))} commits/month`));
    out.push('  ' + sparkline(theme, report.timeline.months.map((m) => m.commits), Math.max(20, W - 6)));
  }

  out.push('');
  out.push(section(theme, W, 'AT A GLANCE'));
  const stats = [
    [`${formatCount(report.totals.files)}`, 'files'],
    [`${formatCount(report.totals.code)}`, 'code lines'],
    [`${formatPercent(report.tests.ratio)}`, 'test reach'],
    [`${formatInt(report.history.authors)}`, 'contributors'],
    [`${formatInt(report.debt.total)}`, 'debt'],
    [`${report.coupling.cycles.length}`, 'cycles'],
    [`${report.ownership.busFactor}`, 'bus factor'],
    [`${formatBytes(report.totals.bytes)}`, 'size'],
  ];
  const columns = W >= 100 ? 4 : W >= 70 ? 3 : 2;
  const cell = Math.floor((W - 2 - (columns - 1)) / columns);
  for (let i = 0; i < stats.length; i += columns) {
    const cells = [];
    for (let j = 0; j < columns && i + j < stats.length; j += 1) {
      const [valueText, labelText] = stats[i + j];
      const labelField = Math.max(1, Math.min(width(labelText), Math.floor(cell / 2)));
      const value = pad(theme.c('text', theme.bold(valueText)), cell - 1 - labelField, 'right');
      const label = theme.c('faint', pad(truncate(labelText, labelField), labelField));
      cells.push(`${value} ${label}`);
    }
    out.push('  ' + cells.join(' ').trimEnd());
  }
  out.push('');
  return out;
}

function renderHotspotTable(state, theme, W, push) {
  const list = visibleHotspots(state);
  if (list.length === 0) {
    push('  ' + theme.c('faint', 'no files match the filter'));
    return -1;
  }
  const headerIndex = push.length;
  push('');
  push('  ' + [
    pad(theme.c('faint', 'risk'), 4, 'right'),
    pad(theme.c('faint', 'churn'), 6, 'right'),
    pad(theme.c('faint', 'cx/fn'), 6, 'right'),
    pad(theme.c('faint', 'lines'), 6, 'right'),
    pad(theme.c('faint', 'age'), 8, 'right'),
    theme.c('faint', 'file'),
  ].join('  '));
  push('  ' + theme.c('rule', theme.g.h.repeat(Math.max(10, W - 4))));

  const selected = state.cursor.hotspots;
  list.forEach((spot, i) => {
    const active = i === selected;
    const marker = active ? theme.c('brand', theme.g.arrow) : ' ';
    const age = spot.daysSince === null ? '-' : formatDuration(spot.daysSince);
    const pathBudget = Math.max(16, W - 4 - 4 - 6 - 6 - 6 - 8 - 4);
    const line = '  ' + marker + [
      pad(theme.score(spot.risk, String(Math.round(spot.risk))), 4, 'right'),
      pad(theme.c('text', formatCount(spot.commits)), 6, 'right'),
      pad(theme.c(spot.perFunction > 10 ? 'bad' : spot.perFunction > 5 ? 'warn' : 'muted', spot.perFunction.toFixed(1)), 6, 'right'),
      pad(theme.c('muted', formatCount(spot.code)), 6, 'right'),
      pad(theme.c(spot.daysSince !== null && spot.daysSince > 365 ? 'faint' : 'muted', age), 8, 'right'),
      renderPath(theme, spot.record.rel, pathBudget, active),
    ].join('  ');
    push(line);
  });
  return headerIndex + 2 + selected;
}

/** A file path cell, emphasised when the row is under the cursor. */
function renderPath(theme, rel, budget, active) {
  const text = truncatePath(rel, budget, theme.g.ellipsis);
  return active ? theme.c('text', theme.bold(text)) : theme.c('text', text);
}

function renderAuthorTable(state, theme, W, push) {
  const list = visibleAuthors(state);
  if (list.length === 0) {
    push('  ' + theme.c('faint', 'no people match the filter'));
    return -1;
  }
  const headerIndex = push.length;
  // Budget the row from the outside in: fixed numeric columns and a bar take a
  // known amount, and the name gets whatever is left. Hard-coding the name
  // width overflows a 60-column terminal, and a 200-column one wastes space.
  const commitsW = 8;
  const filesW = 7;
  const shareW = 7;
  const separator = '  ';
  const fixed = 2 + 1 + commitsW + 2 + filesW + 2 + shareW + 2;
  const barCells = Math.max(4, Math.min(22, Math.floor((W - fixed) * 0.35)));
  const nameW = Math.max(8, W - fixed - barCells - 2);

  push('');
  push('  ' + [
    pad(theme.c('faint', 'contributor'), nameW),
    pad(theme.c('faint', 'commits'), commitsW, 'right'),
    pad(theme.c('faint', 'files'), filesW, 'right'),
    pad(theme.c('faint', 'share'), shareW, 'right'),
  ].join(separator));
  const maxCommits = list[0]?.commits ?? 1;
  list.forEach((author, i) => {
    const active = i === state.cursor.ownership;
    const marker = active ? theme.c('brand', theme.g.arrow) : ' ';
    const share = state.report.history.commits > 0 ? author.commits / state.report.history.commits : 0;
    const nameColor = author.lastActive <= 180 ? 'text' : author.lastActive <= 365 ? 'muted' : 'faint';
    const line = '  ' + marker + [
      pad(theme.c(nameColor, truncate(author.name, nameW, theme.g.ellipsis)), nameW),
      pad(theme.c('text', formatInt(author.commits)), commitsW, 'right'),
      pad(theme.c('muted', formatCount(author.files)), filesW, 'right'),
      pad(theme.c('faint', formatPercent(share, 1)), shareW, 'right'),
      bar(theme, author.commits, maxCommits, barCells, 'brand'),
    ].join(separator);
    push(line);
  });
  return headerIndex + 2 + state.cursor.ownership;
}

function renderStructureView(state, theme, W) {
  const { report } = state;
  const out = [''];
  out.push(section(theme, W, 'IMPORT CYCLES', `${report.coupling.cycles.length} found`));
  if (report.coupling.cycles.length === 0) {
    out.push('  ' + theme.c('good', `${theme.g.check} none detected`));
  } else {
    // Small components are fixable and worth listing; a large one is a cluster,
    // and calling it a "cycle" would overstate what a reader can do about it.
    const small = report.coupling.cycles.filter((c) => c.length <= 8);
    const clusters = report.coupling.cycles.filter((c) => c.length > 8).sort((a, b) => b.length - a.length);
    for (const component of small.slice(0, 8)) {
      out.push('  ' + theme.c('bad', theme.bold(`cycle of ${component.length}`)));
      for (const path of component) {
        out.push('    ' + theme.c('muted', theme.g.tree) + ' ' + theme.c('text', truncatePath(path, W - 10, theme.g.ellipsis)));
      }
    }
    if (small.length > 8) out.push('  ' + theme.c('faint', `${theme.g.mid} ${small.length - 8} more small cycles`));
    for (const cluster of clusters.slice(0, 3)) {
      out.push('');
      out.push('  ' + theme.c('warn', theme.bold(`${cluster.length} files form one dependency cluster`)));
      out.push('    ' + theme.c('faint', 'Mutually reachable; nothing in it can move in isolation.'));
    }
  }

  const hot = [...report.coupling.fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (hot.length > 0) {
    out.push('');
    out.push(section(theme, W, 'HIGHEST BLAST RADIUS'));
    const nameW = Math.max(20, W - 40);
    for (const [path, count] of hot) {
      out.push('  ' + barRow(theme, {
        label: path, labelWidth: nameW, path: true, value: count, max: hot[0][1],
        cells: Math.max(6, Math.min(18, W - nameW - 16)),
        valueText: `${count}`, valueColor: 'muted', colorName: 'accent',
      }));
    }
  }

  if (report.coupling.undeclared.length > 0) {
    out.push('');
    out.push(section(theme, W, 'UNDECLARED DEPENDENCIES'));
    for (const entry of report.coupling.undeclared.slice(0, 10)) {
      out.push('  ' + theme.c('warn', entry.name) + theme.c('faint', `  ${entry.importers} importers`));
    }
  }
  out.push('');
  return out;
}

function renderDebtView(state, theme, W) {
  const { report } = state;
  const out = [''];
  out.push(section(theme, W, 'DEBT', `${formatInt(report.debt.total)} markers`));
  const maxCount = report.debt.byType[0]?.count ?? 1;
  for (const entry of report.debt.byType) {
    out.push('  ' + barRow(theme, {
      label: entry.marker,
      labelWidth: 14,
      value: entry.count,
      max: maxCount,
      cells: Math.max(6, Math.min(18, Math.floor(W * 0.16))),
      valueText: formatInt(entry.count),
      valueColor: 'text',
      colorName: entry.weight >= 3 ? 'warn' : 'accent',
    }) + theme.c('faint', `  ${entry.files} files`));
  }
  if (report.debt.oldest) {
    out.push('');
    out.push('  ' + theme.c('text', theme.bold('Oldest untouched debt')));
    out.push('    ' + theme.c('muted', truncatePath(report.debt.oldest.rel, W - 12, theme.g.ellipsis)) + theme.c('faint', `:${report.debt.oldest.line}`));
    out.push('    ' + theme.c('warn', report.debt.oldest.marker) + ' ' + theme.c('text', truncate(report.debt.oldest.text, W - 16, theme.g.ellipsis)));
  }
  out.push('');
  return out;
}

function renderFileDetail(state, theme, W) {
  const { report } = state;
  const signal = report.signals.find((s) => s.record.rel === state.detail);
  const out = [];
  if (!signal) {
    out.push('', '  ' + theme.c('faint', 'file not found in this report'));
    return { lines: out, cursor: -1 };
  }

  out.push(section(theme, W, truncatePath(signal.record.rel, W - 14, theme.g.ellipsis), theme.c('text', String(Math.round(signal.risk)))));
  out.push(theme.c('rule', theme.g.h.repeat(W)));
  out.push('');

  const facts = [
    ['language', signal.shape.language ?? 'unknown'],
    ['lines', `${formatInt(signal.code)} code / ${formatInt(signal.shape.comment ?? 0)} comment`],
    ['size', formatBytes(signal.shape.bytes ?? 0)],
    ['changes', formatInt(signal.commits)],
    ['decisions', `${formatInt(signal.complexity)} (${signal.perFunction.toFixed(1)} per function, ${signal.funcs} functions)`],
    ['depth', String(signal.shape.depth ?? 0)],
    ['authors', signal.authors === 0 ? 'no history' : String(signal.authors)],
    ['imports / imported by', `${signal.fanOut} / ${signal.fanIn}`],
    ['tested', signal.isTested ? 'yes' : signal.isTest ? 'is a test' : 'no test reaches this file'],
    ['in a cycle', signal.inCycle ? 'yes' : 'no'],
  ];
  for (const [key, value] of facts) {
    out.push('  ' + pad(theme.c('faint', key), 22) + ' ' + truncate(theme.c('text', value), W - 26, theme.g.ellipsis));
  }

  if (signal.reasons.length > 0) {
    out.push('');
    out.push('  ' + theme.c('text', theme.bold('Why it scores what it does')));
    const maxContribution = signal.reasons[0].contribution;
    for (const reason of signal.reasons) {
      out.push('    ' + pad(theme.c('muted', REASONS[reason.key] ?? reason.key), 16)
        + ' ' + heatBar(theme, reason.contribution, maxContribution, 16)
        + ' ' + theme.c('faint', `${reason.contribution.toFixed(1)} pts`));
    }
  }

  const debt = signal.shape.debt ?? [];
  if (debt.length > 0) {
    out.push('');
    out.push('  ' + theme.c('text', theme.bold(`Markers (${debt.length})`)));
    for (const marker of debt.slice(0, 10)) {
      out.push('    ' + pad(theme.c(marker.weight >= 3 ? 'bad' : 'warn', marker.marker), 13)
        + theme.c('faint', `:${marker.line} `)
        + truncate(theme.c('text', marker.text), W - 24, theme.g.ellipsis));
    }
  }

  const dependents = [];
  for (const [from, tos] of report.coupling.edges) {
    if (tos.has(signal.record.rel)) dependents.push(from);
  }
  if (dependents.length > 0) {
    out.push('');
    out.push('  ' + theme.c('text', theme.bold(`Imported by (${dependents.length})`)));
    for (const path of dependents.slice(0, 12)) {
      out.push('    ' + theme.c('muted', theme.g.tree) + ' ' + truncatePath(theme.c('text', path), W - 10, theme.g.ellipsis));
    }
    if (dependents.length > 12) out.push('    ' + theme.c('faint', `+${dependents.length - 12} more`));
  }

  const history = report.history;
  void history;
  out.push('');
  out.push('  ' + theme.c('faint', 'esc back   [ ] other views   q quit'));
  return { lines: out, cursor: -1 };
}

const REASONS = {
  churn: 'churn',
  complexity: 'complexity',
  size: 'size',
  debt: 'debt markers',
  ownership: 'single owner',
  blastRadius: 'blast radius',
  untested: 'untested',
  suppression: 'suppressed',
};

function renderHelp(theme, W) {
  const rows = [
    ['j / k / ↓ / ↑', 'move the cursor'],
    ['g / G', 'jump to the first or last row'],
    ['PgUp / PgDn', 'move ten rows'],
    ['enter', 'open the selected file'],
    ['esc', 'close detail, clear filter, close help'],
    ['1 - 5', 'switch view'],
    ['[ / ] or tab', 'cycle views'],
    ['/', 'filter the current view by path or name'],
    ['?', 'toggle this help'],
    ['q', 'quit'],
  ];
  const keyW = Math.max(6, Math.min(20, Math.floor(W * 0.28)));
  const describe = (key, text) => '  ' + pad(theme.c('brand', truncate(key, keyW, theme.g.ellipsis)), keyW)
    + theme.c('text', truncate(text, Math.max(4, W - keyW - 2), theme.g.ellipsis));

  const out = ['', section(theme, W, 'KEYS'), ''];
  for (const [key, description] of rows) {
    out.push(describe(key, description));
  }
  out.push('');
  out.push(section(theme, W, 'WHAT THE COLUMNS MEAN'));
  out.push(describe('risk', 'composite 0-100 danger score'));
  out.push(describe('churn', 'commits that touched this file'));
  out.push(describe('cx/fn', 'decision points per function'));
  out.push(describe('age', 'time since the file last changed'));
  out.push('');
  return out;
}

// ---------------------------------------------------------------------------
// Terminal driver
// ---------------------------------------------------------------------------

/**
 * Run the interactive explorer.
 * @returns {Promise<number>} exit code
 */
export async function runInteractive({ report, theme, caps, meta }) {
  const output = process.stdout;
  const input = process.stdin;
  let state = initialState(report, meta);
  let widthNow = caps.width;
  let heightNow = output.rows ?? 24;
  let rawSet = false;

  const enter = () => {
    output.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN + HOME);
    if (input.isTTY) {
      input.setRawMode(true);
      rawSet = true;
    }
    input.resume();
  };
  const leave = () => {
    try {
      if (rawSet && input.isTTY) input.setRawMode(false);
      input.pause();
      output.write(SHOW_CURSOR + ALT_SCREEN_OFF + RESET);
    } catch {
      /* the terminal is gone; nothing useful to do */
    }
  };

  const onResize = () => {
    widthNow = output.columns ?? caps.width;
    heightNow = output.rows ?? 24;
  };

  const onSignal = () => {
    leave();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', (error) => {
    leave();
    process.stderr.write(`oc: ${error?.message ?? error}\n`);
    process.exit(1);
  });

  const draw = () => {
    onResize();
    const frame = renderFrame(state, theme, widthNow, Math.max(3, heightNow - 1));
    output.write(HOME + CLEAR_SCREEN + frame.lines.join('\n'));
  };

  enter();
  draw();

  return new Promise((resolve) => {
    const onData = (chunk) => {
      for (const key of parseKeys(chunk)) {
        state = applyKey(state, key);
        if (state.quit) {
          cleanup();
          leave();
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
          resolve(0);
          return;
        }
      }
      draw();
    };
    const cleanup = () => {
      input.off('data', onData);
      output.off('resize', onResize);
    };
    input.on('data', onData);
    output.on('resize', onResize);
  });
}
