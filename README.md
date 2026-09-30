# oc

**A terminal intelligence tool for git repositories. Zero dependencies.**

`oc` reads your repository and tells you the things that are expensive to discover
by hand: which files are dangerous to touch, who actually owns what, where the
import cycles are, which debts nobody has touched in two years, and whether your
tests reach the code that changes most.

It is a single self-contained tool with no `node_modules`, no lockfile, no network
access and no telemetry. Clone it and run it.

```
  oc  dify                            main·45,260 commits·1,512 authors·3.3 years of history
────────────────────────────────────────────────────────────────────────────────────────────

││ HEALTH                                                                          B  79/100
  Maintainability   █████████████████████████████  median 0.2 decision points per function
  Test coverage     ██████████████▉░░░░░░░  3547/8405 source files reached by a test (42%)
  Ownership spread  ████▉░  310 of 1512 authors active in the last 6 months, bus factor 12
  Debt load         ███████████████████████████████████████████░  0.3 markers per 1k lines
  Structure         ████████████████████░░░░░░░░░░░░  51 import cycles touching 606 files
  Change concentrat…███████▎░░░░  most-changed 10% of files account for 46% of all commits
  Maintenance caden…███████████████████████████▍░░░░░  5 of the last 6 months have commits

││ ACTIVITY                                             peak 2,999 in 2026-08·last 26 months
  ▃▃▄▅▅▃▃▄▃▃▄▄▄▆▅▄▄▇▄▆▆▆▇██▂
  2024-08                                                                            2026-09
  contributors █▇▇█▇▆▇██▇▆███▇▇▇▇▆█▇▆▇▇▇▂

││ HOT SPOTS                                                         top 6 by composite risk

  risk   churn   cx/fn   lines  owner         file
  ───────────────────────────────────────────────────────────────────────────────────────
    48     267     2.6    1.0k  53 people   web/service/base.ts
    46      30     3.7    1.4k  2 people    web/features/skills/detail/file-editor.tsx
    46      51     2.2     708  4 people    web/features/new-rag/document-list.tsx
    46     135     6.0     393  24 people   …/nodes/_base/components/prompt/editor.tsx
    45      37     2.1     613  3 people    web/features/new-rag/processing-tasks-drawer.tsx
    45      53    13.0     227  22 people   …/workflow/nodes/knowledge-retrieval/utils.ts

││ STRUCTURE

  ! 51 import cycles touching 606 files

    cycle of 2
      └ api/core/schemas/registry.py
      └ api/core/schemas/resolver.py
    cycle of 3
      └ cli/src/framework/errors.ts
      └ cli/src/framework/output.ts
      └ cli/src/framework/types.ts
    · 42 more small cycles

    425 files form one dependency cluster
      Mutually reachable, so nothing here can be extracted in isolation.
      Most depended upon inside the cluster:
        └ api/models/model.py  594 in-cluster importers
        └ api/models/dataset.py  311 in-cluster importers
```

*(Real output, from a 45,260-commit, 13,636-file repository. Widths and section
ordering vary with your terminal.)*

---

## Why this exists

Every large codebase has a small set of files that cause most of the pain. They
are usually not the biggest ones. They are the files that change often, are hard
to understand, depend on a lot of other things, and are understood by exactly one
person. Finding them by hand means reading commit logs one at a time.

Existing tools fall into two groups: dashboards that need a server and a database
and show you a number with no explanation, and linters that tell you about
problems in the file you are already looking at. Neither answers *"which file
should I be worried about, and why?"*

`oc` answers exactly that, and shows its working. Every score decomposes into
named contributions, so a claim can always be checked:

```
    46      30     3.7    1.4k  2 people    web/features/skills/detail/file-editor.tsx
              complexity 13·untested 10·churn 10
```

## Install

```sh
git clone https://github.com/gupi-bill/repo-intelligence.git
cd repo-intelligence
node bin/oc.mjs --help
```

