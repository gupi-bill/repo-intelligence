/**
 * Coupling analysis.
 *
 * Resolves the import graph from the stripped-source specifiers collected during
 * scanning, then reports the things that actually matter about a codebase's
 * shape:
 *
 *   - import cycles (Tarjan's strongly connected components), because a cycle
 *     is the one dependency problem no amount of good intentions prevents;
 *   - blast radius (fan-in), which is what tells you how dangerous a change is;
 *   - undeclared and unused dependencies, which is a build-breaking bug class
 *     that static analysis usually misses.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { languageFor } from '../core/lang.mjs';

/** Extensions probed when an import omits one. */
const PROBE_EXT = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.cs', '.php', '.vue', '.svelte', '.dart',
];
const INDEX_NAMES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs',
  'index.py', 'index.vue', 'index.go', 'index.rs', 'index.dart',
];

/**
 * @param {object} opts
 * @param {object[]} opts.records  from core/workspace.mjs
 * @param {object} opts.index     from buildIndex(records)
 * @returns {Promise<{
 *   edges: Map<string, Set<string>>,
 *   externals: Map<string, number>,
 *   cycles: string[][],
 *   fanIn: Map<string, number>,
 *   fanOut: Map<string, number>,
 * }>}
 */
export async function buildCoupling({ records, index, root }) {
  /** @type {Map<string, Set<string>>} importer -> imported project files */
  const edges = new Map();
  /** @type {Map<string, number>} external specifier -> number of importers */
  const externals = new Map();
  /** @type {Set<string>} importers that could not be resolved at all */
  const unresolved = new Set();

  for (const record of records) {
    const shape = record.shape;
    if (!shape || shape.skip || !shape.imports || shape.imports.length === 0) continue;
    const set = new Set();
    for (const spec of shape.imports) {
      const target = resolve(spec, record.rel, index);
      if (target === null) {
        const key = externalName(spec);
        if (key) {
          externals.set(key, (externals.get(key) ?? 0) + 1);
          set.add(`\u0000ext:${key}`);
        } else {
          unresolved.add(spec);
        }
        continue;
      }
      if (target === record.rel) continue; // self-import is not coupling
      set.add(target);
    }
    if (set.size > 0) edges.set(record.rel, set);
  }

  const fanIn = new Map();
  const fanOut = new Map();
  for (const [from, tos] of edges) {
    const outs = [...tos].filter((t) => !t.startsWith('\u0000ext:'));
    fanOut.set(from, outs.length);
    for (const to of outs) fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  }

  const cycles = findCycles(edges, index);
  const manifest = await readManifests(root, records);
  const { undeclared, unused } = reconcile(externals, manifest);

  return { edges, externals, cycles, fanIn, fanOut, unresolved: [...unresolved], undeclared, unused, manifest };
}

/**
 * Resolve one import specifier to a project-relative path, a namespaced
 * external marker, or null when it cannot be classified.
 */
