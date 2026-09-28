# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

First release. Zero runtime and zero development dependencies; Node 20.6+ and
`git` are the only requirements.

### Added

**Analysis**
- Streaming git history parser, verified byte-for-byte against `git log`,
  including merge commits, empty commits, renames, binary files, non-ASCII
  paths, and commit subjects containing the stream's own framing bytes.
- Two history modes: commit frequency by default (11s on a 45k-commit
  repository), optional line-level churn via `--lines` (178s, and only when
  you want it).
- Rename inference: a delete and an add of the same basename in the same commit
  are folded together, so moving a file does not reset its churn history.
- Import resolution across 33 languages, with package-root resolution for
  Python, Java, Kotlin, C#, Go and Rust, and no unsound basename fallback.
- Import cycle detection via iterative Tarjan; components larger than 8 files
  are reported as dependency clusters rather than as fixable cycles.
- Manifest reconciliation: undeclared and unused dependencies, with standard
  library and local-name filtering so the section stays trustworthy.
- Test reach measured from real import edges plus test-file naming, not
  directory heuristics.
- Composite per-file risk score with an itemised, inspectable breakdown.
- Seven-component health index and letter grade, each component explained.
- Debt markers with weights, line numbers, and the oldest untouched debt.
- Suppression directive counting (`eslint-disable`, `@ts-ignore`, `noqa`,
  `coverage: ignore`, …).

**Interface**
- Static report with ten sections, verified not to overflow at any width from
  60 to 200 columns in three colour depths.
- Interactive explorer: five views, filtering, cursor movement, and per-file
  drill-down explaining exactly why a file scores what it does.
- `--json` for scripting, with a versioned schema and the full risk breakdown.
- `--sections` to render a subset, `--watch` to re-analyse on change,
  `--fail-on GRADE` to turn health into an exit code, `--prune` for the cache.
- Progress indicator on stderr, silent when piped and silent for fast runs.
- Full colour degradation (truecolor → 256 → 16 → none) and a Unicode → ASCII
  fallback that also switches the truncation marker, so ASCII output really is
  ASCII.
- CJK-aware display width so tables and paths do not shear.

**Engineering**
- Self-invalidating analysis cache: the key includes a hash of the measurement
  source itself, so changing what a metric means cannot leave stale numbers
  behind. Fails loudly rather than degrading silently if it cannot read its
  inputs.
- Bounded worker pool with an inline fallback that shares the same code path,
  and a separate read queue depth, because queue depth is what makes a slow disk
  fast.
- Scanner fast path: bulk `slice` over runs of ordinary code, taking source
  measurement from 3.9 MB/s to 10.6 MB/s.
- 103 tests with no network access and nothing written outside the project
  directory, including a differential test against git itself.
- `scripts/verify-parser.mjs`, which proves the history parser matches git on any
  repository, commit by commit, including per-commit file lists.
- Dependency-free linter covering parse errors, control bytes, unresolved
  imports, and the mistakes that survive review.
- Benchmark script reporting per-phase cold and warm timings.

### Known limitations

Documented in full in [docs/METRICS.md](docs/METRICS.md) and the README:

- Complexity is estimated from decision keywords, not computed from an AST.
- Test reach is reachability by import, not execution.
- Ownership is inferred from commit authors, not reviews or trailers.
- Churn counts commits, not effort.
- Renames are inferred from matching basenames; a simultaneous move and rename
  splits a file's history in two.
- 33 languages are recognised; an unrecognised extension is counted as a file
  and skipped for content analysis.
