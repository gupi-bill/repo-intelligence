/**
 * Drawing primitives.
 *
 * Every widget here is a pure function from data to lines of text, which is
 * what makes the whole report unit-testable: a test can assert on the exact
 * string a bar produces at a given width without spawning a terminal.
 *
 * All width arithmetic goes through `src/render/ansi.mjs` so that CJK paths and
 * styled text never shear the layout.
 */

import { width, truncate, truncatePath, pad, stripAnsi } from './ansi.mjs';

/** A horizontal rule with an optional inline title. */
export function rule(theme, totalWidth, title = '') {
  const g = theme.g;
  if (!title) return theme.c('rule', g.h.repeat(Math.max(0, totalWidth)));
  const label = ` ${title} `;
  const remaining = Math.max(0, totalWidth - width(label) - 2);
  const left = 2;
  const right = Math.max(0, remaining - left);
  return (
    theme.c('rule', g.h.repeat(left))
    + theme.c('text', theme.bold(label))
    + theme.c('rule', g.h.repeat(right))
  );
}

/**
 * A section header: a coloured marker, the title, and optional right-aligned
 * context. Used instead of a full rule so the eye can scan section titles.
 */
export function section(theme, totalWidth, title, context = '') {
  const g = theme.g;
  const marker = theme.c('brand', `${g.v}${g.v}`);
  const head = `${marker} ${theme.c('text', theme.bold(title))}`;
  if (!context) return head;
  const gap = Math.max(1, totalWidth - width(head) - width(context));
  return `${head}${' '.repeat(gap)}${theme.c('faint', context)}`;
}

/**
 * A proportional bar with sub-character resolution, so a 1-cell difference is
 * still visible instead of rounding away to nothing.
 */
export function bar(theme, value, max, cells, colorName = 'brand') {
  if (cells <= 0) return '';
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const exact = ratio * cells;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const partialIndex = Math.floor(remainder * 8);
  const g = theme.g;

  let out = theme.c(colorName, g.barFull.repeat(Math.min(cells, full)));
  let used = Math.min(cells, full);
  if (used < cells && partialIndex > 0) {
    out += theme.c(colorName, g.barPartial[partialIndex]);
    used += 1;
  }
  const empty = cells - used;
  if (empty > 0) out += theme.c('rule', g.barEmpty.repeat(empty));
  return out;
}

/** A bar coloured by its own intensity rather than a fixed palette entry. */
export function heatBar(theme, value, max, cells) {
  if (cells <= 0) return '';
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const exact = ratio * cells;
  const full = Math.min(cells, Math.floor(exact));
  const partialIndex = Math.floor((exact - full) * 8);
  const g = theme.g;
  let out = theme.heat(ratio, g.barFull.repeat(full));
  let used = full;
  if (full < cells && partialIndex > 0) {
    out += theme.heat(ratio, g.barPartial[partialIndex]);
    used += 1;
  }
  if (used < cells) out += theme.c('rule', g.barEmpty.repeat(cells - used));
  return out;
}

/**
 * A sparkline. Uses eight vertical levels plus an explicit zero, so a series
 * that is mostly zero still shows its shape instead of collapsing to a flat line.
 */
export function sparkline(theme, values, cells = undefined) {
  const g = theme.g;
  if (!values || values.length === 0) return '';
  const data = cells && values.length > cells
    ? downsample(values, cells)
    : values;
  const max = data.reduce((m, v) => Math.max(m, v), 0);
  if (max === 0) return theme.c('rule', g.spark[0].repeat(data.length));
  const levels = g.spark;
  return data
    .map((value) => {
      const ratio = value / max;
      const index = Math.max(1, Math.min(levels.length - 1, Math.ceil(ratio * (levels.length - 1))));
      return theme.heat(ratio, levels[index]);
    })
    .join('');
}

/** Box-average downsample so a long series keeps its peaks. */
export function downsample(values, target) {
  if (target >= values.length) return [...values];
  const out = [];
  const bucket = values.length / target;
  for (let i = 0; i < target; i += 1) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let max = 0;
    for (let j = start; j < end && j < values.length; j += 1) max = Math.max(max, values[j]);
    out.push(max);
  }
  return out;
}

/**
 * A labelled goodness meter: `label  ████████░░░░  72%`
 *
 * Coloured by the goodness ramp, not the risk ramp -- a full bar here means a
 * healthy component and must not be rendered as a warning.
 */
