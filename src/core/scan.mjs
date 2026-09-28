/**
 * Source scanning.
 *
 * A single character-level pass over each file produces everything oc reports
 * about a file's *shape*: line census, cyclomatic-ish decision points, nesting
 * depth, function count, imports, and debt markers.
 *
 * Stripping comments and string literals before measuring is what makes these
 * numbers trustworthy -- a `?` inside a string literal or a `for` in a comment
 * is not a decision point. The same pass records comment text separately so
 * debt markers (which only ever live in comments) can still be found.
 */

const DEFAULT_MAX_BYTES = 1_500_000;

/** Debt markers, ordered by how much they should worry a reviewer. */
const DEBT_MARKERS = [
  { re: /\b(?:FIXME|XXX|HACK|BUG)\b[:(]?/i, weight: 3, label: 'FIXME' },
  { re: /\bTODO\b[:(]?/i, weight: 2, label: 'TODO' },
  { re: /\b(?:WORKAROUND|HACK|XXX)\b/i, weight: 2, label: 'WORKAROUND' },
  { re: /\b(?:DEPRECATED|@deprecated|@Deprecated)\b/i, weight: 3, label: 'DEPRECATED' },
  { re: /\b(?:REFACTOR|TECHDEBT|TECH-DEBT|TODO:)\b/i, weight: 2, label: 'REFACTOR' },
  { re: /\b(?:OPTIMI[ZS]E|PERF|PERFORMANCE)\b/i, weight: 1, label: 'OPTIMIZE' },
  { re: /\b(?:CLARIFY|QUESTION|REVIEW|NOTE|BEWARE)\b/i, weight: 1, label: 'REVIEW' },
  { re: /\b(?:UNSAFE|SECURITY|SEC)\b/i, weight: 2, label: 'SECURITY' },
  { re: /\b(?:SKIP|DISABLE|NOLINT|noqa|type:\s*ignore|eslint-disable|@ts-ignore|@ts-expect-error|istanbul ignore)\b/i, weight: 2, label: 'SUPPRESSED' },
];

/** Aggregated, cheaper pass for deciding whether a file deserves a deep scan. */
// Anchored on token boundaries so `noqa` in prose does not count, while
// `eslint-disable-next-line` and `@ts-ignore` do.
const SUPPRESS_RE = new RegExp([
  '(?<![\\w$.])',
  '(?:',
  'eslint-disable(?:-[a-z-]+)?',
  '|@ts-(?:ignore|expect-error|nocheck)',
  '|istanlab?[ \t]ignore[ a-z]*',
  '|nolint\\b',
  '|noqa\\b',
  '|#\\s*type:\\s*ignore',
  '|#\\s*noqa',
  '|coverage:\\s*ignore',
  '|@jsxIgnore',
  '|pragma:\\s*no cover',
  ')',
].join(''), 'gi');

/**
 * @typedef {object} SourceShape
 * @property {number} total     every line in the file
 * @property {number} code      lines with at least one code token
 * @property {number} comment   lines that are pure comment
 * @property {number} blank     empty / whitespace-only
 * @property {number} comments  total comment lines (incl. trailing)
 * @property {number} decisions branch keywords + logical operators
 * @property {number} depth     maximum brace/bracket nesting
 * @property {number} funcs     function/method/class-ish definitions
 * @property {number} suppressed suppression-directive occurrences
 * @property {number} complexity decisions + depth penalty
 * @property {{line: number, marker: string, text: string, weight: number}[]} debt
 * @property {string[]} imports import specifiers found in code
 * @property {boolean} binary
 * @property {string|null} error
 */

/**
 * Strip comments and string literals while tallying line and token statistics.
 *
 * @param {string} text
 * @param {object} lang language definition from core/lang.mjs
 * @param {{maxDecisions?: number}} [opts]
 * @returns {SourceShape}
 */
export function shapeOf(text, lang, opts = {}) {
  const maxDecisions = opts.maxDecisions ?? 1e9;
  const len = text.length;

  const lineToken = lang.line ?? null;
  const blockOpen = lang.block ? lang.block[0] : null;
  const blockClose = lang.block ? lang.block[1] : null;
  const quotes = new Set(lang.strings ?? []);

  const shape = {
    total: 0,
    code: 0,
    comment: 0,
    blank: 0,
    comments: 0,
    decisions: 0,
    depth: 0,
    maxDepth: 0,
    funcs: 0,
    suppressed: 0,
    debt: [],
    imports: [],
    binary: false,
    error: null,
  };

  // Line census is best done on the raw split; the token loop below only has to
  // classify each line as blank / code / comment, which it can do as it goes.
  let lineHasCode = false;
  let lineOnlyComment = false;
  let blank = true;

  const CODE = 0;
  const LINE_COMMENT = 1;
  const BLOCK_COMMENT = 2;
  const STRING = 3;
  let state = CODE;
  let quote = '';
  let depth = 0;
  let commentRun = '';
  let commentRunLine = 0;

  /**
   * Two outputs come out of the one pass:
   *
   *   codeOut   comments *and* string literals removed. This is what keyword
   *             and decision counting must see, otherwise a `?` inside a
   *             message or an `if` inside a string is counted as a branch.
   *   textOut   comments removed but string literals preserved. Import
   *             specifiers *are* string literals, so this is the only buffer
   *             from which a dependency can be read.
   */
  let codeOut = '';
  let codeRun = '';
  let textOut = '';
  let textRun = '';
  const flushCodeRun = () => {
    if (codeRun) {
      codeOut += codeRun;
      codeRun = '';
    }
  };
  const flushTextRun = () => {
    if (textRun) {
      textOut += textRun;
      textRun = '';
    }
  };

  /**
   * Keep both buffers line-structured.
   *
   * The Python and C-family import grammars anchor on `^` with the multiline
   * flag. Without real newlines in the output, `from a.b import c` on line 2
   * is indistinguishable from the tail of line 1 and every such import is
   * missed -- which is exactly how an entire language's dependencies vanish
   * from the graph while the tool cheerfully reports "no cycles".
   */
  /**
   * Append a run of ordinary code characters.
   *
   * Braces, brackets and the operators that count as decision points are tallied
   * here with a numeric loop over char codes, which is far cheaper than routing
   * every character through the general state machine.
   */
  const appendRun = (run) => {
    codeRun += run;
    if (codeRun.length > 8192) flushCodeRun();
    if (wantImports) {
      textRun += run;
      if (textRun.length > 8192) flushTextRun();
    }
    blank = false;
    // Two native regex tests answer the two questions that matter -- "is there
    // anything but whitespace" and "is there a brace or an operator" -- and skip
    // the per-character loop entirely for the runs that need neither. Most runs
    // in a real source file are identifiers and spaces, so this is the common
    // path by a wide margin.
    if (RUN_NONSPACE_RE.test(run)) lineHasCode = true;
    if (!RUN_SPECIAL_RE.test(run)) return;
    for (let k = 0; k < run.length; k += 1) {
      const c = run.charCodeAt(k);
      if (c === 123 || c === 40 || c === 91) { // { ( [
        depth += 1;
        if (depth > shape.maxDepth) shape.maxDepth = depth;
        lineHasCode = true;
      } else if (c === 125 || c === 41 || c === 93) { // } ) ]
        if (depth > 0) depth -= 1;
        lineHasCode = true;
      } else if (c === 63) { // '?' -- a ternary or optional chain, but not '?:'
        if (run.charCodeAt(k + 1) !== 58) shape.decisions += 1;
        lineHasCode = true;
      } else if (c === 38) { // '&'
        if (run.charCodeAt(k + 1) === 38) shape.decisions += 1;
        lineHasCode = true;
      } else if (c === 124) { // '|'
        if (run.charCodeAt(k + 1) === 124) shape.decisions += 1;
        lineHasCode = true;
      }
    }
  };

  const pushNewline = () => {
    codeRun += '\n';
    if (codeRun.length > 4096) flushCodeRun();
    if (wantImports) {
      textRun += '\n';
      if (textRun.length > 4096) flushTextRun();
    }
  };

  const pushCode = (ch) => {
    codeRun += ch;
    if (codeRun.length > 4096) flushCodeRun();
    if (textRun.length < 4096) textRun += ch;
    if (textRun.length >= 4096) flushTextRun();
    // Indentation is not a line of code. Without this, every whitespace-only
    // line -- the norm in Python, and common everywhere else -- is tallied as
    // code, which silently corrupts the comment-to-code ratio.
    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\f' && ch !== '\v') {
      lineHasCode = true;
    }
    blank = false;
  };

  const endLine = () => {
    shape.total += 1;
    if (lineHasCode) shape.code += 1;
    else if (lineOnlyComment) shape.comment += 1;
    else shape.blank += 1;
    lineHasCode = false;
    lineOnlyComment = false;
    blank = true;
  };

  /**
   * Fast path for ordinary code.
   *
   * The overwhelming majority of characters in a source file are letters,
   * digits and punctuation that mean nothing to this scanner. Handled one at a
   * time through the full state machine, each one costs two string appends and
   * a switch, which measured 3.9 MB/s -- four times slower than the regular
   * expressions that later run over the very same text.
   *
   * So: mark the handful of characters that actually change state, scan forward
   * to the next one, and move the whole run with a single `slice`. On a
   * 13k-file repository this is the difference between a 40-second first run and
   * a single-digit one.
   */
  const special = buildSpecialTable(lineToken, blockOpen, quotes);
  // The string-preserving buffer only exists so that import specifiers can be
  // read out of it. A language with no import grammar never looks at it, so
  // building it would double the memory traffic for nothing.
  const wantImports = (lang.import?.length ?? 0) > 0;

  let sawCharSinceNewline = false;
  for (let i = 0; i < len; i += 1) {
    const code = text.charCodeAt(i);

    if (state === CODE && !special[code]) {
      let end = i + 1;
      while (end < len && !special[text.charCodeAt(end)]) end += 1;
      appendRun(text.slice(i, end));
      sawCharSinceNewline = true;
      i = end - 1;
      continue;
    }

    const ch = text[i];
    const next = i + 1 < len ? text[i + 1] : '';
    if (ch !== '\n' && ch !== '\r') sawCharSinceNewline = true;

    if (ch === '\n') {
      sawCharSinceNewline = false;
      pushNewline();
      if (state === BLOCK_COMMENT) {
        // The line being closed is a continuation of the block comment.
        lineOnlyComment = true;
      }
      endLine();
      if (state === BLOCK_COMMENT) {
        // Scan this line's comment text now, so every marker is attributed to
        // the line it is actually written on. A block comment continues onto
        // the next line, which is comment-only by definition.
        scanCommentRun();
        commentRun = '';
        commentRunLine = shape.total + 1;
        lineOnlyComment = true;
      } else if (state === LINE_COMMENT) {
        scanCommentRun();
        commentRun = '';
        state = CODE;
      }
      if (state === STRING && quote !== '`') state = CODE;
      continue;
    }
    if (ch === '\r') continue;

    switch (state) {
      case CODE: {
        // Works for both `//` and a single-character `#`: a one-character
        // comment introducer is complete as soon as the character itself is
        // seen, so no lookahead is required.
        if (lineToken && ch === lineToken[0] && (lineToken.length === 1 || next === lineToken[1])) {
          state = LINE_COMMENT;
          commentRun = '';
          commentRunLine = shape.total + 1;
          if (!lineHasCode) lineOnlyComment = true;
          if (lineToken.length > 1) i += 1;
          continue;
        }
        if (blockOpen && ch === blockOpen[0] && text.startsWith(blockOpen, i)) {
          state = BLOCK_COMMENT;
          commentRun = '';
          commentRunLine = shape.total + 1;
          if (!lineHasCode) lineOnlyComment = true;
          i += blockOpen.length - 1;
          continue;
        }
        if (quotes.has(ch)) {
          state = STRING;
          quote = ch;
          blank = false;
          // Emit the opening quote too: every import grammar matches the
          // quotes, so a literal that lost its opener is unmatchable.
          if (textRun.length < 4096) textRun += ch;
          if (textRun.length >= 4096) flushTextRun();
          i += next === '\\' ? 1 : 0;
          continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') {
          // Only brace/bracket pairs that are not preceded by a `$` in
          // interpolation increase nesting for languages we care about.
          depth += 1;
          if (depth > shape.maxDepth) shape.maxDepth = depth;
          pushCode(ch);
          continue;
        }
        if (ch === '}' || ch === ')' || ch === ']') {
          if (depth > 0) depth -= 1;
          pushCode(ch);
          continue;
        }
        pushCode(ch);
        if (shape.decisions < maxDecisions && (ch === '?' || ch === '&' || ch === '|')) {
          if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
            shape.decisions += 1;
            i += 1;
          } else if (ch === '?') {
            // `foo?: T` declares an optional property; it is a type-level
            // marker, not a branch. Counting it made every TypeScript
            // interface look like the most complex file in the repository.
            // `a ? b : c` and `a?.b` both still count.
            if (next !== ':') shape.decisions += 1;
          }
        }
        continue;
      }
      case LINE_COMMENT: {
        commentRun += ch;
        continue;
      }
      case BLOCK_COMMENT: {
        commentRun += ch;
        if (ch === blockClose[0] && text.startsWith(blockClose, i)) {
          commentRun += text.slice(0, blockClose.length - 1);
          i += blockClose.length - 1;
          state = CODE;
          // Flush here rather than at the newline: a comment that opens and
          // closes on one line is already back in CODE state by the time the
          // line ends, so waiting for the newline would discard it entirely.
          // By this point commentRun holds only the current line's text,
          // because every continuation line was flushed and reset in turn, so
          // the line number stays correct.
          scanCommentRun();
          commentRun = '';
        }
        continue;
      }
      case STRING: {
        // Preserve the literal verbatim (quotes included) for import matching.
        if (textRun.length < 4096) textRun += ch;
        if (textRun.length >= 4096) flushTextRun();
        if (ch === '\\') {
          if (textRun.length < 4096) textRun += next;
          if (textRun.length >= 4096) flushTextRun();
          i += 1;
          continue;
        }
        if (ch === quote) state = CODE;
        continue;
      }
      default:
        continue;
    }
  }

  // Tail flush for a file that ends inside a comment, plus the final unterminated
  // line of a file that ends mid-statement.
  if (commentRun) scanCommentRun();
  // A file whose last line has no trailing newline still has that line. Track
  // whether anything has been seen since the last `\n` and close it out.
  if (sawCharSinceNewline) endLine();

  function scanCommentRun() {
    if (!commentRun.trim()) {
      commentRun = '';
      return;
    }
    shape.comments += commentRun.split('\n').length;
    SUPPRESS_RE.lastIndex = 0;
    let suppressMatch = SUPPRESS_RE.exec(commentRun);
    while (suppressMatch) {
      shape.suppressed += 1;
      suppressMatch = SUPPRESS_RE.exec(commentRun);
    }
    const upper = commentRun.toUpperCase();
    for (const marker of DEBT_MARKERS) {
      let at = upper.indexOf(marker.label);
      while (at !== -1) {
        const text2 = commentRun
          .slice(at, at + 120)
          .split('\n')[0]
          .replace(/^[\s:*(]*/, '')
          .trim()
          .slice(0, 90);
        shape.debt.push({ line: commentRunLine, marker: marker.label, text: text2, weight: marker.weight });
        if (shape.debt.length > 200) return;
        at = upper.indexOf(marker.label, at + marker.label.length);
        if (shape.debt.length > 200) return;
      }
    }
    commentRun = '';
  }

  flushCodeRun();
  flushTextRun();
  shape.depth = shape.maxDepth;
  shape.complexity = shape.decisions + Math.max(0, shape.maxDepth - 2);
  shape.codeText = codeOut;
  shape.textOut = textOut;
  return shape;
}

/** Does this run contain anything other than whitespace? */
const RUN_NONSPACE_RE = /\S/;

/** Does this run contain a brace, bracket or short-circuit operator? */
const RUN_SPECIAL_RE = /[{}[\]()?&|]/;

/**
 * A 256-entry table marking the characters that change scanner state: the line
 * comment introducer, the block comment opener, every string quote, newline,
 * carriage return, backslash, and the brace/bracket characters (which the run
 * handler tallies rather than the state machine).
 */
function buildSpecialTable(lineToken, blockOpen, quotes) {
  const table = new Uint8Array(256);
  const mark = (char) => {
    if (typeof char !== 'string' || char === '') return;
    const code = char.charCodeAt(0);
    if (code < 256) table[code] = 1;
  };
  mark('\n');
  mark('\r');
  mark('\\');
  for (const char of ['{', '(', '[', '}', ')', ']']) mark(char);
  if (lineToken) mark(lineToken[0]);
  if (blockOpen) mark(blockOpen[0]);
  for (const quote of quotes ?? []) mark(quote);
  return table;
}

/**
 * Count keyword-driven decisions and definitions in stripped code.
 *
 * Note the deliberate asymmetry with `extractImports`: this function *reads*
 * `shape.codeText` but never clears it. The stripped source is needed by every
 * downstream measurement, and silently emptying it here previously made the
 * import graph come out empty for every repository.
 */
export function measureCode(shape, lang) {
  const code = shape.codeText ?? '';
  if (lang.data) {
    // A data file (YAML, JSON, a stylesheet) has no control flow. Counting
    // `if:` in a config file as a decision point is how a lock file ends up
    // ranked as the most complex file in the repository.
    shape.decisions = 0;
    shape.funcs = 0;
    shape.complexity = 0;
    return shape;
  }
  if (!code) {
    shape.decisions = 0;
    shape.funcs = 0;
    return shape;
  }
  const keywords = keywordSet(lang);
  let decisions = 0;
  for (const kw of keywords) {
    const re = kwPattern(kw);
    let m = re.exec(code);
    while (m) {
      decisions += 1;
      if (decisions > 5000) break;
      m = re.exec(code);
    }
  }
  // `?` counted in the character pass may double-count ternary vs optional
  // chaining; keep only the keyword-driven number plus a bounded operator share.
  shape.decisions = decisions + Math.min(40, shape.decisions >> 4);
  shape.funcs = countDefinitions(code, lang.name);
  return shape;
}

const KEYWORD_CACHE = new Map();
const PATTERN_CACHE = new Map();

function keywordSet(lang) {
  const family = keywordFamily(lang.name);
  let set = KEYWORD_CACHE.get(family);
  if (!set) {
    set = family === 'curly'
      ? ['if', 'for', 'while', 'switch', 'case', 'catch', 'else if', 'do', 'foreach', 'unless', 'when']
      : family === 'python'
        ? ['if', 'elif', 'for', 'while', 'except', 'case', 'and', 'or']
        : family === 'go'
          ? ['if', 'for', 'case', 'select', 'switch', 'range', 'go', 'defer']
          : family === 'rust'
            ? ['if', 'for', 'while', 'loop', 'match', 'if let', 'while let']
            : family === 'functional'
              ? ['if', 'case', 'when', 'guard', 'cond', 'match']
              : ['if', 'else', 'for', 'while', 'case', 'catch', 'except', 'elif', 'when', 'unless', 'foreach', 'switch', 'select', 'rescue'];
    KEYWORD_CACHE.set(family, set);
  }
  return set;
}

function keywordFamily(name) {
  if (['JavaScript', 'TypeScript', 'Java', 'Kotlin', 'C#', 'C', 'C++', 'Swift', 'Dart', 'PHP', 'Vue', 'Svelte', 'Zig'].includes(name)) return 'curly';
  if (name === 'Python') return 'python';
  if (name === 'Go') return 'go';
  if (name === 'Rust') return 'rust';
  if (['Haskell', 'OCaml', 'Elixir', 'Scala', 'Erlang'].includes(name)) return 'functional';
  return 'generic';
}

/** Word-boundary regex for a keyword, cached. Multi-word keywords keep spaces. */
function kwPattern(kw) {
  let re = PATTERN_CACHE.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    re = new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, 'g');
    PATTERN_CACHE.set(kw, re);
  }
  re.lastIndex = 0;
  return re;
}

