/**
 * Language registry.
 *
 * Everything content-aware in oc (complexity, coupling, debt markers, test
 * detection) is driven by this table. Adding a language means adding one entry
 * here -- no other module needs to change.
 *
 * Each entry:
 *   name       canonical display name
 *   exts       file extensions, with the leading dot
 *   names      exact basenames (Dockerfile, Makefile, ...)
 *   line       line comment introducer(s), `//` or `#`
 *   block      [open, close] pair for block comments
 *   strings    quote characters that delimit string literals
 *   template   template/regex-safe quote char (JS backtick) -- treated as a string
 *   import     ordered list of [regex, groupIndex] describing how a dependency
 *              on another file is spelled. Applied to comment/string-stripped
 *              source, so these only need to match real code.
 *   test       patterns (regex) marking a file as a test
 *   keywords   extra branch keywords for cyclomatic complexity
 */

/** @type {Array<object>} */
const LANGUAGES = [
  {
    name: 'JavaScript',
    exts: ['.js', '.jsx', '.mjs', '.cjs'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'", '`'],
    import: [
      [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, 1],
      [/\bfrom\s+['"]([^'"]+)['"]/g, 1],
      [/\bimport\s+['"]([^'"]+)['"]/g, 1],
      [/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, 1],
      [/\brequire\.resolve\(\s*['"]([^'"]+)['"]/g, 1],
    ],
    test: [/(^|[/._-])(tests?|__tests__|spec|specs)([/._-]|$)/i, /\.(test|spec)\.[cm]?[jt]sx?$/i],
  },
  {
    name: 'TypeScript',
    exts: ['.ts', '.tsx', '.mts', '.cts'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'", '`'],
    import: [
      [/\bfrom\s+['"]([^'"]+)['"]/g, 1],
      [/\bimport\s+['"]([^'"]+)['"]/g, 1],
      [/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, 1],
      [/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, 1],
      [/\brequire\.resolve\(\s*['"]([^'"]+)['"]/g, 1],
    ],
    test: [/(^|[/._-])(tests?|__tests__|spec|specs)([/._-]|$)/i, /\.(test|spec)\.[cm]?tsx?$/i],
  },
  {
    name: 'Python',
    exts: ['.py', '.pyi', '.pyx'],
    line: '#',
    strings: ['"', "'"],
    import: [
      [/^\s*from\s+([.\w]+)\s+import\b/gm, 1],
      [/^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm, 1],
    ],
    test: [/(^|[/._-])(tests?|testing|spec)([/._-]|$)/i, /(^|[/._-])test_[^/]*\.py$/i, /_test\.py$/i],
  },
  {
    name: 'Go',
    exts: ['.go'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', '`'],
    import: [
      [/(?:^|\s)import\s+"([^"]+)"/g, 1],
      [/\bimport\s*\(\s*"([^"]+)"/g, 1],
      [/\s"([^"]+)"\s*$/gm, 1],
    ],
    test: [/_test\.go$/i],
  },
  {
    name: 'Rust',
    exts: ['.rs'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [
      [/\buse\s+([\w:]+)/g, 1],
      [/\bmod\s+([\w]+)\s*;/g, 1],
    ],
    test: [/[/\\]tests?[/\\]/i, /\bmod\s+tests\b/g],
  },
  {
    name: 'Java',
    exts: ['.java'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [/\bimport\s+(?:static\s+)?([\w.]+)/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /Test\.java$/],
  },
  {
    name: 'Kotlin',
    exts: ['.kt', '.kts'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [/\bimport\s+([\w.]+)/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /Test\.kt$/],
  },
  {
    name: 'C',
    exts: ['.c', '.h'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'"],
    import: [/#\s*include\s*[<"]([^>"]+)[>"]/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /_test\.c$/],
  },
  {
    name: 'C++',
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'"],
    import: [/#\s*include\s*[<"]([^>"]+)[>"]/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /_test\.cpp$/, /Test\.cpp$/],
  },
  {
    name: 'C#',
    exts: ['.cs', '.csx'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [/\busing\s+(?:static\s+)?([\w.]+)/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /Tests\.cs$/],
  },
  {
    name: 'Ruby',
    exts: ['.rb', '.rake', '.gemspec'],
    line: '#',
    block: ['=begin', '=end'],
    strings: ['"', "'"],
    import: [/\brequire(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g, 1],
    test: [/(^|[/._-])(tests?|spec)([/._-]|$)/i, /_spec\.rb$/],
  },
  {
    name: 'PHP',
    exts: ['.php'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'"],
    import: [/\b(?:use|require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /Test\.php$/],
  },
  {
    name: 'Swift',
    exts: ['.swift'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [/\bimport\s+([\w.]+)/g, 1],
    test: [/(^|[/._-])Tests?([/._-]|$)/],
  },
  {
    name: 'Scala',
    exts: ['.scala', '.sc'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [/\bimport\s+([\w.{}, _]+)/g, 1],
    test: [/(^|[/._-])specs?([/._-]|$)/i, /Spec\.scala$/],
  },
  {
    name: 'Shell',
    exts: ['.sh', '.bash', '.zsh', '.fish', '.ksh'],
    line: '#',
    strings: ['"', "'"],
    import: [/(?:^|\s)(?:source|\.)\s+([./\w-]+)/gm, 1],
    test: [/(^|[/._-])tests?([/._-]|$)/i, /\.?(test|spec)\.sh$/],
  },
  {
    name: 'Lua',
    exts: ['.lua'],
    line: '--',
    block: ['--[[', ']]'],
    strings: ['"', "'"],
    import: [/\brequire\s*\(?\s*['"]([^'"]+)['"]/g, 1],
    test: [/(^|[/._-])specs?([/._-]|$)/i, /_spec\.lua$/],
  },
  {
    name: 'Elixir',
    exts: ['.ex', '.exs'],
    line: '#',
    strings: ['"', "'"],
    import: [/\bimport\s+([\w.]+)/g, 1],
    test: [/(^|[/._-])test([/._-]|$)/i, /_test\.exs$/],
  },
  {
    name: 'Dart',
    exts: ['.dart'],
    line: '//',
    block: ['/*', '*/'],
    strings: ['"', "'"],
    import: [/\bimport\s+['"]([^'"]+)['"]/g, 1], // package:foo/bar.dart
    test: [/(^|[/._-])test([/._-]|$)/i, /_test\.dart$/],
  },
  {
    name: 'Vue',
    exts: ['.vue'],
    line: '//',
    block: ['<!--', '-->'],
    strings: ['"', "'", '`'],
    import: [/\bfrom\s+['"]([^'"]+)['"]/g, 1],
    test: [/(^|[/._-])(tests?|spec)([/._-]|$)/i],
  },
  {
    name: 'Svelte',
    exts: ['.svelte'],
    line: '//',
    block: ['<!--', '-->'],
    strings: ['"', "'", '`'],
    import: [/\bfrom\s+['"]([^'"]+)['"]/g, 1],
    test: [/(^|[/._-])(tests?|spec)([/._-]|$)/i],
  },
  {
    name: 'Zig',
    exts: ['.zig'],
    line: '//',
    strings: ['"'],
    import: [/@import\(\s*"([^"]+)"/g, 1],
    test: [/[/\\]tests?[/\\]/i],
  },
  {
    name: 'Nix',
    data: true,
    exts: ['.nix'],
    line: '#',
    block: ['/*', '*/'],
    strings: ['"'],
    import: [],
    test: [],
  },
  {
    name: 'Haskell',
    exts: ['.hs', '.lhs'],
    line: '--',
    block: ['{-', '-}'],
    strings: ['"'],
    import: [/\bimport\s+(?:qualified\s+)?([\w.]+)/g, 1],
    test: [/(^|[/._-])specs?([/._-]|$)/i],
  },
  {
    name: 'OCaml',
    exts: ['.ml', '.mli'],
    block: ['(*', '*)'],
    strings: ['"'],
    import: [],
    test: [],
  },
  {
    name: 'SQL',
    data: true,
    exts: ['.sql'],
    line: '--',
    block: ['/*', '*/'],
    strings: ["'", '"'],
    import: [],
    test: [],
  },
  {
    name: 'HTML',
    data: true,
    exts: ['.html', '.htm', '.vue.html'],
    block: ['<!--', '-->'],
    strings: ['"', "'"],
    import: [/<(?:script[^>]*src|link[^>]*href)=["']([^"']+)["']/gi, 1],
    test: [],
  },
  {
    name: 'CSS',
    data: true,
    exts: ['.css', '.scss', '.sass', '.less', '.styl'],
    block: ['/*', '*/'],
    strings: ['"', "'"],
    import: [/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g, 1, /@use\s+['"]([^'"]+)['"]/g, 1],
    test: [],
  },
  {
    name: 'Markdown',
    data: true,
    exts: ['.md', '.markdown', '.mdx'],
    line: '<!--',
    strings: [],
    import: [],
    test: [],
  },
  {
    name: 'YAML',
    data: true,
    exts: ['.yml', '.yaml'],
    line: '#',
    strings: ['"', "'"],
    import: [],
    test: [],
  },
  {
    name: 'JSON',
    data: true,
    exts: ['.json', '.jsonc', '.json5'],
    strings: ['"'],
    import: [],
    test: [],
  },
  {
    name: 'TOML',
    data: true,
    exts: ['.toml'],
    line: '#',
    strings: ['"', "'"],
    import: [],
    test: [],
  },
  {
    name: 'Make',
    data: true,
    exts: ['.mk'],
    line: '#',
    strings: ['"', "'"],
    import: [/-include\s+([\w./-]+)/g, 1],
    test: [],
  },
  {
    name: 'Docker',
    data: true,
    exts: ['.dockerfile'],
    line: '#',
    strings: ['"', "'"],
    import: [/^COPY\s+--from=\S+\s+(\S+)/gim, 1],
    test: [],
  },
];

/**
 * Branch keywords used for cyclomatic-complexity estimation. These are counted
 * on comment- and string-stripped source, grouped by language family so we do
 * not count Rust `match` arms in JavaScript.
 */
const BRANCH_KEYWORDS = {
  default: [
    'if', 'else if', 'for', 'while', 'case', 'catch', '&&', '||', '??', '?', 'except', 'elif',
    'when', 'unless', 'guard', 'select', 'rescue', 'ensure', 'foreach', 'do',
  ],
  curly: ['if', 'else if', 'for', 'foreach', 'while', 'case', 'catch', 'switch', 'when', '&&', '||', '??', '?.', 'do', 'loop', 'unless'],
  go: ['if', 'else if', 'for', 'case', 'select', 'switch', '&&', '||', 'go', 'defer', 'range', 'recover'],
  rust: ['if', 'else if', 'for', 'while', 'loop', 'match', 'if let', 'while let', '&&', '||', '?', 'catch'],
  python: ['if', 'elif', 'else if', 'for', 'while', 'except', 'and', 'or', 'case', 'match', 'assert'],
  shell: ['if', 'elif', 'for', 'while', 'case', 'until', '&&', '||', 'select'],
  functional: ['if', 'case', 'when', 'guard', 'match', 'cond', 'let', '|>', '&&', '||'],
};

const LANG_BRANCH_SET = {
  'Go': 'go',
  'Rust': 'rust',
  'Python': 'python',
  'Shell': 'shell',
  'Elixir': 'functional',
  'Haskell': 'functional',
  'OCaml': 'functional',
  'Scala': 'functional',
  'Erlang': 'functional',
  'Elixir ': 'functional',
  'C': 'curly',
  'C++': 'curly',
  'C#': 'curly',
  'Java': 'curly',
  'Kotlin': 'curly',
  'Swift': 'curly',
  'Dart': 'curly',
  'PHP': 'curly',
  'JavaScript': 'curly',
  'TypeScript': 'curly',
  'Vue': 'curly',
  'Svelte': 'curly',
  'Zig': 'curly',
  'Rust ': 'rust',
};

/** Basenames that pin a language regardless of extension. */
const FILENAME_LANGS = {
  dockerfile: 'Docker',
  makefile: 'Make',
  gnumakefile: 'Make',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  brewfile: 'Ruby',
  vagrantfile: 'Ruby',
  cmakelists: 'CMake',
  'cmakelists.txt': 'CMake',
  'go.mod': 'GoModule',
  'cargo.toml': 'Cargo',
  'package.json': 'Npm',
  'requirements.txt': 'PipRequirements',
  'pipfile': 'Pipfile',
  'gemfile.lock': 'GemfileLock',
};

const BRANCH_KEYWORD_SETS = BRANCH_KEYWORDS;

/** extension -> language definition */
const BY_EXT = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.exts) {
    if (!BY_EXT.has(ext)) BY_EXT.set(ext, lang);
  }
}

/** lowercase basename -> language name */
const BY_NAME = new Map();
for (const [name, value] of Object.entries(FILENAME_LANGS)) BY_NAME.set(name, value);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.avif', '.svgz',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm', '.aac',
  '.zip', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.tgz', '.zst', '.jar', '.war',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a', '.class', '.pyc', '.pyo', '.wasm',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.db', '.sqlite', '.sqlite3', '.mdb',
  '.psd', '.ai', '.sketch', '.blend', '.glb', '.gltf', '.obj', '.fbx', '.pack', '.idx',
]);

