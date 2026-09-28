# Metrics

Every number `oc` prints, what it is computed from, and where it stops being
trustworthy. If a metric here is not useful for your situation, the honest
response is to ignore the section — not to interpret it generously.

Two rules govern everything below:

1. **Normalisation is relative and logarithmic.** There is no global threshold
   table. "200 lines" means something completely different in a config file and
   in a protocol parser, so scores are compared against the repository's own
   maximum. A file at 100% complexity means "the most complex file here", not
   "above some absolute bar".
2. **Every score decomposes.** `--json` returns the individual contributions, and
   the interactive view shows them. A number you cannot interrogate is a number
   you should not act on.

---

## Health

Seven components, each scored 0-100, averaged into the headline number and
mapped to a grade: A ≥ 85, B ≥ 72, C ≥ 58, D ≥ 42, else E.

### Maintainability

The **median** across source files of decision points per function, mapped so
that ≤ 1 scores 100 and ≥ 8 scores 0.

A function with roughly one decision point has a cyclomatic complexity near 2,
which is as simple as code gets. A median above 8 means the typical file is hard
to follow.

*Why the median and not the mean:* one 4,000-line generated-looking file in a
codebase of otherwise simple ones is not evidence that the codebase is
unmaintainable. The median describes the file you are actually likely to open.

*Known weakness:* the median hides the tail completely. A repository can score 100
here and still contain files no one should touch. Read the hot spots section too.

### Test coverage

Share of source files reached by a test, scaled so that 62% scores 100. The
scaling is deliberate: a repository that tests two thirds of its files is doing
well, and scoring it 66 would imply otherwise.

A source file counts as **covered** when either:

- a file that is itself a test imports it, or
- its name matches a test file for it (`foo.ts` ← `foo.test.ts`, `x.py` ←
  `test_x.py`).

Vendor, generated and test files are excluded from the denominator.

*Known weakness:* this is reachability, not execution. A test can import a module
and assert nothing about it, and a module exercised through the filesystem or a
plugin registry is reported as uncovered. Read it as "which files have no test
pointing at them", which is genuinely useful, rather than "which lines are
untested".

### Ownership spread

Share of authors who committed within the last 180 days, against a target of 25%
of all authors. Reported alongside the bus factor.

Author identity is the normalised email address, falling back to the name only
when git has no usable one. GitHub's `users.noreply.github.com` addresses are
kept distinct because they are per-user and therefore stable identifiers.

*Known weakness:* a repository that is largely imported or vendored will show
thousands of "authors" and a healthy spread that does not reflect the team. The
bus factor is the number to trust for that case.

### Debt load

Debt markers per 1,000 lines of code, scored 0 at 20 markers per KLOC.

Markers are found only in comments, never in string literals, and are weighted:

| Weight | Markers |
| --- | --- |
| 3 | `FIXME`, `XXX`, `HACK`, `BUG`, `@deprecated` |
| 2 | `TODO`, `WORKAROUND`, `SECURITY`, `SUPPRESSED`, `REFACTOR` |
| 1 | `OPTIMIZE`, `PERF`, `REVIEW`, `NOTE`, `CLARIFY`, `QUESTION` |

A language's comment syntax is respected, so a `#` inside a Python string is not a
marker and a `//` inside a JS string is not either.

*Known weakness:* a team that writes issues instead of comments scores 100. That
is a measurement of the wrong thing, not a false result.

### Structure

Share of analysed files caught in an import cycle, scored so that 12.5% or more
scores 0.

Cycles are computed with an iterative Tarjan strongly-connected-components pass,
which cannot overflow the stack on a deep graph. A component of more than 8 files
is reported as a *dependency cluster* rather than a cycle: a two-file cycle is a
bug report, and a 400-file component is a property of the package layout, so
labelling both "cycle" would be misleading.

### Change concentration

The share of all file-level commits made by the most-changed 10% of files. Scores
100 at 30% or below and 0 at 70% or above.

Even spread means change is distributed; 70% in a tenth of the files means a
small group absorbs nearly every edit, and each of them is a merge conflict
waiting to happen.

### Maintenance cadence

Share of the last 6 calendar months containing at least one commit.

*Known weakness:* a project that batches six months of work into a single week
scores 17%. This measures when commits were authored, not whether the work
happened.

---

## Hot spots

A per-file composite risk score from 0 to 100. The weights sum to 1 and are
asserted in the test suite:

| Signal | Weight | Meaning |
| --- | --- | --- |
| `churn` | 0.20 | Commits that touched the file, relative to the busiest file here. |
| `complexity` | 0.22 | Half from total decision points, half from decision points **per function**. |
| `size` | 0.10 | Lines of code, relative to the largest file here. |
| `debt` | 0.12 | Weighted marker count, relative to the worst file here. |
| `ownership` | 0.10 | Herfindahl concentration of the file's authors. 1.0 means one person wrote all of it. |
| `blastRadius` | 0.10 | How many project files import this one. |
| `untested` | 0.10 | Full points when the file is frequently changed and no test reaches it. |
| `suppression` | 0.06 | `eslint-disable`, `@ts-ignore`, `noqa`, `coverage: ignore` and friends. |