export function resolve(spec, fromRel, index) {
  if (typeof spec !== 'string' || spec === '') return null;

  // Strip bundler/language prefixes that are not part of the filesystem path.
  let clean = spec;
  if (clean.startsWith('package:')) clean = clean.slice(8);
  if (clean.startsWith('dart:')) return null;
  if (clean.startsWith('node:')) clean = clean.slice(5);
  if (clean.startsWith('bun:')) clean = clean.slice(4);
  if (clean.startsWith('file://')) clean = clean.slice(7);
  if (clean.startsWith('#') || clean.startsWith('~') || clean.startsWith('@/')) {
    clean = `./${clean.replace(/^[#~@]+\/?/, '')}`;
  }

  if (clean.startsWith('.')) {
    return probe(joinPath(fromRel, clean), index);
  }

  // Most ecosystems spell imports relative to the *importer's* directory, but
  // Python, Java, Kotlin, C#, Go and Rust all resolve them from a package or
  // module root instead. `api/tests/unit/test_user.py` writing
  // `from services.user import User` means `api/services/user.py`, which is not
  // reachable from the importer's own directory. So try the importer's
  // directory, then each ancestor up to the repository root, then the root
  // itself. First hit wins, which is also the order a real module resolver
  // would use.
  if (/^[A-Za-z_][\w./-]*$/.test(clean)) {
    const dotted = clean.includes('/') ? clean : clean.replace(/\./g, '/');
    const bases = importerBases(fromRel);
    for (const base of bases) {
      const found = probe(base ? `${base}/${dotted}` : dotted, index);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Candidate base directories for a non-relative import, nearest first.
 * Bounded to a handful of levels: beyond that, a miss almost certainly means
 * the specifier is a package name and further probing is wasted work.
 */
function importerBases(fromRel) {
  const parts = fromRel.split('/');
  parts.pop(); // drop the filename
  const bases = [];
  for (let i = parts.length; i >= 0; i -= 1) {
    bases.push(parts.slice(0, i).join('/'));
    if (parts.length - i > 6) break;
  }
  // A conventional source root is a strong final guess for monorepos.
  if (!bases.includes('src')) bases.push('src');
  return bases;
}

/** Try every conventional shape for a path that may omit its extension. */
function probe(base, index) {
  const trimmed = base.replace(/\/+$/, '');
  if (index.byPath.has(trimmed)) return trimmed;
  for (const ext of PROBE_EXT) {
    if (index.byPath.has(trimmed + ext)) return trimmed + ext;
  }
  for (const name of INDEX_NAMES) {
    const candidate = `${trimmed}/${name}`;
    if (index.byPath.has(candidate)) return candidate;
  }
  // Deliberately no basename fallback. Matching a bare specifier to *any* file
  // with that stem anywhere in the repository is unsound: it turned a specifier
  // like `react` into an edge to `packages/tsconfig/react.json`, which then
  // reported that JSON file as having 2,374 importers. Missing an edge is a much
  // smaller error than inventing one.
  return null;
}

function joinPath(fromRel, rel) {
  const dir = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
  const parts = [];
  for (const seg of (dir + rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Reduce a module specifier to the name of the package it comes from. */
export function externalName(spec) {
  let clean = spec;
  if (clean.startsWith('package:')) clean = clean.slice(8);
  if (clean.startsWith('node:')) clean = clean.slice(5);
  if (clean.startsWith('@')) {
    const parts = clean.split('/');
    return parts.slice(0, 2).join('/');
  }
  const head = clean.split(/[/:]/)[0];
  if (!head) return null;
  // A single bare word is a local file in some ecosystems, not a package.
  if (!/[@/.:]/.test(clean) && !/^[a-z][a-z0-9_-]*$/i.test(clean)) return null;
  return head;
}

/**
 * Tarjan's algorithm, iterative so a deep graph cannot blow the stack.
 * Returns only components with more than one member, plus self-loops.
 */
export function findCycles(edges, index) {
  const nodes = new Set();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos) {
      if (!to.startsWith('\u0000ext:')) nodes.add(to);
    }
  }
  for (const node of nodes) {
    if (!index.byPath.has(node)) nodes.delete(node);
  }

  const indexOf = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;

  for (const root of nodes) {
    if (indexOf.has(root)) continue;
    // frame: [node, edgeIterator over children]
    const work = [[root, null]];
    indexOf.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame[0];
      const children = edges.get(node);
      if (frame[1] === null) frame[1] = 0;
      const childList = children ? [...children].filter((c) => !c.startsWith('\u0000ext:')) : [];
      if (frame[1] < childList.length) {
        const child = childList[frame[1]];
        frame[1] += 1;
        if (!nodes.has(child)) continue;
        if (!indexOf.has(child)) {
          indexOf.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push([child, null]);
        } else if (onStack.has(child)) {
          low.set(node, Math.min(low.get(node), indexOf.get(child)));
        }
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === indexOf.get(node)) {
        const component = [];
        for (;;) {
          const popped = stack.pop();
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        if (component.length > 1) result.push(component.sort());
      }
    }
  }
  return result;
}

/** Read the dependency manifests that actually exist in this repository. */
async function readManifests(root, records) {
  const known = {
    'package.json': 'npm',
    'requirements.txt': 'pip',
    'pyproject.toml': 'pypi',
    'Pipfile': 'pipenv',
    'go.mod': 'go',
    'Cargo.toml': 'cargo',
    'Gemfile': 'bundler',
    'composer.json': 'composer',
    'pubspec.yaml': 'pub',
    'build.gradle': 'gradle',
    'pom.xml': 'maven',
  };
  const found = new Map();
  for (const record of records) {
    const base = record.rel.slice(record.rel.lastIndexOf('/') + 1);
    const kind = known[base];
    if (!kind) continue;
    // Only consider root-level manifests; a nested example app's manifest is
    // not the project's dependency list.
    if (record.rel.includes('/')) continue;
    const parsed = await parseManifest(join(root, record.rel), kind);
    if (!parsed) continue;
    // Normalise here so every consumer sees plain arrays, never a raw parse
    // result. Manifest shapes differ per ecosystem; this is the only place that
    // has to know that.
    found.set(record.rel, {
      kind,
      declared: parsed.dependencies ?? [],
      devDependencies: parsed.devDependencies ?? [],
    });
  }
  return found;
}

async function parseManifest(path, kind) {
  try {
    const text = await readFile(path, 'utf8');
    if (kind === 'npm') {
      const parsed = JSON.parse(text);
      return {
        dependencies: Object.keys(parsed.dependencies ?? {}),
        devDependencies: Object.keys(parsed.devDependencies ?? {}),
      };
    }
    if (kind === 'pip' || kind === 'pipenv') {
      const names = [];
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Za-z0-9_.-]+)\s*(?:[=<>!~[]|$)/.exec(line);
        if (match && !line.trimStart().startsWith('#')) names.push(normalizePy(match[1]));
      }
      return { dependencies: names };
    }
    if (kind === 'go') {
      const block = /require\s*\(([^)]*)\)/.exec(text);
      const names = [];
      if (block) {
        for (const line of block[1].split('\n')) {
          const match = /^\s*([^\s]+)\s+v/.exec(line);
          if (match) names.push(match[1]);
        }
      }
      return { dependencies: names };
    }
    if (kind === 'cargo') {
      const names = [];
      const block = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(text);
      if (block) {
        for (const line of block[1].split('\n')) {
          const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
          if (match) names.push(match[1]);
        }
      }
      return { dependencies: names };
    }
    if (kind === 'bundler' || kind === 'composer') {
      const names = [];
      const block = kind === 'bundler'
        ? /gem\s+['"]([^'"]+)['"]/g
        : /"([^"]+)"\s*:\s*["'][~^*]/g;
      let match = block.exec(text);
      while (match) {
        names.push(match[1]);
        match = block.exec(text);
      }
      return { dependencies: names };
    }
    if (kind === 'pypi') {
      const names = [];
      const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text);
      if (block) {
        for (const line of block[1].split('\n')) {
          const match = /["']([A-Za-z0-9_.-]+)/.exec(line);
          if (match) names.push(normalizePy(match[1]));
        }
      }
      return { dependencies: names };
    }
    return { dependencies: [] };
  } catch {
    return null;
  }
}