/**
 * Directory fragments that indicate vendored, generated or third-party code.
 * Coupling edges into these are recorded separately and excluded from the
 * project's own architecture graph -- depending on node_modules is not a
 * design signal.
 */
const VENDOR_SEGMENTS = new Set([
  'node_modules', 'vendor', 'third_party', 'thirdparty', 'bower_components',
  '.venv', 'venv', 'env', 'site-packages', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.output', '.cache', '.parcel-cache',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle', 'Pods',
  'DerivedData', '.terraform', '.idea', '.vscode-test',
]);

const GENERATED_SEGMENTS = new Set([
  'generated', 'gen', '__generated__', 'autogen', 'migrations', 'proto',
  'node_modules', 'dist', 'build', 'vendor', '.pb', 'schema', 'fixtures', 'snapshots', '__snapshots__',
]);

/**
 * Resolve a repository-relative path to a language definition.
 * @param {string} relPath
 * @returns {object|null}
 */
export function languageFor(relPath) {
  const slash = relPath.lastIndexOf('/');
  const base = (slash === -1 ? relPath : relPath.slice(slash + 1)).toLowerCase();
  const pinned = BY_NAME.get(base);
  if (pinned) return languageNamed(pinned);

  // `.d.ts` must win over `.ts`
  if (base.endsWith('.d.ts')) return BY_EXT.get('.ts') ?? null;

  const dot = base.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = base.slice(dot);
  return BY_EXT.get(ext) ?? null;
}