Each signal is normalised as `log1p(x) / log1p(repoMax)`, so a single outlier
cannot flatten the rest of the scale.

Test files, generated files and vendored directories are excluded from the
ranking entirely. They are still measured and still appear in `--json`.

**Why complexity is half "per function":** a 1,000-line file of thirty trivial
functions is fine. A 200-line file of two functions with forty branches is not.
The absolute count alone ranks the first kind as the worst file in the
repository, which is exactly backwards.

**Why ownership uses a Herfindahl index:** summing `(commits by author / total
commits)²` over authors gives 1.0 for a file with a single author and approaches
`1/n` for one evenly shared by `n` people. It is the standard concentration
measure and needs no threshold tuning.

### Decision points

Counted on source with comments **and** string literals stripped, so a `?` inside
a message or an `if` inside a comment is not a branch. What counts:

- branch keywords per language family (`if`, `for`, `case`, `catch`, `elif`,
  `match`, `select`, `rescue`, …)
- `&&`, `||`, `??`
- `?` when it is a ternary or optional chain, **but not** `?:`, which is an
  optional property or parameter declaration in TypeScript and a type marker
  elsewhere

Maximum brace and bracket nesting adds to the score as a penalty above depth 2,
because deep nesting is hard to follow even when the branch count is modest.

*Known weakness:* this is not cyclomatic complexity. It has never seen a parse
tree. Regular expressions containing `|` are stripped along with strings in most
languages but not in all, and macro-heavy languages will undercount.

---

## Ownership

- **Bus factor** — the smallest number of authors whose commits account for at
  least half of all commits in the window.
- **Single-author files** — files with two or more commits and exactly one
  historical author. Ranked by risk, because a dangerous file understood by one
  person is the worst combination in a codebase.
- **Stale files** — untouched for over a year and over 200 lines.
- **Orphan files** — source files with no recorded history in the window.

Recency labels: `active` ≤ 30 days, `recent` ≤ 180, `lurking` ≤ 365, else
`dormant`.

---

## Structure

- **Import cycles** — strongly connected components with more than one member,
  from resolved project-internal imports.
- **Dependency clusters** — components larger than 8 files, reported with their
  most-imported members.
- **Blast radius** — in-degree: how many project files import each file. This is
  the closest thing to a real answer to "how bad is it if I break this?".
- **Undeclared dependencies** — packages imported in code but absent from every
  root manifest. Platform standard-library modules and common local directory
  names are excluded, because a false positive here trains people to ignore the
  section.
- **Unused dependencies** — declared but never imported. Only reported for
  single-manifest repositories; a monorepo always looks over-declared.

### Import resolution

| Ecosystem | Strategy |
| --- | --- |
| Relative (`./x`, `../x`) | Resolved from the importing file, then extension-probed, then `index.*`. |
| Python, Java, Kotlin, C#, Go, Rust | Resolved from each ancestor directory up to the repository root, then `src/`. Python's `from services.user import User` in `api/tests/x.py` means `api/services/user.py`, which is not reachable from the importer's own directory. |
| Packages (`react`, `@scope/pkg/deep`) | Reduced to a package name and checked against manifests. |

There is deliberately **no** basename fallback. Matching a bare specifier to any
file with that stem anywhere in the tree is unsound: it once turned the specifier
`react` into an edge to `packages/tsconfig/react.json`, which then reported that
JSON file as having 2,374 importers. A missing edge is a much smaller error than
an invented one.

Vendored directories are excluded from the graph. Depending on `node_modules` is
not an architectural signal.

---

## Debt

Markers are reported by type, and separately as *oldest untouched debt*: the
highest-weight marker sitting in the file that has gone longest without a commit.

That definition is deliberate. A `TODO` from last week is a task. A `TODO` in a
file nobody has opened in two years is something the organisation has forgotten
exists, and that is the more useful thing to surface.

Suppression directives are counted separately, because code that has opted out of
linting is invisible to every other check.

---

## Tests

- **Reach** — described under Health.
- **Least-covered areas** — grouped by the first two path segments, sorted by
  coverage ratio then by size. Directories with no tests at all come first.
- **Untested hot files** — the most-changed files that no test reaches.

---

## Reading `--json`

```sh
oc --json | jq '.hotspots[0]'
```

```json
{
  "path": "web/service/base.ts",
  "risk": 48,
  "commits": 267,
  "complexity": 61,
  "perFunction": 2.6,
  "depth": 6,
  "functions": 23,
  "code": 1031,
  "debt": 0,
  "authors": 53,
  "fanIn": 12,
  "fanOut": 3,
  "tested": false,
  "inCycle": false,
  "reasons": [
    { "key": "churn", "points": 16.4 },
    { "key": "complexity", "points": 11.2 },
    { "key": "size", "points": 7.1 }
  ]
}
```

`reasons` lists only contributions of at least 3 points, ordered by size. The
full decomposition, including the signals that scored zero, is in the in-process
report under `signals`.

## Stability

The JSON schema is versioned as `meta.schema`. Additive fields may appear in a
minor release; removing or reinterpreting one requires a major version, which
also changes `meta.version` and therefore invalidates every cached measurement.
