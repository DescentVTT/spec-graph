# Contributing

Thanks for looking. This file is short because the code is meant to explain
itself; what follows is the map that is hard to recover by reading.

## Getting started

```bash
npm install
npm test          # 342 tests
npm run lint      # tsc --noEmit, strict
npm run build     # emits dist/
npm run selfcheck # spec-graph checks its own ADRs
```

Node 22+. There are no runtime dependencies and there is no build step for the
tests — Vitest reads `src/` directly.

## The pipeline

Every module below is a pure function of its input except `runner.ts`, which is
the only thing that touches the filesystem. That is deliberate: it is why the
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
| `glob.ts` / `paths.ts` | Pattern matching and POSIX path arithmetic. |
| `runner.ts` / `cli.ts` | Orchestration and the command line. |

## Where changes usually go

**Supporting a new status word, relation phrase or marker** is a table entry, not
a code change. That is the whole point of the design:

- a status word → `VOCABULARY` in `lifecycle.ts`
- a relation phrase (`"deferred to"`) → `VERB_RULES` in `extract.ts`
- a front-matter relation key → `RELATION_KEYS` in `extract.ts`
- a resolution marker (`"**Moot**"`) → `MARKERS` in `state.ts`
- a heading that holds obligations → `OBLIGATION_SECTIONS` in `extract.ts`
- a specification family directory → `FAMILY_DIRECTORIES` in `identity.ts`

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
npm run test:mutation   # stryker; takes ~25 minutes
```

Mutation testing matters here more than coverage does. This codebase is built out
of vocabularies and boundary conditions, and either can be weakened by an
ordinary-looking refactor without a single test going red. If you are adding a
heuristic, check that a mutant of it dies.

## Style

Match the surrounding code. Comments explain *why*, never *what* — if a comment
restates the line below it, delete one of them. Prose in comments and messages is
plain: no exclamation marks, no hedging, no apologising for the code.

## Licence

By contributing you agree that your contributions are licensed under the MIT
licence that covers the project.