/**
 * Resolve a name pinned by exact filename (Dockerfile, Makefile, go.mod) to a
 * full language definition.
 *
 * These had been returning a bare hand-built object, which silently lacked the
 * `data` flag -- so a Dockerfile was scored for complexity and ended up in the
 * list of most-dangerous files, ranking above real code.
 */
const BY_DEFINITION_NAME = new Map([
  ['Docker', BY_EXT.get('.dockerfile')],
  ['Make', BY_EXT.get('.mk')],
  ['CMake', { name: 'CMake', data: true, exts: [], line: '#', strings: [], import: [], test: [] }],
  ['Npm', { name: 'Npm', data: true, exts: [], line: '#', strings: ['"', "'"], import: [], test: [] }],
  ['GoModule', { name: 'GoModule', data: true, exts: [], line: '//', strings: ['"', '`'], import: [], test: [] }],
  ['Cargo', { name: 'Cargo', data: true, exts: [], line: '#', strings: ['"'], import: [], test: [] }],
  ['PipRequirements', { name: 'PipRequirements', data: true, exts: [], line: '#', strings: [], import: [], test: [] }],
  ['Pipfile', { name: 'Pipfile', data: true, exts: [], line: '#', strings: [], import: [], test: [] }],
  ['GemfileLock', { name: 'GemfileLock', data: true, exts: [], line: '#', strings: [], import: [], test: [] }],
]);

