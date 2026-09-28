/**
 * Terminal capability detection and text measurement.
 *
 * Output is written for the terminal it lands in, not for the one the author
 * happens to use. Colour degrades truecolor -> 256 -> 16 -> none, box drawing
 * degrades to ASCII when the encoding will not carry it, and every string is
 * measured in *display columns* rather than code units so that CJK paths and
 * emoji do not shear every table in the report.
 */

/** @typedef {0|1|2|3} ColorDepth */

const ESC = '\x1b[';

/** Build an SGR sequence. */
export function sgr(...codes) {
  if (codes.length === 0) return '';
  return `${ESC}${codes.join(';')}m`;
}

export const RESET = sgr(0);

/** @type {RegExp} */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Remove every escape sequence from a string. */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// East Asian width
// ---------------------------------------------------------------------------

/**
 * Ranges of codepoints that occupy two terminal columns. Derived from the
 * Unicode East Asian Width property (W and F classes), condensed to the ranges
 * that actually turn up in source trees and commit messages.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6f9], [0x1f910, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Zero-width: combining marks, variation selectors, ZWJ. */
const ZERO_RANGES = [
  [0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x1ab0, 0x1aff], [0x20d0, 0x20f0], [0xfeff, 0xfeff],
];

function inRanges(code, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns occupied by a single codepoint. */
export function codepointWidth(code) {
  if (code === 0x200d) return 0; // ZWJ
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0; // control
  if (inRanges(code, ZERO_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

/** Display width of a string, ignoring escape sequences. */
export function width(text) {
  if (text === '') return 0;
  const plain = text.includes('\x1b') ? stripAnsi(text) : text;
  let total = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    total += codepointWidth(code);
  }
  return total;
}

/**
 * Truncate to `max` display columns, appending an ellipsis when it does not fit.
 * Escape sequences are preserved and never counted.
 *
 * The marker is a parameter rather than a constant because it has to match the
 * rest of the output: a terminal that cannot render box drawing gets three dots,
 * not a single ellipsis character, or "ASCII only" output is not really ASCII.
 * Every call site passes `theme.g.ellipsis`.
 */
export function truncate(text, max, ellipsis = '\u2026') {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  const budget = max - width(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, max);

  let out = '';
  let used = 0;
  let i = 0;
  while (i < text.length) {
    // Pass escape sequences through without consuming budget.
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const codePoint = text.codePointAt(i);
    const ch = String.fromCodePoint(codePoint);
    const w = codepointWidth(codePoint);
    if (used + w > budget) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return out + ellipsis;
}

/**
 * Shorten a path from the left, keeping the tail readable.
 * `src/very/deep/path/file.ts` -> `…/path/file.ts`
 */
export function truncatePath(text, max, ellipsis = '\u2026') {
  if (width(text) <= max) return text;
  if (max <= width(ellipsis) + 2) return truncate(text, max, ellipsis);
  const parts = text.split('/');
  const tail = [];
  let used = width(ellipsis);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    const cost = width(part) + 1;
    if (used + cost > max) break;
    tail.unshift(part);
    used += cost;
  }
  if (tail.length === 0) return truncate(text, max, ellipsis);
  return `${ellipsis}/${tail.join('/')}`;
}

/**
 * Fit `text` into exactly `target` display columns.
 *
 * Truncates when the text is too wide, not just pads when it is too narrow.
 * That matters because a layout that computes a column width and then pads into
 * it will silently overflow on the one input that is longer than the author
 * tested with -- a long file path, a wide CJK string, a big number. Making the
 * primitive enforce its own contract removes that whole class of bug instead of
 * patching each call site.
 */
export function pad(text, target, align = 'left') {
  if (target <= 0) return '';
  const current = width(text);
  if (current > target) return truncate(text, target);
  if (current === target) return text;
  const fill = ' '.repeat(target - current);
  if (align === 'right') return fill + text;
  if (align === 'center') {
    const left = Math.floor((target - current) / 2);
    return ' '.repeat(left) + text + ' '.repeat(target - current - left);
  }
  return text + fill;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {NodeJS.WriteStream} [opts.stream]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {'auto'|'always'|'never'} [opts.color]
 * @param {'auto'|'always'|'never'} [opts.unicode]
 * @param {number} [opts.width]
 * @returns {{depth: ColorDepth, color: boolean, unicode: boolean, width: number, hyperlinks: boolean, isTTY: boolean}}
 */
export function detect(opts = {}) {
  const stream = opts.stream ?? process.stdout;
  const env = opts.env ?? process.env;
  const isTTY = Boolean(stream?.isTTY);
  const term = env.TERM ?? '';
  const colorTerm = env.COLORTERM ?? '';
  const noColorEnv = 'NO_COLOR' in env && env.NO_COLOR !== '';
  const forceColor = env.FORCE_COLOR;
  const dumb = term === 'dumb';

  /** @type {ColorDepth} */
  let depth = 0;
  if (isTTY && !noColorEnv && !dumb) {
    if (colorTerm === 'truecolor' || colorTerm === '24bit') depth = 3;
    else if (/-256(color)?$/i.test(term)) depth = 2;
    else if (term !== '') depth = 1;
  }
  // Normalise once. Without this the default (undefined) matched neither the
  // 'auto' nor the 'always' branch, which silently made FORCE_COLOR a no-op
  // unless the caller also passed an explicit --color.
  const colorChoice = opts.color ?? 'auto';
  if (colorChoice === 'always') depth = 3;
  if (colorChoice === 'never' || noColorEnv) depth = 0;
  if (forceColor !== undefined && colorChoice === 'auto' && !noColorEnv) {
    if (forceColor === '0' || forceColor === 'false') depth = 0;
    else if (forceColor === '1' || forceColor === 'true') depth = 1;
    else if (forceColor === '2') depth = 2;
    else if (forceColor === '3') depth = 3;
  }

  let unicode = true;
  if (opts.unicode === 'never') unicode = false;
  if (opts.unicode === 'always') unicode = true;
  if (opts.unicode === 'auto' || opts.unicode === undefined) {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
    if (isTTY && /UTF-?8/i.test(locale)) unicode = true;
    else if (/UTF-?8/i.test(locale)) unicode = true;
    else unicode = !isTTY ? true : /UTF-?8/i.test(locale);
    // A dumb terminal is usually a pipe or a bare screen; keep ASCII there.
    if (dumb && isTTY) unicode = false;
  }

  const columns = opts.width
    ?? (typeof stream?.columns === 'number' && stream.columns > 0 ? stream.columns : 0)
    ?? 0;
  const widthOut = columns >= 40 ? Math.min(columns, 200) : 100;

  return {
    depth,
    color: depth > 0,
    unicode,
    width: widthOut,
    hyperlinks: Boolean(isTTY) && depth > 0 && term !== 'dumb',
    isTTY,
  };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Convert 24-bit RGB to the nearest xterm-256 index. */
export function rgbTo256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16
    + 36 * Math.round((r / 255) * 5)
    + 6 * Math.round((g / 255) * 5)
    + Math.round((b / 255) * 5);
}

/** The 16 base colours as RGB, for nearest-match fallback. */
const BASE16_RGB = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
  [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
  [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

/** Nearest base-16 index for an RGB triple. */
export function rgbTo16(r, g, b) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < BASE16_RGB.length; i += 1) {
    const [br, bg, bb] = BASE16_RGB[i];
    // Weighted to approximate perceived luminance difference.
    const dr = (r - br) * 0.299;
    const dg = (g - bg) * 0.587;
    const db = (b - bb) * 0.114;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Build a colour function bound to a capability depth. Calling it with
 * `undefined` returns the text unchanged, so render code never needs to branch
 * on whether colour is available.
 *
 * @param {ColorDepth} depth
 */
export function makeColor(depth) {
  if (depth === 0) return () => '';
  if (depth === 3) {
    return (r, g, b) => sgr(38, 2, r, g, b);
  }
  if (depth === 2) {
    return (r, g, b) => sgr(38, 5, rgbTo256(r, g, b));
  }
  return (r, g, b) => sgr(38, 5, rgbTo16(r, g, b));
}

/** 256-colour foreground (used for palette swatches that predate truecolor). */
export function fg256(depth, index) {
  if (depth === 0) return '';
  if (depth >= 2) return sgr(38, 5, index);
  return sgr(38, 5, rgbTo16(...xterm256ToRgb(index)));
}

export function xterm256ToRgb(index) {
  if (index < 16) return BASE16_RGB[index] ?? [0, 0, 0];
  if (index < 232) {
    const n = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return [steps[Math.floor(n / 36) % 6], steps[Math.floor(n / 6) % 6], steps[n % 6]];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

/** Bold / dim / italic / underline / reverse, all depth-aware. */
export function makeStyle(depth) {
  if (depth === 0) return { bold: (s) => s, dim: (s) => s, italic: (s) => s, underline: (s) => s, reverse: (s) => s, strike: (s) => s };
  return {
    bold: (s) => `${sgr(1)}${s}${RESET}`,
    dim: (s) => `${sgr(2)}${s}${RESET}`,
    italic: (s) => `${sgr(3)}${s}${RESET}`,
    underline: (s) => `${sgr(4)}${s}${RESET}`,
    reverse: (s) => `${sgr(7)}${s}${RESET}`,
    strike: (s) => `${sgr(9)}${s}${RESET}`,
  };
}

/** OSC 8 hyperlink; a no-op when the terminal will not render it. */
export function link(depth, text, url) {
  if (depth === 0 || !url) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
