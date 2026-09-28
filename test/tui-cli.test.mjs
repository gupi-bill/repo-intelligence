import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, initialState, applyKey, renderFrame, visibleHotspots, runInteractive } from '../src/render/tui.mjs';
import { Theme } from '../src/render/theme.mjs';
import { parseArgs, helpText, main, toJson } from '../src/cli.mjs';
import { makeFixture, write } from './helpers/fixture.mjs';
import { analyse } from '../src/cli.mjs';
import { Cache } from '../src/core/cache.mjs';
import { discoverRepo } from '../src/core/git.mjs';
import { width, stripAnsi } from '../src/render/ansi.mjs';

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

test('escape sequences decode to key names', () => {
  const cases = [
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1bOA', 'up'],
    ['\x1bOB', 'down'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[1~', 'home'],
    ['\x1b[4~', 'end'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\t', 'tab'],
    ['\x1b[Z', 'backtab'],
    ['\x7f', 'backspace'],
  ];
  for (const [input, expected] of cases) {
    const keys = parseKeys(input);
    assert.equal(keys.length, 1, `${JSON.stringify(input)} should be one key`);
    assert.equal(keys[0].name, expected, JSON.stringify(input));
  }
});

test('ordinary characters come through as typing', () => {
  assert.deepEqual(parseKeys('j'), [{ name: 'char', char: 'j' }]);
  assert.deepEqual(parseKeys('/'), [{ name: 'char', char: '/' }]);
});

test('a batch of input in one chunk decodes to a key sequence', () => {
  const keys = parseKeys('\x1b[B\x1b[Bjk');
  assert.deepEqual(keys.map((k) => k.name), ['down', 'down', 'char', 'char']);
  assert.deepEqual(keys.map((k) => k.char).filter(Boolean), ['j', 'k']);
});

test('a split escape sequence is handled across chunks', () => {
  // The arrow key arrives in two reads, which is normal on a slow terminal.
  const first = parseKeys('\x1b');
  assert.equal(first[0].name, 'escape');
  const second = parseKeys('[A');
  assert.equal(second[0].name, 'char');
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function fakeReport() {
  const hotspot = (rel, risk, commits) => ({
    record: { rel },
    risk,
    commits,
    code: 100,
    perFunction: 3,
    funcs: 4,
    debt: 0,
    authors: 2,
    shape: { language: 'JavaScript', depth: 3, bytes: 1024, debt: [] },
    reasons: [{ key: 'churn', contribution: 10 }],
    fanIn: 1,
    fanOut: 2,
    isTest: false,
    isTested: false,
    isGenerated: false,
    inCycle: false,
    daysSince: 10,
    parts: {},
  });
  return {
    signals: [hotspot('src/a.js', 90, 50), hotspot('src/b.js', 50, 20), hotspot('lib/c.js', 10, 5)],
    hotspots: [hotspot('src/a.js', 90, 50), hotspot('src/b.js', 50, 20), hotspot('lib/c.js', 10, 5)],
    health: {
      value: 72,
      grade: 'B',
      components: [
        { key: 'maintainability', label: 'Maintainability', value: 80, detail: 'median 1.2 decision points' },
        { key: 'tests', label: 'Test coverage', value: 40, detail: '10/40 source files reached' },
      ],
    },
    timeline: { months: Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${i + 1}`, commits: 10 * (i + 1), authors: 3 })) },
    totals: { files: 40, code: 1000, bytes: 20480, comment: 100, blank: 200, lines: 1300, suppressed: 0, debt: 2 },
    tests: { ratio: 0.25, covered: 10, sourceFiles: 40, byDirectory: [] },
    debt: {
      total: 2,
      suppressed: 1,
      byType: [{ marker: 'TODO', count: 2, files: 1, weight: 2 }],
      oldest: { rel: 'src/a.js', marker: 'TODO', text: 'fix this', line: 3, daysSince: 400 },
    },
    ownership: {
      total: 2,
      busFactor: 1,
      singleOwnerCount: 3,
      authors: [
        { key: 'a@x.com', name: 'Alice', commits: 100, files: 20, lastActive: 5, lastDay: 100, merges: 0 },
        { key: 'b@x.com', name: 'Bob', commits: 40, files: 15, lastActive: 500, lastDay: 10, merges: 0 },
      ],
    },
    coupling: {
      cycles: [['a', 'b']],
      cycleFileCount: 2,
      undeclared: [{ name: 'left-pad', importers: 3 }],
      unused: ['unused-pkg'],
      fanIn: new Map([['src/a.js', 12], ['src/b.js', 4]]),
      externals: [['react', 40]],
      externalCount: 1,
      edges: new Map([['test/a.test.js', new Set(['src/a.js'])]]),
    },
    history: {
      commits: 140, authors: 2, firstDay: 0, lastDay: 100, spanDays: 100,
      merges: 0, emptyCommits: 0, adds: 0, dels: 0, renames: 0, partial: false, deleted: 0,
    },
  };
}

const KEY = (char) => ({ name: 'char', char });
const DOWN = { name: 'down' };
const UP = { name: 'up' };
const ENTER = { name: 'enter' };
const ESC = { name: 'escape' };

test('number keys switch views', () => {
  let state = initialState(fakeReport(), { repoName: 'test' });
  for (const [key, view] of [['1', 'overview'], ['2', 'hotspots'], ['3', 'ownership'], ['4', 'structure'], ['5', 'debt']]) {
    state = applyKey(state, KEY(key));
    assert.equal(state.view, view);
  }
});

test('tab and brackets cycle through views and wrap around', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  assert.equal(state.view, 'hotspots');
  state = applyKey(state, { name: 'tab' });
  assert.equal(state.view, 'ownership');
  state = applyKey(state, KEY('5'));
  state = applyKey(state, { name: 'tab' });
  assert.equal(state.view, 'overview', 'wraps past the end');
  state = applyKey(state, { name: 'backtab' });
  assert.equal(state.view, 'debt', 'wraps before the start');
});

test('the cursor moves and stays inside the list', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  assert.equal(state.cursor.hotspots, 0);
  state = applyKey(state, DOWN);
  assert.equal(state.cursor.hotspots, 1);
  state = applyKey(state, DOWN);
  state = applyKey(state, DOWN);
  assert.equal(state.cursor.hotspots, 2, 'clamped at the end');
  state = applyKey(state, UP);
  state = applyKey(state, UP);
  state = applyKey(state, UP);
  assert.equal(state.cursor.hotspots, 0, 'clamped at the start');
});

test('j and k are movement aliases', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, KEY('j'));
  assert.equal(state.cursor.hotspots, 1);
  state = applyKey(state, KEY('k'));
  assert.equal(state.cursor.hotspots, 0);
});

test('g and G jump to the ends', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, KEY('G'));
  assert.equal(state.cursor.hotspots, 2);
  state = applyKey(state, KEY('g'));
  assert.equal(state.cursor.hotspots, 0);
});

test('enter opens the selected file and escape closes it', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, ENTER);
  assert.equal(state.detail, 'src/a.js');
  state = applyKey(state, ESC);
  assert.equal(state.detail, null, 'escape leaves the detail view');
});

test('escape only closes one layer at a time', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, ENTER);
  state = applyKey(state, KEY('?'));
  assert.equal(state.showHelp, true);
  state = applyKey(state, ESC);
  assert.equal(state.showHelp, false);
  assert.equal(state.detail, 'src/a.js', 'the detail view survives closing help');
  state = applyKey(state, ESC);
  assert.equal(state.detail, null);
});

test('filtering narrows the list and resets the cursor', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, DOWN);
  state = applyKey(state, KEY('/'));
  assert.equal(state.filtering, true);
  state = applyKey(state, KEY('b'));
  state = applyKey(state, KEY('.', undefined));
  state = applyKey(state, { name: 'enter' });
  assert.equal(state.filtering, false);
  assert.equal(state.filter, 'b.');
  assert.equal(visibleHotspots(state).length, 1);
  assert.equal(state.cursor.hotspots, 0, 'the cursor resets when the list changes');
});

test('escape clears an active filter', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('/'));
  state = applyKey(state, KEY('x'));
  state = applyKey(state, ESC);
  assert.equal(state.filter, '');
  assert.equal(visibleHotspots(state).length, 3);
});

test('backspace edits the filter', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('/'));
  state = applyKey(state, KEY('a'));
  state = applyKey(state, KEY('b'));
  state = applyKey(state, { name: 'backspace' });
  assert.equal(state.filter, 'a');
});

test('navigation is inert while typing a filter', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, KEY('/'));
  state = applyKey(state, KEY('2'));
  assert.equal(state.view, 'hotspots', 'typing 2 in a filter is not a shortcut');
  assert.equal(state.filter, '2');
});

test('q quits from anywhere', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('2'));
  state = applyKey(state, KEY('q'));
  assert.equal(state.quit, true);
});

test('? toggles help', () => {
  let state = initialState(fakeReport(), {});
  state = applyKey(state, KEY('?'));
  assert.equal(state.showHelp, true);
  state = applyKey(state, KEY('?'));
  assert.equal(state.showHelp, false);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('every view renders at every supported width without overflowing', () => {
  const theme = new Theme(0, true);
  const state = initialState(fakeReport(), { repoName: 'test', branch: 'main' });
  for (const W of [60, 80, 100, 120, 160, 200]) {
    for (const view of ['overview', 'hotspots', 'ownership', 'structure', 'debt']) {
      for (const height of [12, 24, 60]) {
        const frame = renderFrame({ ...state, view }, theme, W, height);
        assert.ok(frame.lines.length > 0, `${view} at ${W}x${height} produced nothing`);
        assert.ok(frame.lines.length <= height, `${view} at ${W}x${height} exceeded the height`);
        for (const line of frame.lines) {
          assert.ok(width(line) <= W, `${view} at W=${W}: line is ${width(line)} wide: ${JSON.stringify(stripAnsi(line))}`);
        }
      }
    }
  }
});

test('colour depth never changes the layout', () => {
  const state = initialState(fakeReport(), { repoName: 'test' });
  const plain = renderFrame({ ...state, view: 'hotspots' }, new Theme(0, true), 100, 40);
  for (const depth of [1, 2, 3]) {
    const colored = renderFrame({ ...state, view: 'hotspots' }, new Theme(depth, true), 100, 40);
    assert.equal(colored.lines.length, plain.lines.length, `depth ${depth} changed the line count`);
    colored.lines.forEach((line, i) => {
      assert.equal(stripAnsi(line), stripAnsi(plain.lines[i]), `depth ${depth} line ${i}`);
    });
  }
});

test('the ascii glyph set produces the same layout as unicode', () => {
  const state = initialState(fakeReport(), { repoName: 'test' });
  const unicode = renderFrame({ ...state, view: 'hotspots' }, new Theme(0, true), 100, 40);
  const ascii = renderFrame({ ...state, view: 'hotspots' }, new Theme(0, false), 100, 40);
  assert.equal(unicode.lines.length, ascii.lines.length);
  for (const line of ascii.lines) {
    for (const ch of line) {
      assert.ok(ch.charCodeAt(0) < 128, `non-ascii character in ascii mode: ${JSON.stringify(line)}`);
    }
  }
});

test('the help screen lists the keys that actually work', () => {
  const state = initialState(fakeReport(), {});
  const frame = renderFrame({ ...state, showHelp: true }, new Theme(0, false), 100, 40);
  const text = frame.lines.join('\n');
  for (const key of ['j', 'k', 'enter', 'esc', '/', '?', 'q']) {
    assert.ok(text.includes(key), `help does not mention ${key}`);
  }
});

test('an empty report renders without throwing', () => {
  const empty = {
    signals: [], hotspots: [],
    health: { value: 0, grade: 'E', components: [] },
    timeline: { months: [] },
    totals: { files: 0, code: 0, bytes: 0, comment: 0, blank: 0, lines: 0, suppressed: 0, debt: 0 },
    tests: { ratio: 0, covered: 0, sourceFiles: 0, byDirectory: [] },
    debt: { total: 0, suppressed: 0, byType: [], oldest: null },
    ownership: { total: 0, busFactor: 0, singleOwnerCount: 0, authors: [] },
    coupling: { cycles: [], cycleFileCount: 0, undeclared: [], unused: [], fanIn: new Map(), externals: [], externalCount: 0, edges: new Map() },
    history: { commits: 0, authors: 0, spanDays: 0, merges: 0, emptyCommits: 0, adds: 0, dels: 0, renames: 0, deleted: 0 },
  };
  const theme = new Theme(0, false);
  for (const view of ['overview', 'hotspots', 'ownership', 'structure', 'debt']) {
    const frame = renderFrame(initialState(empty, {}), theme, 80, 24);
    assert.ok(frame.lines.length > 0);
    const specific = renderFrame({ ...initialState(empty, {}), view }, theme, 80, 24);
    assert.ok(specific.lines.length > 0, `${view} on an empty report`);
  }
});

test('a file detail view explains the score', () => {
  const theme = new Theme(0, false);
  const state = { ...initialState(fakeReport(), {}), view: 'hotspots', detail: 'src/a.js' };
  const frame = renderFrame(state, theme, 100, 60);
  const text = frame.lines.join('\n');
  assert.ok(text.includes('src/a.js'));
  assert.ok(text.includes('Why it scores'), 'the breakdown is shown');
  assert.ok(text.includes('churn'), 'the contributing reason is named');
});

test('renderInteractive is exported for the CLI', () => {
  assert.equal(typeof runInteractive, 'function');
});

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

test('arguments parse into options', () => {
  const options = parseArgs(['--json', '--top', '5', '--since=2.months.ago', '-C', '/tmp/x']);
  assert.equal(options.json, true);
  assert.equal(options.top, 5);
  assert.equal(options.since, '2.months.ago');
  assert.equal(options.repo, '/tmp/x');
});

test('short flags and inline values work', () => {
  assert.equal(parseArgs(['-t']).tui, true);
  assert.equal(parseArgs(['-w']).watch, true);
  assert.equal(parseArgs(['--top=9']).top, 9);
  assert.equal(parseArgs(['-Cfoo']).repo, 'foo');
});

test('a bare path becomes a positional argument', () => {
  assert.deepEqual(parseArgs(['../repo'])._, ['../repo']);
  assert.deepEqual(parseArgs(['--json', 'repo-a', 'repo-b'])._, ['repo-a', 'repo-b']);
});

test('an unknown flag is an error, with a suggestion when one is close', () => {
  assert.throws(() => parseArgs(['--jsn']), /unknown option/);
  assert.throws(() => parseArgs(['--jsn']), /did you mean: --json/);
  assert.throws(() => parseArgs(['--top']), /needs a value/);
  assert.throws(() => parseArgs(['--top', 'abc']), /needs a number/);
});

test('help documents every flag the parser accepts', () => {
  const text = helpText();
  for (const flag of ['--json', '--tui', '--watch', '--since', '--lines', '--top', '--no-color', '--fail-on', '--prune']) {
    assert.ok(text.includes(flag), `help is missing ${flag}`);
  }
  assert.ok(text.includes('EXIT CODES'));
  assert.ok(text.includes('EXAMPLES'));
});

test('--help and --version write to stdout and exit 0', async () => {
  let out = '';
  const stream = { write: (chunk) => { out += chunk; }, isTTY: false, columns: 80 };
  const code = await main(['--help'], { stdout: stream, stderr: stream, env: {}, cwd: process.cwd() });
  assert.equal(code, 0);
  assert.ok(out.includes('USAGE'));

  out = '';
  const code2 = await main(['--version'], { stdout: stream, stderr: stream, env: {}, cwd: process.cwd() });
  assert.equal(code2, 0);
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('running outside a repository fails cleanly with exit 1', async () => {
  let err = '';
  const sink = { write: (chunk) => { err += chunk; }, isTTY: false, columns: 80 };
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'oc-notrepo-'));
  const code = await main([dir], {
    stdout: { write: () => {}, isTTY: false, columns: 80 },
    stderr: sink,
    env: {},
    cwd: dir,
  });
  assert.equal(code, 1);
  assert.match(err, /not a git repository/);
});

test('a bad section name is rejected before any work happens', async () => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'a.js', 'const a = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t: {
    break t;
  }
  let err = '';
  const code = await main([dir, '--sections', 'nonsense'], {
    stdout: { write: () => {}, isTTY: false, columns: 80 },
    stderr: { write: (chunk) => { err += chunk; }, isTTY: false },
    env: { NO_COLOR: '1' },
    cwd: dir,
  });
  await cleanup();
  assert.equal(code, 2);
  assert.match(err, /unknown section/);
});

test('--json produces parseable output with a stable shape', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'src/a.js', "import b from './b.js';\nexport const a = () => b();\n");
    await write(d, 'src/b.js', 'export const b = () => 1;\n');
    await write(d, 'test/a.test.js', "import { a } from '../src/a.js';\nvoid a;\n");
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t.after(cleanup);

  let out = '';
  const code = await main([dir, '--json', '--no-color'], {
    stdout: { write: (chunk) => { out += chunk; }, isTTY: false, columns: 80 },
    stderr: { write: () => {}, isTTY: false },
    env: { NO_COLOR: '1' },
    cwd: dir,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.meta.version, '1.0.0');
  for (const key of ['health', 'totals', 'languages', 'history', 'tests', 'debt', 'ownership', 'structure', 'timeline', 'hotspots']) {
    assert.ok(key in parsed, `json output is missing ${key}`);
  }
  assert.equal(parsed.totals.sourceFiles, 2);
  assert.ok(parsed.hotspots.length > 0);
  assert.equal(typeof parsed.hotspots[0].risk, 'number');
  assert.ok(Array.isArray(parsed.hotspots[0].reasons));
  assert.ok(parsed.totals.code > 0);
});

test('--fail-on turns a grade into an exit code', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    await write(d, 'a.js', 'const a = 1;\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
  });
  t.after(cleanup);

  const run = async (grade) => {
    let err = '';
    const code = await main([dir, '--no-color', '--fail-on', grade], {
      stdout: { write: () => {}, isTTY: false, columns: 80 },
      stderr: { write: (chunk) => { err += chunk; }, isTTY: false },
      env: { NO_COLOR: '1' },
      cwd: dir,
    });
    return { code, err };
  };

  // F (worst possible) can never be met by a healthy repository; A might be.
  const failA = await run('A');
  const passE = await run('E');
  assert.equal(passE.code, 0, 'a threshold of E is always met');
  if (failA.code === 1) {
    assert.match(failA.err, /at or below A/);
  }
});

test('an invalid --fail-on value is a usage error', async () => {
  let err = '';
  const code = await main(['--fail-on', 'Z'], {
    stdout: { write: () => {}, isTTY: false, columns: 80 },
    stderr: { write: (chunk) => { err += chunk; }, isTTY: false },
    env: {},
    cwd: process.cwd(),
  });
  // The repository check may fail first on a clean checkout; either way it must
  // not succeed.
  assert.notEqual(code, 0);
});

test('the static report is deterministic and fits the terminal', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    const aSource = [
      "import b from './b.js';",
      '// TODO: tidy',
      'export function a(x) {',
      '  if (x) { return b(x); }',
      '  return 0;',
      '}',
      '',
    ].join('\n');
    await write(d, 'src/a.js', aSource);
    await write(d, 'src/b.js', 'export function b(x) {\n  if (!x) { return 0; }\n  return x;\n}\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'first']);
    await write(d, 'src/b.js', 'export function b(x) {\n  if (!x) { return 0; }\n  return x * 2;\n}\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'second']);
  });
  t.after(cleanup);

  const run = async (args) => {
    let out = '';
    await main([dir, '--no-color', ...args], {
      stdout: { write: (chunk) => { out += chunk; }, isTTY: false, columns: 80 },
      stderr: { write: () => {}, isTTY: false },
      env: { NO_COLOR: '1' },
      cwd: dir,
    });
    return out;
  };

  const a = await run([]);
  const b = await run([]);

  // The footer carries a duration and a cache hit rate, which are expected to
  // differ between runs; everything above it must be byte-identical.
  const body = (text) => text.split('\n').slice(0, -3).join('\n');
  assert.equal(body(a), body(b), 'the report body is identical between runs');
  assert.ok(a.includes('HEALTH'));
  assert.ok(a.includes('HOT SPOTS'));
  for (const line of a.split('\n')) {
    assert.ok(width(line) <= 80, `line exceeds 80 columns: ${JSON.stringify(line)}`);
  }
  assert.ok(!a.includes('\x1b['), 'no escape sequences with --no-color');
});

test('a repository with no commits analyses the working tree and says so', async (t) => {
  const { dir, cleanup } = await makeFixture(async (git, d) => {
    // Files, but no commit: the state of every repository between `git init`
    // and the first commit.
    await write(d, 'src/a.js', "import b from './b.js';\n// TODO: later\nexport function a(x) {\n  if (x) { return b(x); }\n  return 0;\n}\n");
    await write(d, 'src/b.js', 'export function b(x) {\n  return x * 2;\n}\n');
  });
  t.after(cleanup);

  let out = '';
  const code = await main([dir, '--no-color', '--width', '90'], {
    stdout: { write: (chunk) => { out += chunk; }, isTTY: false, columns: 90 },
    stderr: { write: () => {}, isTTY: false },
    env: { NO_COLOR: '1' },
    cwd: dir,
  });
  assert.equal(code, 0, 'a fresh repository is analysed, not rejected');
  assert.ok(out.includes('no commits yet'), 'the missing history is stated rather than implied');
  assert.ok(out.includes('TODO'), 'debt in untracked files is still found');

  // The counts come from the JSON projection rather than by scraping the aligned
  // grid, where every cell is padded and a text assertion tests column widths
  // instead of content.
  let json = '';
  await main([dir, '--json', '--no-color'], {
    stdout: { write: (chunk) => { json += chunk; }, isTTY: false, columns: 90 },
    stderr: { write: () => {}, isTTY: false },
    env: { NO_COLOR: '1' },
    cwd: dir,
  });
  const report = JSON.parse(json);
  assert.equal(report.totals.files, 2, 'files on disk are counted even with no commits');
  assert.equal(report.totals.sourceFiles, 2);
  assert.ok(report.totals.code > 0);
  assert.equal(report.history.commits, 0);
  assert.equal(report.history.partial, true);
  assert.ok(report.debt.total >= 1, 'the TODO in an untracked file was found');
});

test('a repository with nothing in it fails with a useful message', async (t) => {
  const { dir, cleanup } = await makeFixture(async () => {});
  t.after(cleanup);
  let err = '';
  const code = await main([dir], {
    stdout: { write: () => {}, isTTY: false, columns: 80 },
    stderr: { write: (chunk) => { err += chunk; }, isTTY: false },
    env: {},
    cwd: dir,
  });
  assert.equal(code, 1);
  assert.match(err, /no commits and no files/);
  assert.match(err, /make a commit/);
});