function languageNamed(name) {
  const known = BY_DEFINITION_NAME.get(name);
  if (known) return known;
  return { name, data: true, exts: [], line: '#', strings: [], import: [], test: [] };
}

/** True if the extension is known-binary. */
export function isBinaryPath(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXTS.has(base.slice(dot));
}

/** True if any path segment marks vendored / third-party code. */
export function isVendorPath(relPath) {
  if (relPath.includes('node_modules/')) return true;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (VENDOR_SEGMENTS.has(parts[i])) return true;
  }
  return false;
}

/** True if the path looks machine-generated (still counted, but flagged). */
export function isGeneratedPath(relPath) {
  const parts = relPath.split('/');
  for (const part of parts) {
    if (GENERATED_SEGMENTS.has(part)) return true;
  }
  return /\.pb\.[a-z]+$|\.g\.[a-z]+$|\.gen\.[a-z]+$|\.generated\.[a-z]+$|\.min\.[a-z]+$|_pb2?\.pyi?$|_pb\.[a-z]+$/i.test(relPath);
}

/** True if a language definition marks this path as a test file. */
export function isTestPath(relPath, lang) {
  if (!lang) return false;
  for (const re of lang.test) {
    if (re.test(relPath)) return true;
  }
  return false;
}

/** Branch keywords relevant to a language. */
export function branchKeywords(langName) {
  const set = LANG_BRANCH_SET[langName] ?? 'default';
  return BRANCH_KEYWORD_SETS[set] ?? BRANCH_KEYWORD_SETS.default;
}

/** All known language names, for docs/tests. */
export function allLanguageNames() {
  return LANGUAGES.map((l) => l.name);
}

/** Resolve a bare import specifier to a repo-relative file, or null. */
export function resolveRelativeImport(fromPath, spec) {
  if (!spec.startsWith('.')) return null;
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const joined = fromDir + spec;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}