Requires Node 20.6 or newer and `git` on `PATH`. Nothing else. To put it on your
`PATH`:

```sh
ln -s "$PWD/bin/oc.mjs" /usr/local/bin/oc
```

## Use

```sh
oc                      # analyse the repository containing the current directory
oc ../other-repo        # analyse another repository
oc --tui                # interactive explorer
oc --json | jq .health # machine-readable
oc --since 6.months.ago  # recent history only
oc --lang python          # restrict to one language
oc --watch                # re-analyse on every change
oc --no-color > out.txt   # clean output for a file or a PR comment
oc --exclude /public/ --exclude web/app   # drop paths you know are not yours
```

Every run states its own scope, because a score computed from 70% of a
repository is a number with no stated meaning:

```
13,249 of 13,636 tracked files analysed · 8 vendored · 67 binary · 3 over the size limit
```

`--exclude` exists because every project keeps third-party code somewhere
different. `node_modules`, `vendor`, `dist` and friends are recognised
automatically; a project that copies an editor or a library into `public/` needs
to say so, and `--include-vendor` is the escape hatch in the other direction.

### Interactive mode

```
 1 overview   2 hot files   3 people   4 structure   5 debt

  j / k / ↓ / ↑   move          enter   open the selected file
  g / G           first / last  esc     close detail, clear filter
  /               filter        ?       help        q  quit
```

Press `enter` on any hot file to see its size, decision points, blast radius, the
debt inside it, who imported it, and the itemised breakdown of its risk score.

### In a pipeline

`--fail-on` turns the health grade into an exit code, so a repository that rots
past a threshold can fail a check:

```sh
oc --fail-on C || echo "codebase health has slipped below C"
```

## What it measures

Full definitions, formulas and limitations are in [docs/METRICS.md](docs/METRICS.md).
The short version:

| Section | The question it answers |
| --- | --- |
| **Health** | Seven named components, each 0-100, averaged into a grade. |
| **Activity** | Commit volume and contributor count per month. Are we narrowing or broadening? |
| **Hot spots** | Which files are dangerous, and which three facts made them so. |
| **Ownership** | Bus factor, and the files only one person has ever touched. |
| **Structure** | Import cycles, dependency clusters, blast radius, undeclared and unused dependencies. |
| **Debt** | `TODO`/`FIXME`/suppression markers, weighted, including the ones nobody has revisited. |
| **Tests** | Which source files no test actually reaches, by real import edges. |

Two design choices worth calling out:

- **Churn is commit frequency, not lines changed.** Counting lines requires git to
  diff every version of every file, which on that 45k-commit repository took 178
  seconds. Commit frequency took 11 and is a better hot-spot signal anyway.
- **Test reach is measured by real imports**, not by naming conventions. A source
  file counts as covered when a test file imports it, or when it is the file that
  `foo.test.ts` is obviously testing.

## Performance

On a 13,636-file, 103 MB, 45,260-commit repository (4 cores):

| Phase | Cold | Warm | Note |
| --- | --- | --- | --- |
| collect | 1.7s | 1.7s | index read + stat |
| scan | 19.7s | 0.9s | 13,249 files measured across 3 workers |
| history | 17.9s | 17.9s | one streaming pass over every commit |
| coupling | 9.5s | 0.4s | import resolution + cycle detection |
| analyse | 0.6s | 0.6s | scoring |
| **total** | **49.4s** | **~21s** | |

The cache lives in `.oc-cache/` beside the tool, never in the repository you are
analysing, and invalidates itself when the measurement code changes. Use
`--no-cache` to ignore it, `--prune` to delete stale shards, `--since` to bound
the history window when you do not need all of it.

The two stages that are pure JavaScript are considerably faster than they were:
aggregation is 26% quicker and import resolution 59% quicker, with 40% less
peak heap in aggregation. Both came from profiling rather than intuition — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-the-profiler-actually-said) for
what the profiler said, including the two plausible-looking changes that turned
out to make no difference. **The report output is byte-identical before and
after**, which is verified rather than assumed.