function normalizePy(name) {
  return name.toLowerCase().replace(/_/g, '-');
}

/**
 * Compare imported packages against declared ones.
 *
 * The comparison is deliberately fuzzy in one direction only: an import we
 * cannot match to a manifest is reported, but a package that looks like a
 * standard-library or platform module is never reported, because a false
 * "undeclared dependency" is noise that trains people to ignore the section.
 */
function reconcile(externals, manifest) {
  if (manifest.size === 0) return { undeclared: [], unused: [] };
  const declared = new Set();
  const declaredDev = new Set();
  const kinds = new Set();
  for (const { kind, declared: names, devDependencies } of manifest.values()) {
    kinds.add(kind);
    for (const name of names) declared.add(name.toLowerCase());
    for (const name of devDependencies ?? []) declaredDev.add(name.toLowerCase());
  }

  const undeclared = [];
  for (const [name, importers] of externals) {
    const lower = name.toLowerCase();
    if (declared.has(lower) || declaredDev.has(lower)) continue;
    if (isStandardLibrary(lower, kinds)) continue;
    if (isLikelyLocalName(lower)) continue;
    undeclared.push({ name, importers });
  }
  undeclared.sort((a, b) => b.importers - a.importers);

  // "Unused" only makes sense for a single-manifest project; a monorepo with
  // several manifests will always look over-declared.
  if (manifest.size > 1) return { undeclared, unused: [] };
  const used = new Set([...externals.keys()].map((n) => n.toLowerCase()));
  const unused = [];
  for (const name of declared) {
    if (used.has(name)) continue;
    if (isStandardLibrary(name, kinds)) continue;
    if (name === 'self') continue;
    // Scoped packages are declared as @scope/name but imported the same way;
    // a subpath import would show up separately, so skip anything scoped.
    if (name.startsWith('@')) continue;
    unused.push(name);
  }
  unused.sort();
  return { undeclared, unused: unused.slice(0, 50) };
}

