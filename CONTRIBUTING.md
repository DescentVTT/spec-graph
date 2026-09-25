# Contributing

Thanks for looking. This file is short because the code is meant to explain
itself; what follows is the map that is hard to recover by reading.

## Getting started

```bash
npm install
npm test          # 966 tests
npm run lint      # tsc --noEmit, strict
npm run build     # emits dist/
npm run selfcheck # spec-graph checks its own ADRs
```

Node 22+. There are no runtime dependencies and there is no build step for the
tests — Vitest reads `src/` directly.

## The pipeline

Every module below is a pure function of its input except `runner.ts`, `glob.ts`,
`config.ts` and `cli.ts`, which are the only ones that touch the filesystem —
and a test in `tests/docs.test.ts` holds that list to exactly four. That is deliberate: it is why the
test suite can build pathological corpora in memory, and why a monorepo tool can
feed spec-graph documents that never existed on disk.

```text
files ─▶ markdown.ts ─▶ extract.ts ─▶ resolve.ts ─▶ graph.ts ─▶ rules.ts ─▶ report.ts
         scan            per document   whole corpus  index      diagnose    render
```

| Module | Responsibility |
| --- | --- |
| `source.ts` | Offset ↔ line/column. Everything user-visible carries a `SourceRef`. |
| `markdown.ts` | The scanner. Masks code, blocks out list items, extracts links. |
| `yaml.ts` | Front matter, with the offset of every value. |
| `directives.ts` | `<!-- @spec-* -->` annotations, the override escape hatch. |
| `lifecycle.ts` | Status vocabulary → four-phase lattice. |
| `identity.ts` | Document ids and the aliases that resolve to them. |
| `state.ts` | Item state, resolved from competing signals. |
| `extract.ts` | Document → nodes, items and unresolved references. |
| `resolve.ts` | References → edges, or reportable foreign-key failures. |
| `graph.ts` | Indexed, immutable graph. Adjacency, reachability, Tarjan. |
| `select.ts` | The selector language: parser and execution engine. |
| `rules.ts` | The diagnostics. Two of them are selector queries. |
| `project-rules.ts` | Selectors a repository declared, compiled and checked. |
| `report.ts` | Terminal, JSON, Graphviz and Mermaid output. |
| `diff.ts` | Two JSON exports compared, naming only the changes it can tell apart. |
| `glob.ts` / `paths.ts` | Pattern matching and POSIX path arithmetic. |
| `runner.ts` / `cli.ts` | Orchestration and the command line. |
| `vendor/spec-core/` | spec-core's modules, copied byte for byte: the matcher behind `~=`, an automaton that cannot backtrack. Never edited here: see below. |

## Where changes usually go

**Supporting a new status word, relation phrase or marker** is a table entry, not
a code change. That is the whole point of the design:

- a status word → `VOCABULARY` in `lifecycle.ts`
- a relation phrase (`"deferred to"`) → `VERB_RULES` in `extract.ts`
- a front-matter relation key → `RELATION_KEYS` in `extract.ts`
- a resolution marker (`"**Moot**"`) → `MARKERS` in `state.ts`
- a heading that holds obligations → `OBLIGATION_SECTIONS` in `extract.ts`
- a specification family directory → `FAMILY_DIRECTORIES` in `identity.ts`
- a front-matter key a register's regions must *not* inherit → `UNINHERITED` in
  `extract.ts` ([ADR-0009](docs/adr/0009-a-specification-is-a-region.md))

If a change needs to touch a rule, ask whether it belongs in a table instead.

**A new diagnostic** goes in `rules.ts`. Write it as a selector query if it is
one; several are, and they are the proof the query language is worth exposing.
If it is not expressible as a path query — dangling references never became
edges, and a cycle is not a fixed-length path — implement it directly and say so.

