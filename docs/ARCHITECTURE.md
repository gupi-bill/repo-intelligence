# Architecture

`oc` is one process, no dependencies, and four stages that never hold more than
they need to.

```
  git index ─┐
             ├─► collect ─► scan ──────────────┐
  disk ──────┘    (stat)   (workers, cached)   │
                                                ├─► analyse ─► render
  git log ──────────────► history ──────────────┤      ▲          │
   (one stream)          (aggregates only)      │      │          │
                                                └──────┘          │
  import graph ───────────────────────────────────┘                 ▼
                                                    stdout (report / json)
                                                    stderr (progress)
```

## Module map

```
bin/oc.mjs                 entry point: error to message, error to exit code

src/cli.mjs                flag table, argument parser, watch loop, JSON projection
src/version.mjs            the single version constant

src/core/git.mjs           every git invocation; the streaming log parser
src/core/lang.mjs          language registry: extensions, comments, import grammar
src/core/scan.mjs          the source scanner (one character pass per file)
src/core/worker.mjs        worker entry point: read, measure, return
src/core/pool.mjs          bounded worker pool and batch planning
src/core/workspace.mjs     file enumeration, cache orchestration, inline fallback
src/core/cache.mjs         sharded on-disk cache, self-invalidating

src/analyze/history.mjs    streaming commit aggregator, rename inference
src/analyze/coupling.mjs   import resolution, Tarjan SCC, manifest reconciliation
src/analyze/report.mjs     risk model, health model, rankings

src/render/ansi.mjs        capability detection, display width, truncation
src/render/theme.mjs       semantic palette, glyph sets, both colour ramps
src/render/widgets.mjs     bars, sparklines, meters, tables, number formatting
src/render/report.mjs      the static report
src/render/tui.mjs         interactive explorer: state, pure views, terminal driver
src/render/progress.mjs    the stderr progress indicator
```

The dependency direction is strictly downward: `render` knows about `analyze`,
`analyze` knows about `core`, `core` knows about nothing but Node's standard
library. No module imports one that imports it.

## The git wire format

Everything `oc` knows about history comes from one streaming pass of

```
git log --all --date=short -z --name-only --no-renames \
  --pretty=format:%x01%H%x02%an%x02%ae%x02%ad%x02%P%x02%s
```

For a 45,000-commit repository that is roughly 12 MB of text, which is why the
parser is incremental and why nothing keeps a list of commits.

The exact shape of a record is the whole contract, and it is not what you would
guess:

```
record := \x01 hash \x02 author \x02 email \x02 date \x02 parents \x02 subject
          [ \n ] token \0 token \0 ... \0
```

Three things about that are worth stating explicitly, because each one was a bug
before it was documented:

- **`--pretty=format:` emits no trailing newline.** The newline between the header
  and the file list exists only when the commit *has* a file list. A parser that
  scans to the next newline to end the header will, on a merge commit, run past
  the end of the record and swallow the next one. On the 45k-commit test
  repository this silently lost 11.6% of all commits.
- **The subject is terminated by `\n` or `\0`, never by `\x01`.** Commit messages
  may legally contain `\x01`; git refuses only `\0`. Treating the record marker as
  a subject terminator loses records on any repository that contains such a
  commit.
- **The last token of a record is always empty.** That makes "empty token" an
  unambiguous end-of-record marker, and it is what lets a single forward scan
  recover the whole structure with no lookahead.

The parser keeps a cursor into the buffer and compacts lazily, so cost is linear
in bytes rather than quadratic in record length.

`scripts/verify-parser.mjs` runs this against any repository and compares the
result to `git log`, both as a whole and one commit at a time. It is how the
capture-group bug described below was found: a shard that returned nothing looked
exactly like a dead keyboard. The sharded path partitions the commit range with `--skip`/`--max-count`, which
slice git's deterministic newest-first order into disjoint, provably complete
ranges. It is worth only about 15% on a busy disk, and the code is not currently
used by default; the option is exercised by `verify-parser.mjs --shards`.

