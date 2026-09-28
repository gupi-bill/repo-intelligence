import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeOf, measureCode, extractImports, looksBinary } from '../src/core/scan.mjs';
import { languageFor, resolveRelativeImport, isTestPath, isVendorPath, isGeneratedPath, isBinaryPath } from '../src/core/lang.mjs';

const js = languageFor('a.js');
const ts = languageFor('a.ts');
const py = languageFor('a.py');
const yaml = languageFor('a.yaml');

test('line census separates code, comment and blank', () => {
  const source = [
    '// leading comment',
    '',
    'const a = 1;',
    '/* block',
    '   still comment',
    '   end */',
    'const b = 2; // trailing',
    '',
    '   ',
  ].join('\n');
  const shape = shapeOf(source, js);
  assert.equal(shape.total, 9, 'nine lines, the last without a trailing newline');
  assert.equal(shape.code, 2, 'only the two `const` lines contain code');
  assert.equal(shape.comment, 4, 'the leading comment plus three block-comment lines');
  assert.equal(shape.blank, 3, 'indentation alone is not a line of code');
});

test('a question mark inside a string is not a decision point', () => {
  const withLiteral = shapeOf('const q = "is it? really?";\n', js);
  measureCode(withLiteral, js);
  assert.equal(withLiteral.decisions, 0, 'no decision points in a plain string assignment');
});

test('keywords inside comments are not counted', () => {
  const source = [
    '// if for while case catch switch',
    '/* if for while */',
    'const x = 1;',
  ].join('\n');
  const shape = shapeOf(source, js);
  measureCode(shape, js);
  assert.equal(shape.decisions, 0, 'comments contribute no decisions');
});

test('real branching is counted', () => {
  const source = [
    'function f(a, b) {',
    '  if (a) { return 1; }',
    '  for (const x of b) { if (x) { return 2; } }',
    '  try { g(); } catch (e) { return 3; }',
    '  return a ? 1 : 2;',
    '}',
  ].join('\n');
  const shape = shapeOf(source, js);
  measureCode(shape, js);
  assert.equal(shape.decisions, 4, 'if, for, if, catch');
  assert.equal(shape.funcs, 1);
  assert.ok(shape.maxDepth >= 2, 'nesting is recorded');
});

test('a template literal with interpolation does not derail the scan', () => {
  const source = 'const s = `a ${cond ? 1 : 2} b`;\nconst t = 2;\n';
  const shape = shapeOf(source, js);
  measureCode(shape, js);
  assert.equal(shape.code, 2, 'both lines are code');
});

test('a hash inside a string is not a python comment', () => {
  const source = 'color = "#ff0000"  # trailing comment\nx = 1\n';
  const shape = shapeOf(source, py);
  assert.equal(shape.code, 2);
  assert.equal(shape.comment, 0, 'the hash is inside a string, so the line is code');
});

test('python comments are found', () => {
  const source = '# TODO: fix this\nx = 1\n# and this\n';
  const shape = shapeOf(source, py);
  assert.equal(shape.comment, 2);
});

test('debt markers are collected with line numbers and text', () => {
  const source = [
    '// TODO: rewrite this parser',
    'const a = 1;',
    '/* FIXME the off-by-one */',
  ].join('\n');
  const shape = shapeOf(source, js);
  const labels = shape.debt.map((d) => d.marker).sort();
  assert.deepEqual(labels, ['FIXME', 'TODO']);
  const todo = shape.debt.find((d) => d.marker === 'TODO');
  assert.equal(todo.line, 1);
  assert.match(todo.text, /rewrite this parser/);
});

test('debt markers inside strings are not reported', () => {
  const shape = shapeOf('const msg = "TODO: not a real marker";\n', js);
  assert.equal(shape.debt.length, 0);
});

test('suppression directives are counted', () => {
  const source = [
    '/* eslint-disable no-console */',
    '// @ts-ignore',
    'const a = 1;',
  ].join('\n');
  const shape = shapeOf(source, js);
  assert.equal(shape.suppressed, 2, `eslint-disable and @ts-ignore, got ${shape.suppressed}`);
});

test('a whitespace-only line is blank, not code', () => {
  const shape = shapeOf('def f():\n    \n    return 1\n', py);
  assert.equal(shape.total, 3);
  assert.equal(shape.code, 2, 'the `def` line and the `return` line');
  assert.equal(shape.blank, 1, 'the indented line in between is blank');
});

test('imports are extracted per language', () => {
  const esm = shapeOf([
    "import fs from 'node:fs';",
    "import { a } from './a.js';",
    "const b = require('./b');",
    "const c = await import('./c.js');",
  ].join('\n'), js);
  const esmImports = extractImports(esm, js);
  assert.ok(esmImports.includes('./a.js'), esmImports.join(','));
  assert.ok(esmImports.includes('./b'), esmImports.join(','));

  const pyShape = shapeOf([
    'from .relative import thing',
    'from services.user import User',
    'import os',
  ].join('\n'), py);
  const pyImports = extractImports(pyShape, py);
  assert.ok(pyImports.includes('services.user'), pyImports.join(','));
  assert.ok(pyImports.includes('os'), pyImports.join(','));
});

test('typescript-only syntax is recognised', () => {
  const shape = shapeOf('import type { X } from "./x";\nexport const y: X = {} as X;\n', ts);
  assert.ok(extractImports(shape, ts).includes('./x'));
});

test('binary content is detected', () => {
  assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.equal(looksBinary(Buffer.from('plain text', 'utf8')), false);
});

test('yaml data files produce no decisions', () => {
  const source = 'version: 2\njobs:\n  build:\n    if: true\n';
  const shape = shapeOf(source, yaml);
  measureCode(shape, yaml);
  assert.equal(shape.decisions, 0, 'a data file is not code');
});

test('language detection covers the common cases', () => {
  assert.equal(languageFor('src/a.ts').name, 'TypeScript');
  assert.equal(languageFor('src/a.tsx').name, 'TypeScript');
  assert.equal(languageFor('src/types.d.ts').name, 'TypeScript');
  assert.equal(languageFor('main.go').name, 'Go');
  assert.equal(languageFor('lib.rs').name, 'Rust');
  assert.equal(languageFor('Dockerfile').name, 'Docker');
  assert.equal(languageFor('weird.unknownext'), null, 'unknown extension resolves to null');
});

test('vendor, generated, binary and test paths are classified', () => {
  assert.equal(isVendorPath('node_modules/react/index.js'), true);
  assert.equal(isVendorPath('web/app/main.ts'), false);
  assert.equal(isGeneratedPath('api/models/schema.gen.ts'), true);
  assert.equal(isBinaryPath('logo.png'), true);
  assert.equal(isTestPath('web/foo.test.ts', languageFor('web/foo.test.ts')), true);
  assert.equal(isTestPath('api/tests/test_user.py', py), true);
  assert.equal(isTestPath('src/app.py', py), false);
  assert.equal(isTestPath('pkg/handler_test.go', languageFor('pkg/handler_test.go')), true);
});

test('relative import resolution normalises . and ..', () => {
  assert.equal(resolveRelativeImport('src/a/b/c.js', './d.js'), 'src/a/b/d.js');
  assert.equal(resolveRelativeImport('src/a/b/c.js', '../d.js'), 'src/a/d.js');
  assert.equal(resolveRelativeImport('src/a/c.js', '../../d.js'), 'd.js');
  assert.equal(resolveRelativeImport('src/a/c.js', './sub/../e.js'), 'src/a/e.js');
});