const DEF_PATTERNS = {
  curly: [
    /\bfunction\s*[\w$]*\s*\(/g,
    /=>\s*\{/g,
    /\bclass\s+[\w$]+/g,
    /^[ \t]*(?:public|private|protected|static|async|override|export|get|set)\s+[\w$]+\s*\(/gm,
    /\bfunc\s+\w+/g,
  ],
  python: [/^\s*def\s+\w+/gm, /^\s*class\s+\w+/gm, /^\s*async\s+def\s+\w+/gm],
  go: [/^\s*func\s+/gm],
  rust: [/\bfn\s+\w+/g, /\bimpl\b/g, /\btrait\s+\w+/g, /\bstruct\s+\w+/g, /\benum\s+\w+/g],
  generic: [/\bfunction\s*\w*\s*\(/g, /\bdef\s+\w+/g, /\bfunc\s+\w+/g, /\bclass\s+\w+/g, /\btype\s+\w+\s+struct/g, /\binterface\s+\w+/g, /\btrait\s+\w+/g],
};

const DEF_CACHE = new Map();

function countDefinitions(code, langName) {
  const family = keywordFamily(langName);
  let set = DEF_CACHE.get(family);
  if (!set) {
    set = DEF_PATTERNS[family] ?? DEF_PATTERNS.generic;
    DEF_CACHE.set(family, set);
  }
  let count = 0;
  for (const re of set) {
    re.lastIndex = 0;
    let m = re.exec(code);
    while (m) {
      count += 1;
      if (count > 2000) break;
      m = re.exec(code);
    }
  }
  return count;
}

/** Extract import specifiers using the language's grammar. */
export function extractImports(shape, lang) {
  const code = shape.textOut ?? shape.codeText ?? '';
  shape.textOut = undefined;
  if (lang.data) return [];
  if (!lang.import || lang.import.length === 0) return [];
  const found = new Set();
  for (const rule of lang.import) {
    const re = rule[0];
    const group = rule[1];
    re.lastIndex = 0;
    let m = re.exec(code);
    let guard = 0;
    while (m && guard < 2000) {
      guard += 1;
      const value = m[group];
      if (value) {
        for (const piece of value.split(',')) {
          const trimmed = piece.trim().split(/\s+as\s+/)[0].trim();
          if (trimmed) found.add(trimmed);
        }
      }
      m = re.exec(code);
    }
  }
  return [...found];
}

/** True when the buffer looks like binary content. */
export function looksBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Drop the stripped source text.
 *
 * Stripped text is roughly the same size as the file, so holding it for every
 * file in a large repository is the difference between fitting in memory and
 * not. It is released only after every consumer has read it.
 */
export function releaseCode(shape) {
  shape.codeText = undefined;
  shape.textOut = undefined;
  return shape;
}

export { DEBT_MARKERS, DEFAULT_MAX_BYTES };