`test/git-stream.test.mjs` builds
a repository containing merges, empty commits, renames, binary files, paths with
spaces and non-ASCII characters, and a commit subject containing real `\x01` and
`\x02` bytes, then asserts the parser sees exactly what `git log` sees — compared
against a per-commit oracle obtained by asking git one commit at a time, so the
test shares no framing logic with the code under test.

### Why `--name-only` and not `--numstat`

Measured on the 45,260-commit repository:

| Command | Time | Yields |
| --- | --- | --- |
| `git log --all --oneline` | 2.3s | commit count only |
| `git log --all --raw -z` | 13.2s | file lists, no line counts |
| `git log --all --name-only -z` | 10.8s | file lists, no line counts |
| `git log --all --numstat -z` | 178s | file lists **and** line counts |
| `git log --all -M --numstat -z` | 188s | the same, with rename detection |

The line-level diff costs 165 of those 178 seconds, and it buys added/removed
line counts — which are a worse hot-spot signal than commit frequency anyway, and
are available behind `--lines` for when someone wants them.

## The scanner

One character pass per file produces two buffers:

- **`codeOut`** — comments and string literals removed. This is what keyword and
  decision counting reads, so a `?` in a message is not a branch and an `if` in a
  comment is not a decision.
- **`textOut`** — comments removed, string literals preserved. Import specifiers
  *are* string literals, so this is the only buffer from which a dependency can be
  read. It is built only for languages that have an import grammar.

The same pass also tallies the line census (code / comment / blank), maximum
nesting depth, function and class definitions, suppression directives, and debt
markers with their line numbers.

### Two bugs worth recording

**String stripping destroyed the import graph.** `measureCode` cleared `codeText`
after reading it, and ran before `extractImports`, so every import lookup saw an
empty string. The tool cheerfully reported "no import cycles detected" and "1 of
8,405 source files covered" on a repository with 42% test coverage. Both numbers
were confidently, systematically wrong.

**Missing newlines broke every line-anchored grammar.** The output buffers were
joined without newlines, so `from a.b import c` on line 2 was indistinguishable
from the tail of line 1. Python's import grammar anchors on `^` with the
multiline flag, and nothing matched.

Both were found by tests that assert on a fixture of known shape, which is the
only reason they were found at all.

### The fast path

The character loop originally ran for every character: two string appends, a
switch, a state check. Measured at 3.9 MB/s, four times slower than the regular
expressions that later run over the same text.

So the scanner marks the handful of codepoints that actually change state in a
256-entry table, scans forward to the next one, and moves the whole run with a
single `slice`. Inside a run, two native regex tests answer the only two questions
that matter — "is there anything but whitespace" and "is there a brace or a
short-circuit operator" — and skip the per-character loop when neither applies.

| | Throughput |
| --- | --- |
| before | 3.9 MB/s |
| after | 10.6 MB/s |

## Concurrency

Two independent limits, for two independent reasons.

**Worker threads** bound the CPU work: `min(4, cores - 1)`, and zero when the
machine reports under 512 MB free, because starting a pool on a starved machine
makes everything slower. If workers cannot be spawned at all — a sandbox, a
resource limit — the same work runs inline through the same functions, so results
cannot differ between the two paths.

**Read concurrency** is set much higher, at 12 files per worker. Reading is
I/O-bound and queue depth is what matters. Measured on the test machine:

| Pattern | Throughput |
| --- | --- |
| One read at a time | 8.7 MB/s |
| Twelve reads at a time | 34.6 MB/s |

With three workers reading serially the disk spends most of its time waiting for
the next head position. Raising only the read depth cut the cold scan of a 13,249
file repository from 27.6s to 19.7s.

## The cache

Sharded by the first two path segments of each file, so editing one file
invalidates one shard rather than the whole run. The key is
`(version, fingerprint, path, size, mtime)`.

The fingerprint is a hash of **the source code of the measurement modules
themselves** — `core/scan.mjs` and `core/lang.mjs`. A version string alone is not
enough: change the scanner so that `?:` no longer counts as a branch, and every
entry written by the old scanner still looks valid, so the tool keeps reporting
last week's numbers. Hashing the code that produced the data makes stale entries
structurally impossible rather than a thing to remember to bump a constant.