const PY_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'random', 'itertools', 'functools',
  'collections', 'typing', 'pathlib', 'subprocess', 'threading', 'logging', 'io', 'abc', 'enum',
  'dataclasses', 'asyncio', 'unittest', 'hashlib', 'base64', 'urllib', 'http', 'socket', 'ssl',
  'shutil', 'tempfile', 'uuid', 'copy', 'pickle', 'csv', 'jsonlines', 'textwrap', 'warnings',
  'contextlib', 'inspect', 'operator', 'string', 'traceback', 'types', 'ast', 'glob', 'signal',
  'stat', 'struct', 'binascii', 'gzip', 'zlib', 'platform', 'getpass', 'secrets', 'statistics',
]);

const NODE_STDLIB = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process',
  'crypto', 'zlib', 'buffer', 'assert', 'net', 'tls', 'dns', 'readline', 'worker_threads',
  'cluster', 'querystring', 'string_decoder', 'timers', 'v8', 'vm', 'perf_hooks', 'async_hooks',
  'punycode', 'tty', 'process', 'module', 'constants', 'assert/strict', 'fs/promises',
  'node:test', 'inspector', 'repl', 'stream/consumers', 'stream/promises', 'stream/web',
  'util/types', 'timers/promises', 'timers/promises', 'sqlite', 'sea', 'test', 'diagnostics_channel',
]);

const GO_STDLIB = new Set([
  'bufio', 'bytes', 'context', 'crypto', 'database', 'embed', 'encoding', 'errors', 'fmt', 'hash',
  'html', 'image', 'index', 'io', 'log', 'math', 'mime', 'net', 'os', 'path', 'reflect', 'regexp',
  'runtime', 'sort', 'strconv', 'strings', 'sync', 'syscall', 'testing', 'text', 'time', 'unicode',
  'unsafe', 'slices', 'maps', 'cmp', 'iter', 'unique', 'weak', 'structs', 'arena', 'log/slog',
]);

const RUST_STDLIB = new Set([
  'std', 'core', 'alloc', 'crate', 'self', 'super', 'test', 'serde', 'tokio', 'anyhow', 'thiserror',
  'clap', 'log', 'regex', 'lazy_static', 'once_cell', 'itertools', 'rand', 'chrono', 'uuid', 'futures',
]);

const JAVA_STDLIB = new Set([
  'java', 'javax', 'jakarta', 'kotlin', 'scala', 'android', 'sun', 'com', 'org', 'io', 'net',
]);

function isStandardLibrary(name, kinds) {
  const has = (set) => set.has(name);
  if (kinds.has('pip') || kinds.has('pipenv') || kinds.has('pypi')) {
    if (has(PY_STDLIB)) return true;
  }
  if (kinds.has('npm')) {
    if (has(NODE_STDLIB)) return true;
  }
  if (kinds.has('go') && has(GO_STDLIB)) return true;
  if (kinds.has('cargo') && has(RUST_STDLIB)) return true;
  if ((kinds.has('gradle') || kinds.has('maven')) && has(JAVA_STDLIB)) return true;
  return false;
}

/**
 * Short, common, lowercase-only words are almost always project directories
 * (`utils`, `models`, `lib`) rather than packages. Reporting them would bury the
 * real findings.
 */
function isLikelyLocalName(name) {
  return LOCAL_NAME_HINTS.has(name);
}

const LOCAL_NAME_HINTS = new Set([
  'utils', 'util', 'helpers', 'helper', 'lib', 'libs', 'common', 'shared', 'core', 'types',
  'models', 'model', 'services', 'service', 'components', 'component', 'hooks', 'api', 'app',
  'main', 'index', 'config', 'constants', 'consts', 'internal', 'pkg', 'internal', 'domain',
  'src', 'client', 'server', 'test', 'tests', 'spec', 'scripts', 'tools', 'vendor', 'assets',
]);