export function meter(theme, totalWidth, { label, value, detail = '', labelWidth = 18, valueText = '' }) {
  const left = pad(theme.c('text', truncate(label, labelWidth)), labelWidth);
  const tail = valueText ? ` ${theme.c('muted', valueText)}` : '';
  // Reserve a minimum bar, then give whatever is left to the explanation, and
  // truncate the explanation to what actually fits rather than letting the row
  // run past the terminal edge.
  const minBar = 6;
  const fixed = width(left) + width(tail);
  const detailBudget = Math.max(0, totalWidth - fixed - minBar - 2);
  const detailText = detail && detailBudget > 8 ? `  ${theme.c('faint', truncate(detail, detailBudget))}` : '';
  const cells = Math.max(minBar, totalWidth - width(left) - width(tail) - width(detailText));
  const body = goodnessBar(theme, value, 1, Math.min(cells, totalWidth - fixed - width(detailText)));
  return `${left}${body}${tail}${detailText}`;
}

/** A bar coloured by goodness: empty is red, full is green. */
export function goodnessBar(theme, value, max, cells) {
  if (cells <= 0) return '';
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const exact = ratio * cells;
  const full = Math.min(cells, Math.floor(exact));
  const partialIndex = Math.floor((exact - full) * 8);
  const g = theme.g;
  let out = theme.goodness(ratio, g.barFull.repeat(full));
  let used = full;
  if (full < cells && partialIndex > 0) {
    out += theme.goodness(ratio, g.barPartial[partialIndex]);
    used += 1;
  }
  if (used < cells) out += theme.c('rule', g.barEmpty.repeat(cells - used));
  return out;
}

/** A right-aligned `label ......... value` row. */
export function statRow(theme, totalWidth, label, value, valueColor = 'text') {
  const labelText = theme.c('muted', label);
  const valueText = theme.c(valueColor, value);
  const gap = Math.max(1, totalWidth - width(labelText) - width(valueText));
  return `${labelText}${' '.repeat(gap)}${valueText}`;
}

/**
 * A table with per-column alignment and truncation. Column widths are given
 * explicitly by the caller, which keeps layout decisions in one place instead
 * of scattered through render code.
 */
export function table(theme, columns, rows, { indent = 0, gap = 2 } = {}) {
  const pad0 = ' '.repeat(indent);
  const widths = columns.map((c) => c.width);
  const lines = [];
  for (const row of rows) {
    const cells = columns.map((column, i) => {
      const raw = row[i] ?? '';
      const mark = theme.g.ellipsis;
      const text = column.truncatePath ? truncatePath(raw, widths[i], mark) : truncate(raw, widths[i], mark);
      return pad(text, widths[i], column.align ?? 'left');
    });
    lines.push(pad0 + cells.join(' '.repeat(gap)).trimEnd());
  }
  return lines;
}

/** A framed box around a block of lines. */
export function boxed(theme, totalWidth, title, lines, { footer = '' } = {}) {
  const g = theme.g;
  const inner = totalWidth - 4;
  const out = [];
  const titleText = title ? ` ${title} ` : '';
  out.push(
    theme.c('rule', g.tl + g.h)
    + (title ? theme.c('text', theme.bold(titleText)) : '')
    + theme.c('rule', g.h.repeat(Math.max(0, totalWidth - 3 - width(titleText))) + g.tr),
  );
  for (const line of lines) {
    const content = theme.c('muted', g.v);
    const pad0 = theme.c('muted', g.v);
    out.push(`${content} ${pad(truncate(line, inner, theme.g.ellipsis), inner)} ${pad0}`);
  }
  if (footer) {
    out.push(theme.c('rule', g.tee + g.h.repeat(totalWidth - 3) + g.br));
    out.push(`${theme.c('muted', g.v)} ${pad(truncate(theme.c('faint', footer), inner, theme.g.ellipsis), inner)} ${theme.c('muted', g.v)}`);
  }
  out.push(theme.c('rule', g.bl + g.h.repeat(totalWidth - 2) + g.br));
  return out;
}

/**
 * A compact grid of `value label` pairs, `columns` per row.
 *
 * The label is truncated against whatever space the value left behind. Sizing
 * the value and the label independently lets a long label on the last column of
 * a row push the whole line past the terminal width, which is exactly the kind
 * of bug that only shows up for the person who cares most about alignment.
 */
export function statGrid(theme, totalWidth, stats, columns = 4) {
  // Cells are joined by a single space, so those separators come out of the
  // budget before the cells do.
  const cellWidth = Math.floor((totalWidth - (columns - 1)) / columns);
  const rows = [];
  for (let i = 0; i < stats.length; i += columns) {
    const cells = [];
    for (let j = 0; j < columns && i + j < stats.length; j += 1) {
      const stat = stats[i + j];
      // (cell - 1 - labelField) + 1 + labelField === cellWidth, exactly.
      const labelField = Math.max(1, Math.min(width(stat.label), Math.floor(cellWidth / 2)));
      const value = pad(theme.c('text', theme.bold(String(stat.value))), cellWidth - 1 - labelField, 'right');
      const label = theme.c('faint', pad(truncate(stat.label, labelField), labelField));
      cells.push(`${value} ${label}`);
    }
    rows.push(cells.join(' ').trimEnd());
  }
  return rows;
}