That mechanism had its own bug, which is why `measurementFingerprint` now throws
rather than returning a placeholder when it cannot read its inputs: the module
paths were written relative to the project root instead of `src/core/`, so every
read failed, the hash was taken over the string `"missing"`, and the fingerprint
was constant forever. No cache entry was ever invalidated, and it looked like it
was working.

`test/analyze.test.mjs` asserts that the fingerprint's inputs are actually found
and are plausibly sized, which is the test that would have caught it.

The cache lives in `.oc-cache/` beside the tool. Analysing a repository must never
write into that repository, and a tool kept on disk for years should not litter a
home directory either. If the install directory is not writable it falls back to
the OS temp directory, and if that fails the cache disables itself. Every failure
mode costs time, never correctness.

## Rendering

Terminal capabilities are detected once: colour depth (truecolor → 256 → 16 →
none), unicode support, and width. Colour degrades by quantising RGB to the
nearest representable colour, and at depth 0 the theme returns text *untouched*
rather than wrapping it in a bare `ESC[0m` reset — because `--no-color` output has
to be byte-clean for a pipe or a file, not merely look colourless.

All width arithmetic goes through one function that understands East Asian wide
characters, combining marks and emoji. Tables, bars and paths are measured in
display columns, not code units, so a CJK path does not shear a row.

Three primitives enforce their own contracts, which removed whole classes of
layout bug rather than patching call sites:

- `pad(text, target)` **truncates** as well as pads. A layout that computes a
  column width and pads into it silently overflows on the one input longer than
  the author tested with.
- `meter(...)` guarantees it fits `totalWidth`, trimming the explanation to
  whatever the bar leaves.
- `barRow(...)` takes the total width and derives the label, note and bar from
  it, rather than trusting four independently-guessed numbers.

A test renders every view at six widths from 60 to 200 columns, in three colour
depths, in both Unicode and ASCII glyph sets, and asserts that no line exceeds the
terminal and that colour depth changes no layout. The same sweep is applied to the
static report.

Risk and health point in opposite directions, so the theme carries two ramps:
`heat` runs green → red as a value rises, `goodness` runs red → green. Using one
ramp for both made a perfect health score render in alarm red.

## The TUI

Every view is a pure function from state to a list of lines plus a cursor row.
Input handling, terminal setup and teardown live entirely outside them, which is
why the whole interface is rendered and asserted on in tests with no terminal
involved.

The terminal is put in raw mode on the alternate screen and restored on every exit
path, including `SIGINT`, `SIGTERM` and an uncaught exception. Leaving someone's
terminal broken is the one unforgivable bug in a TUI.

Key decoding is separated from key handling, and tested against the sequences
real terminals send: CSI (`\x1b[A`), SS3 (`\x1bOA`), the numeric-tilde family
(`\x1b[5~`), and multi-key chunks arriving in one read. A bug here — reading the
wrong capture group out of the sequence regex — produces zero keys, which is
indistinguishable from a dead keyboard and would never be caught by inspection.

## Growth

Memory is proportional to the number of distinct files ever touched, not to the
length of history. The history aggregator keeps only aggregates: per file, commit
counts, a small author map, first and last seen, and a monthly histogram. It never
retains a commit. On the 45k-commit repository the whole pipeline peaks around
400 MB RSS, most of which is the file list and the import graph.

The one list that can grow is the per-month `files` Set, which is bounded by the
file count, and the per-author `files` Set, bounded by the product of the two. If
that ever mattered it would be replaced with a counter, since nothing reads the
membership.

## Things deliberately not done

- **No AST parsing.** A real cyclomatic complexity needs a parser, and every
  language means a parser. Counting decision keywords on stripped source is 95% of
  the value for 0% of the maintenance, and the limitation is stated in every place
  the number appears.
- **No daemon, no database, no server.** A tool you run when you want to know
  something does not need a background process.
- **No sampling.** Every file is measured. On a 13k-file repository the scan is
  20 seconds cold and under a second warm; sampling would have made the numbers
  less trustworthy to save time that was not the bottleneck.
- **No git object reading.** Shelling out to `git` is slower in principle and
  dramatically more robust in practice — packed objects, alternates, worktrees,
  partial clones and shallow history all keep working.
