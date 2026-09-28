/**
 * Theme: the single place where colour and glyph decisions are made.
 *
 * Renderers ask the theme for semantic names ("risk", "muted", "good") and
 * never for raw colour codes. That keeps the report visually consistent, makes
 * degradation a one-line change, and means the whole palette can be re-tuned
 * without touching a single layout routine.
 */

import { makeColor, makeStyle, fg256, RESET } from './ansi.mjs';

/**
 * Semantic palette, as 24-bit RGB. Values are chosen to stay legible on both
 * dark and light backgrounds: mid-tone hues, never pure black or pure white.
 */
const PALETTE = {
  brand: [94, 214, 200],
  accent: [129, 178, 255],
  text: [222, 226, 232],
  muted: [140, 148, 160],
  faint: [96, 104, 116],
  rule: [64, 72, 84],

  good: [86, 204, 138],
  ok: [140, 196, 110],
  warn: [232, 184, 92],
  bad: [233, 116, 106],
  critical: [214, 108, 168],

  info: [122, 168, 240],
  hint: [160, 150, 240],

  hot0: [86, 204, 138],
  hot1: [140, 196, 110],
  hot2: [232, 184, 92],
  hot3: [236, 146, 90],
  hot4: [233, 116, 106],
};

/** Glyph sets. Unicode first, ASCII as an exact-width fallback. */
const GLYPHS_UNICODE = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  tee: '├', cross: '┼',
  barFull: '█', barPartial: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'],
  barEmpty: '░',
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  dot: '•', mid: '·', arrow: '→', up: '▲', down: '▼',
  check: '✓', crossMark: '✗', warnMark: '!', infoMark: 'i',
  ellipsis: '…', tree: '└', treeMid: '├',
  gaugeEmpty: '░',
  sparklineEmpty: '▁',
};

const GLYPHS_ASCII = {
  tl: '+', tr: '+', bl: '+', br: '+',
  h: '-', v: '|',
  tee: '+', cross: '+',
  barFull: '#', barPartial: ['', '', '', '', '|', '|', '|', '|'],
  barEmpty: '.',
  spark: ['_', '.', '.', ':', ':', '|', '|', '#'],
  dot: '*', mid: '-', arrow: '->', up: '^', down: 'v',
  check: 'y', crossMark: 'x', warnMark: '!', infoMark: 'i',
  ellipsis: '...', tree: '\\', treeMid: '|',
  gaugeEmpty: '.',
  sparklineEmpty: '_',
};

export class Theme {
  /**
   * @param {import('./ansi.mjs').ColorDepth} depth
   * @param {boolean} unicode
   */
  constructor(depth, unicode = true) {
    this.depth = depth;
    this.unicode = unicode;
    this.color = makeColor(depth);
    this.style = makeStyle(depth);
    this.g = unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;
  }

  /**
   * Colour a string with a semantic palette name.
   *
   * At depth 0 the text is returned untouched -- not merely uncoloured. The
   * alternative is to emit a bare `ESC[0m` reset around every value, which looks
   * fine in a terminal and quietly corrupts `oc --no-color > report.txt` and
   * `oc --json | jq`. "No colour" has to mean no escape bytes at all.
   */
  c(name, text) {
    if (this.depth === 0) return text;
    const rgb = PALETTE[name];
    if (!rgb) return text;
    return `${this.color(rgb[0], rgb[1], rgb[2])}${text}${RESET}`;
  }

  /** Colour a string with a literal RGB triple. */
  rgb(r, g, b, text) {
    if (this.depth === 0) return text;
    return `${this.color(r, g, b)}${text}${RESET}`;
  }

  /** A 256-colour accent, for large fills where truecolor is wasted. */
  c256(index, text) {
    if (this.depth === 0) return text;
    return `${fg256(this.depth, index)}${text}${RESET}`;
  }

  get bold() { return this.style.bold; }
  get dim() { return this.style.dim; }
  get italic() { return this.style.italic; }
  get underline() { return this.style.underline; }

  /**
   * Heat colour for a 0-1 intensity, used for risk scores and ratios so that
   * the same visual language means the same thing in every section.
   */
  heat(value, text) {
    const v = Math.max(0, Math.min(1, value));
    const stops = ['hot0', 'hot1', 'hot2', 'hot3', 'hot4'];
    const index = Math.min(stops.length - 1, Math.floor(v * stops.length));
    return this.c(stops[index], text);
  }

  /**
   * Colour for a 0-1 *goodness* value, where 1 is best.
   *
   * Deliberately the mirror image of `heat`, which ramps toward red as the
   * value rises. Risk and health point in opposite directions, and using one
   * ramp for both made a perfect health score render in alarm red.
   */
  goodness(value, text) {
    const v = Math.max(0, Math.min(1, value));
    if (v >= 0.85) return this.c('good', text);
    if (v >= 0.7) return this.c('ok', text);
    if (v >= 0.5) return this.c('warn', text);
    if (v >= 0.3) return this.c('bad', text);
    return this.c('critical', text);
  }

  /** Colour for a 0-100 score, using the same thresholds the grades use. */
  score(value, text) {
    if (value >= 85) return this.c('good', text);
    if (value >= 72) return this.c('ok', text);
    if (value >= 58) return this.c('warn', text);
    if (value >= 42) return this.c('bad', text);
    return this.c('critical', text);
  }

  /** Colour for a grade letter. */
  grade(letter, text) {
    const map = { A: 'good', B: 'ok', C: 'warn', D: 'bad', E: 'critical' };
    return this.c(map[letter] ?? 'text', text);
  }
}

export { PALETTE, GLYPHS_UNICODE, GLYPHS_ASCII };