Before writing one, ask whether it belongs to *this* repository rather than to
every repository. A convention one team holds is a `rules` entry in their own
`.spec-graph.json` — a selector, a message and a severity, with no code involved
([ADR-0016](docs/adr/0016-a-query-needs-a-sentence.md)). A built-in has to earn
its place by being true of corpora nobody here has seen.

## The bar for a change

The engineering constraint that shapes this codebase is not correctness in the
abstract; it is **false positives cost more than misses**. A tool that cries wolf
gets switched off in an afternoon and then catches nothing at all. So:

- An inference that cannot be justified is not made. An unrecognised status is
  `unknown`, not a guess.
- A finding must name the place a human can go and fix it. For a supersession the
  superseded document never acknowledged, that is the superseded document — not
  the one that made the claim.
- Two findings for one defect is a bug. See the hand-off between
  `ghost-handover` and `stale-premise` in `rules.ts`.

New behaviour needs a test that would fail without it. New heuristics need a test
for the case that must *not* match — those are the ones that matter.

## Testing

```bash
npm run test:coverage   # thresholds are floors, not targets
npm run test:mutation   # stryker; about 75 minutes locally
```

Mutation testing matters here more than coverage does. This codebase is built out
of vocabularies and boundary conditions, and either can be weakened by an
ordinary-looking refactor without a single test going red. If you are adding a
heuristic, check that a mutant of it dies.

`src/vendor/spec-core/` is the family's shared library, copied in by spec-core's
`scripts/vendor.mjs` and held to the SHA-256 of every file by
`tests/vendor.test.ts`. A change to it is made in spec-core and copied again,
never made here. It is left out of the mutation sweep and of coverage: its
mutants are killed by spec-core's own suite (spec-core ADR-0001), and counting
them here would move this repository's score with code it does not own.

CI runs the same sweep in four shards and merges them into one report and one
score (`scripts/mutation-shards.mjs`, ADR-0019). A new file under `src/` lands
in the last shard. When the shards' times drift apart,
`node scripts/mutation-timeline.mjs <report> <log>` reads per-file minutes off a
sweep's log to rebalance them.

**Where an oracle exists, use it.** The matcher behind `~=` replaces a built-in
engine, so its tests - in spec-core now, beside it - do not assert what its
author believed about regular expressions — they run both engines over the same
patterns and subjects and compare. That is
what caught a clause of the language specification being read backwards, and it
is the pattern to copy for anything else that re-implements something standard.
`glob.ts` holds its automaton to the `RegExp` it replaced the same way.

## Releasing

Versions are published by CI from a tag, never from a workstation
([ADR-0021](docs/adr/0021-releases-are-published-by-ci.md)).

1. On a branch, set the version and give it notes:
   `npm version <x.y.z> --no-git-tag-version`, then move the changelog's
   `## Unreleased` entries under `## <x.y.z>`. The unit suite fails until
   `CHANGELOG.md` describes the version `package.json` names.
2. Merge to main.
3. Tag the merge commit and push the tag:

   ```bash
   git tag -a v<x.y.z> -m "spec-graph <x.y.z>"
   git push origin v<x.y.z>
   ```

The release workflow runs the whole CI matrix again on that commit, packs,
publishes to npm with provenance, and creates the GitHub release with the
changelog section as its notes. A prerelease (`0.9.0-rc.1`) goes out under the
`next` dist-tag and never becomes `latest`. To try the workflow without
publishing, run it by hand from main (Actions, Release, Run workflow): it does
everything but the upload and the GitHub release.

Nobody runs `npm publish`. npmjs.com is set to accept a publish from this
repository's `release.yml`, running in the `npm` environment, and otherwise
only from a person holding a second factor.

## Style

Match the surrounding code. Comments explain *why*, never *what* — if a comment
restates the line below it, delete one of them. Prose in comments and messages is
plain: no exclamation marks, no hedging, no apologising for the code.

## Licence

By contributing you agree that your contributions are licensed under the MIT
licence that covers the project.
