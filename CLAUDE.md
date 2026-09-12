# CLAUDE.md

Working agreements for this repository. Short on purpose: the ADRs in
`docs/adr/` carry the reasoning, and `CONTRIBUTING.md` carries the map.

## Invariants

These are not preferences. Breaking one is a decision that needs an ADR.

- **Zero runtime dependencies.** The Markdown scanner, front-matter reader, glob
  matcher, query parser and the regular-expression matcher behind `~=` are all
  written here. A documentation linter a security team has to audit is one that
  never gets installed.
- **Nothing in the pipeline may take longer than its input.** Every stage has a
  stated cost in the size of what it reads. `~=` used to be the exception - a
  call into `RegExp`, which a plausible pattern makes exponential - and
  [ADR-0017](docs/adr/0017-a-predicate-must-finish.md) is why it is not.
- **Native ESM, TypeScript 7, Node >= 22.** No CommonJS, no transpile step
  beyond `tsc`, no bundler.
- **Strict types.** `strict`, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`.
- **Vitest 4** for tests, **Stryker** for mutation testing.
- **LF line endings, no NUL bytes.** Enforced by `tests/docs.test.ts`; a stray
  NUL makes a file read as binary to grep, diff and review tooling.
- **I/O stays at the edges.** `glob.ts` walks, `runner.ts` reads, `config.ts`
  loads configuration, `cli.ts` looks up its own version. Everything between -
  the scanner, extraction, resolution, the graph, the rules, the reporters - is
  a pure function of text. That is why tests can build pathological corpora in
  memory, and why `analyseSources()` exists as a first-class entry point rather
  than a testing seam.

## Verification

All four must pass before anything is called done.

```bash
npm run lint            # tsc --noEmit
npm test                # vitest
npm run selfcheck       # spec-graph validates its own ADRs
npm run test:mutation   # stryker; ~30 minutes
```

Two thresholds are regression guards, set below the last measurement. They move
**up** when the measurement moves further than the noise, and **never** down to
accommodate a regression:

- **Mutation score >= 70** (`break` in `stryker.config.mjs`). Two numbers, and
  the difference matters: **75.40% on the hosted runner** at 0.4.0, and 80.54%
  over 9,697 mutants on a developer machine at 0.5.0. The hosted one governs -
  it is where the build fails. `perTest` attribution moves with worker count,
  with how many files are mutated, and with the platform, by up to sixteen
  points on a single file - and two runs of *identical source* on one machine
  moved nine untouched files by more than a point each, in both directions. An
  incremental run is a fast signal and not a verdict, in **either** direction:
  at 0.3.0 it read 3.18 points high against a full rebuild of the same commit,
  and at 0.4.0 it read 1.29 points low against one. It also stops being fast -
  after a broad change it has nothing to reuse, and 0.4.0's incremental run
  billed 110 minutes against the rebuild's 103. See ADR-0007. The guard stays at
  70 because ~300 mutants are detected by timeout, and losing all of them takes
  the local figure to 77.00% and the hosted one to 71.76%.
- **Coverage floors** in `vitest.config.ts`. Branches sits lowest on purpose;
  the remainder is defensive fallbacks and platform paths of which only one can
  run per machine.

If a change lowers either, the fix is the change, not the threshold.

**Read a per-file mutation drop as a question, not an answer.** Timeouts count
as detections and are timing-sensitive, and `perTest` coverage mis-attributes
async filesystem tests - `runner.ts` has reported ten points below its real
figure for both reasons. Confirm a drop by mutating the line by hand, or
re-measure that one file:

```bash
npx stryker run --mutate src/runner.ts --coverageAnalysis all   # seconds, and honest
```

See `docs/adr/0007-mutation-testing.md`.

## Design rules

**Read the ADRs before changing behaviour.** They are numbered, short, and
`npm run selfcheck` keeps them honest. The three that govern most decisions:

- [ADR-0006](docs/adr/0006-false-positives-cost-more.md) - **false positives
  cost more than misses.** When the evidence is ambiguous, stay quiet. A tool
  that cries wolf gets switched off in an afternoon and then catches nothing.
- [ADR-0004](docs/adr/0004-reference-resolution.md) - reference resolution is
  deliberately asymmetric.
- [ADR-0005](docs/adr/0005-rules-are-queries.md) - the rules and the query
  language share one engine.

**Prefer a table entry to a code change.** Supporting a new status word,
relation phrase, marker or family directory should be one line in a vocabulary
table. If it needs a rule change, that is a signal the design is wrong. The
tables are listed in `CONTRIBUTING.md`.

**A finding must name the place a human can fix.** For a supersession the
superseded document never acknowledged, that is the superseded document, not the
one that made the claim. Findings carry a hint that is a concrete next action -
where a flag would fix it, the hint names the flag.

**One defect is one finding.** Where two rules match the same edge, one claims
it and the other skips. See the hand-off between `ghost-handover` and
`stale-premise` in `src/rules.ts`.

## Testing

New behaviour needs a test that fails without it. New heuristics need a test for
the case that must **not** match - those are the ones that matter.

Assert decisions, not shapes. Where a mutant would be genuinely equivalent - a
pre-sized array, a worker count that changes throughput and not output - write
no test and leave a comment saying why. Padding the mutation score with
assertions that restate the implementation is worse than a lower number.

Read the survivor list, not just the score. It is the more useful output:
`reports/mutation/index.html` after a run.

Mutation testing measures what the tests assert. It cannot find a case nobody
thought of, so **probe new parsing code against a corpus written to break it**
before trusting the score. Where the thing being written already exists
somewhere else, compare against it rather than against your own beliefs:
`regex.ts` is verified by running both it and `RegExp` over a generated corpus,
which is what caught a clause of the language specification being read
backwards. Three bugs in the register work were found that way
and none of them by the suite: a link column read the label instead of the
destination, a path lost its underscores to emphasis stripping, and one `/g`
regex shared between a scan and a helper called from inside that scan reset its
own cursor and exhausted the heap. Write the fixture, run the binary, read the
edges.

## Prose

Comments explain *why*, never *what*. If a comment restates the line below it,
delete one of them. No exclamation marks, no hedging, no apologising for the
code. The same goes for diagnostic messages and commit bodies.