## Why zero dependencies

Not asceticism. Three concrete reasons:

1. **It will still run.** No lockfile rot, no transitive install failures, no
   `npm ci` before you can look at your code.
2. **The measurement is auditable.** When `oc` tells you a file has 13 decision
   points per function, you can read the 600 lines that decided it. A dependency
   you did not write is a dependency you cannot check.
3. **It is a tool about trust.** A code-reading tool should not be reading you
   back. `oc` makes no network requests at all.

## Development

```sh
npm test                    # 103 tests, no network, nothing written outside this folder
npm run lint                # syntax, control characters, unresolved imports, long lines
npm run bench -- <path>     # per-phase cold and warm timings
node scripts/verify-parser.mjs <path>   # prove the history parser matches git on your repo
```

`verify-parser.mjs` is worth knowing about: it streams your repository's history
and compares it against what `git log` reports, commit by commit, including
per-commit file lists. If a commit were ever silently dropped, every
history-derived metric would be quietly wrong, and nothing else in the tool would
say so.

```
  oc parser verification
  /path/to/repo
  git reports 45260 commits, 13636 tracked files
  mode: names (--name-only), 4 shard(s)

  ok  every commit git reports is seen  45260 of 45260
  ok  no commit is seen twice
  ok  no commit is invented
  ok  per-commit file lists match git  40 commits checked, 0 mismatched
```

The test suite includes a differential test that builds a git repository with
merges, empty commits, renames, binary files, paths with spaces and non-ASCII
characters, and commit subjects containing the tool's own framing bytes, then
asserts the streaming parser sees byte-for-byte what `git log` sees.

```
  test/scan.test.mjs        18   comment and string stripping, decision counting, imports
  test/git-stream.test.mjs  11   differential against git itself
  test/analyze.test.mjs     26   cycles, ownership, risk arithmetic, cache invalidation
  test/ansi.test.mjs        10   CJK widths, colour degradation, truncation
  test/tui-cli.test.mjs     36   key decoding, navigation, layout at 6 widths, CLI
```

## Documentation

- [docs/METRICS.md](docs/METRICS.md) — every metric, its formula, and where it breaks down
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, the git wire format, and the performance work
- [docs/EXAMPLE.md](docs/EXAMPLE.md) — `oc` run against `oc` itself, unedited, including the parts that are unflattering and the three limitations that make this repo too small to trust

## Sibling project

Same author, same premise (zero-dependency terminal tools):

- **[sift](https://github.com/gupi-bill/sift)** — fuzzy file search, content
  grep, frequency-based directory jumping, and command history, in one folder
  with no `requirements.txt` and no `node_modules`. Pure Python 3.9+ stdlib,
  so it runs anywhere Python does — someone's server, a throwaway container, a
  laptop from five years out. 85 unit tests plus 19 real-pty keyboard tests.
  ```bash
  git clone https://github.com/gupi-bill/sift && cd sift && ./install.sh
  ```

Both are written in different languages on purpose: a shared codebase would
mean shared constraints, and the point of each is to have none.

## Limitations

Stated up front, because a metrics tool that oversells itself is worse than none:

- Complexity is **estimated**, not computed. It counts decision keywords and
  nesting on comment- and string-stripped source. It has never seen your AST.
- Test reach is a **proxy**. A test can exercise a file it does not import (via
  the filesystem, a plugin registry, or reflection), and that file is reported as
  uncovered.
- Ownership comes from `git log` authors, not from review or commit-message
  trailers. `--since` windows make bus factor look worse than it is.
- Churn counts commits, not effort. A one-character fix and a 2,000-line rewrite
  each count once.
- Renames are inferred from a delete and an add of the same basename in the same
  commit. Moving a file while renaming it splits its history in two.
- Language coverage is good but not exhaustive. An unrecognised extension is
  counted as a file and skipped for content analysis.

## Licence

MIT. See [LICENSE](LICENSE).