/** A horizontal stacked bar, e.g. code vs comment vs blank line composition. */
export function stackedBar(theme, totalWidth, segments) {
  const sum = segments.reduce((acc, s) => acc + s.value, 0);
  if (sum === 0) return theme.c('rule', theme.g.barEmpty.repeat(totalWidth));
  const cells = totalWidth;
  let out = '';
  let used = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const share = segment.value / sum;
    const exact = share * cells;
    let count = Math.round(exact);
    if (i === segments.length - 1) count = cells - used;
    count = Math.max(0, Math.min(cells - used, count));
    if (count === 0) continue;
    out += theme.c(segment.color, theme.g.barFull.repeat(count));
    used += count;
  }
  return out;
}

/** A legend row matching `stackedBar`. */
export function legend(theme, totalWidth, segments) {
  const parts = segments
    .filter((s) => s.value > 0)
    .map((s) => `${theme.c(s.color, theme.g.barFull)} ${theme.c('muted', `${s.label} ${formatCount(s.value)}`)}`);
  return joinWrapped(parts, totalWidth, '  ');
}

/** Join parts with a separator, wrapping at the given width. */
export function joinWrapped(parts, totalWidth, separator = '  ') {
  const lines = [];
  let current = '';
  for (const part of parts) {
    if (current === '') {
      current = part;
      continue;
    }
    if (width(current) + width(separator) + width(part) > totalWidth) {
      lines.push(current);
      current = part;
    } else {
      current += separator + part;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/**
 * One row of a `label  bar  value  note` breakdown.
 *
 * When `totalWidth` is supplied the row is guaranteed to fit: the label is
 * truncated to `labelWidth`, the note is dropped or trimmed as needed, and only
 * then is the bar given whatever space is left. Letting each call site guess
 * those numbers is how a report ends up 4 columns too wide on an 80-column
 * terminal and nobody notices.
 *
 * @param {object} spec
 * @param {number} [spec.totalWidth] hard budget for the whole row
 * @param {number} [spec.indent] leading spaces to account for
 */
export function barRow(theme, spec) {
  const {
    label, value, max, valueText, valueColor = 'text', colorName, path = false,
    indent = 0, note = '', minBar = 4,
  } = spec;
  const totalWidth = spec.totalWidth;
  const labelWidth = spec.labelWidth ?? 20;

  const left = path
    ? truncatePath(theme.c('text', label), labelWidth, theme.g.ellipsis)
    : pad(theme.c('text', label), labelWidth);
  const leftWidth = width(left);

  const tail = valueText === undefined || valueText === null
    ? ''
    : ` ${theme.c(valueColor, String(valueText))}`;
  const tailWidth = width(tail);

  let cells = spec.cells ?? 16;
  let noteText = note ? theme.c('faint', note) : '';
  if (totalWidth !== undefined) {
    const budget = totalWidth - indent - leftWidth - 1 - tailWidth;
    if (noteText && budget - width(noteText) - 1 < minBar + 4) {
      noteText = ''; // no room for both an explanation and a bar
    }
    cells = Math.max(minBar, budget - width(noteText) - (noteText ? 1 : 0));
  } else if (noteText) {
    noteText = theme.c('faint', note);
  }

  const display = colorName
    ? bar(theme, value, max, cells, colorName)
    : heatBar(theme, value, max, cells);
  const suffix = noteText ? ` ${noteText}` : '';
  return `${left} ${display}${tail}${suffix}`;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Compact counts: 1234 -> 1.2k, 1234567 -> 1.2M. */
export function formatCount(value) {
  const n = Math.abs(value);
  if (n < 1000) return String(Math.round(value));
  if (n < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (n < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (n < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

/** Thousands-separated integer. */
export function formatInt(value) {
  return Math.round(value).toLocaleString('en-US');
}

/** Human byte size. */
export function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(2)} GB`;
}

/** A day count as a compact duration. */
export function formatDuration(days) {
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 31) return `${Math.round(days)} days`;
  if (days < 365) {
    const months = days / 30.44;
    return `${months < 10 ? months.toFixed(1) : Math.round(months)} months`;
  }
  const years = days / 365.25;
  return `${years < 10 ? years.toFixed(1) : Math.round(years)} years`;
}

/** A percentage with no decimals unless it is very small. */
export function formatPercent(ratio, digits = 0) {
  if (!Number.isFinite(ratio)) return '--';
  const value = ratio * 100;
  if (value > 0 && value < 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(digits)}%`;
}

/** A date index rendered as ISO `YYYY-MM-DD`. */
export function formatDay(dayIndex) {
  if (!dayIndex) return '--';
  return new Date(dayIndex * 86_400_000).toISOString().slice(0, 10);
}

/** Duration in milliseconds as `1.2s`. */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export { width, truncate, truncatePath, pad, stripAnsi };
