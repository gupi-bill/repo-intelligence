import test from 'node:test';
import assert from 'node:assert/strict';
import {
  width, truncate, truncatePath, pad, detect, rgbTo256, rgbTo16, codepointWidth, makeColor,
} from '../src/render/ansi.mjs';

test('display width accounts for wide and zero-width characters', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('你好'), 4, 'CJK ideographs occupy two columns each');
  assert.equal(width('café'), 4, 'combining acute adds no width');
  assert.equal(width('한글'), 4);
  assert.equal(width('ｆｕｌｌ'), 8, 'fullwidth latin');
  assert.equal(width(''), 0);
});

test('escape sequences do not count toward width', () => {
  assert.equal(width('\x1b[38;2;1;2;3mred\x1b[0m'), 3);
  assert.equal(width('\x1b[1m\x1b[31mab\x1b[0m'), 2);
});

test('truncate fits within the budget and marks the cut', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcdef', 1), '…');
  assert.equal(truncate('abcdef', 0), '');
  assert.ok(width(truncate('你好世界你好世界', 6)) <= 6, 'never splits a wide character in half');
  assert.ok(width(truncate('\x1b[31mabcdef\x1b[0m', 4)) <= 4, 'escapes are preserved, not counted');
});

test('truncatePath keeps the readable tail', () => {
  assert.equal(truncatePath('a/b/c/d.ts', 40), 'a/b/c/d.ts');
  const short = truncatePath('src/very/deeply/nested/path/file.ts', 20);
  assert.ok(short.startsWith('…'), short);
  assert.ok(short.endsWith('file.ts'), short);
  assert.ok(width(short) <= 20, `${short} is ${width(short)} wide`);
});

test('pad fits to exactly the target width in both directions', () => {
  assert.equal(width(pad('ab', 6)), 6);
  assert.equal(width(pad('ab', 6, 'right')), 6);
  assert.equal(width(pad('ab', 6, 'center')), 6);
  assert.equal(pad('ab', 6), 'ab    ');
  assert.equal(pad('ab', 6, 'right'), '    ab');
  assert.equal(width(pad('abcdefgh', 4)), 4, 'overflow is truncated, not allowed through');
  assert.equal(width(pad('你好', 3)), 3, 'truncation respects wide characters');
  assert.equal(pad('x', 0), '');
});

test('colour degrades through the depth chain', () => {
  assert.equal(makeColor(0)() === '', true, 'depth 0 emits no escapes at all');
  assert.match(makeColor(3)(1, 2, 3), /38;2;1;2;3/);
  assert.match(makeColor(2)(1, 2, 3), /38;5;\d+/);
  assert.match(makeColor(1)(1, 2, 3), /38;5;\d+/);
});

test('rgb quantisation lands on the nearest colour', () => {
  assert.equal(rgbTo256(0, 0, 0), 16);
  assert.equal(rgbTo256(255, 255, 255), 231);
  assert.ok(rgbTo256(255, 0, 0) >= 196 && rgbTo256(255, 0, 0) <= 196, 'pure red is 196');
  assert.equal(rgbTo16(0, 0, 0), 0);
  assert.equal(rgbTo16(255, 255, 255), 15);
  assert.equal(rgbTo16(205, 49, 49), 1, 'close to the base red');
});

test('codepoint width covers the interesting cases', () => {
  assert.equal(codepointWidth(0x41), 1);
  assert.equal(codepointWidth(0x4e2d), 2);
  assert.equal(codepointWidth(0x200d), 0, 'zero-width joiner');
  assert.equal(codepointWidth(0x0301), 0, 'combining acute');
  assert.equal(codepointWidth(0x0a), 0, 'newline');
});

test('capability detection honours NO_COLOR and non-TTY', () => {
  const pipe = detect({ stream: { isTTY: false, columns: 0 }, env: {} });
  assert.equal(pipe.color, false, 'a pipe gets no colour');
  assert.equal(pipe.isTTY, false);

  const tty = { isTTY: true, columns: 120 };
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } }).depth, 3);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm-256color' } }).depth, 2);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm' } }).depth, 1);
  assert.equal(detect({ stream: tty, env: { TERM: 'dumb' } }).depth, 0);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm', NO_COLOR: '1' } }).depth, 0);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm-256color' }, color: 'never' }).depth, 0);
  assert.equal(detect({ stream: tty, env: {} , color: 'always' }).depth, 3);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm' }, width: 55 }).width, 55);
});

test('capability detection honours FORCE_COLOR', () => {
  const tty = { isTTY: true, columns: 80 };
  assert.equal(detect({ stream: tty, env: { TERM: 'dumb', FORCE_COLOR: '3' } }).depth, 3);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm-256color', FORCE_COLOR: '0' } }).depth, 0);
  assert.equal(detect({ stream: tty, env: { TERM: 'xterm-256color', NO_COLOR: '1', FORCE_COLOR: '3' } }).depth, 0,
    'NO_COLOR wins over FORCE_COLOR');
});
