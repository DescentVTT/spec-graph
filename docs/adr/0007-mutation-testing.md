---
status: accepted
date: 2026-09-07
---

# ADR-0007: Mutation testing, and what the score actually means

## Context

Line coverage is 92.7% statements and 95.7% lines. That number says a line ran.
It says nothing about whether an assertion was holding its behaviour down.

This codebase is unusually exposed to that gap, because it is built out of
vocabularies and boundary conditions rather than data structures. Consider the
edits that change what spec-graph reports and move coverage not at all:

- flipping `openness !== 'closed'` to `===` in the ghost-handover query
- widening the governing-phrase window from 40 characters to 41
- dropping `'deferred to'` from the delegation vocabulary
- changing `phase !== 'retired'` to `phase !== 'archived'`

Every one is a real behaviour change. A suite can execute all four lines and
assert nothing that any of them would break. Mutation testing is the only
mechanical check that distinguishes "this line ran" from "this line is pinned".

## Decision

Run Stryker on every push, and treat the threshold as a regression guard rather
than an aspiration.

Two configuration choices are worth recording:

**Per-mutant timeout is 15s, not the default 60s.** A mutated regex can turn
linear scanning into catastrophic backtracking, and a mutant that hangs is a
genuine detection - but each one costs a worker its full budget. The first run
here logged 185 timeouts, which at a minute apiece was most of its 27 minutes.
The whole suite runs in about a second, so 15s is still far longer than any
healthy mutant needs.

**`break` sits a few points below the measured score.** Its job is to fail the
build when the suite gets weaker, not to assert an aspiration nobody has met. It
moves up as the measurement does: 60 against 63.31%, then 70 against 74.05%.

## Consequences

The measured score is **79.69% over 8,126 mutants** at 0.3.0, on a developer
machine. It has moved 48.11% → 60.6% → 63.31% → 74.05% → 74.73% → 75.68% →
76.52% → 77.16% → 79.69% as the suite grew from 149 to 684 tests.

**That number is a property of the measurement as much as of the code, and the
figure the guard fires against is lower.** The same commit measured on the
hosted runner reads **73.32%**. This is not drift and not incremental mode: the
one CI run that completed at v0.1.2 read 72.34% against 74.73% recorded here for
the same commit, before incremental existed.

`lifecycle.ts` is the clearest case, because it contains nothing platform can
touch - it is vocabulary tables. One file, one commit, one machine:

| how it was measured | score |
| --- | --- |
| `perTest`, concurrency 8, whole project | 77.13 |
| `perTest`, concurrency 8, this file alone | 68.99 |
| `coverageAnalysis: all`, concurrency 8 | 73.26 |
| `perTest`, concurrency 4 | 60.47 |
| hosted runner: Linux, concurrency 4, `perTest` | 64.34 |

A sixteen-point range on identical source. Concurrency cannot change which
mutants a test kills, so what is moving is `perTest` attribution - which tests
Stryker believes cover which mutants - and it moves with worker count, with how
many files are mutated, and with the machine.

0.3.0 measured it again, and cleanly. Two full runs, same machine, same
settings, same 8,126 mutants - **nothing in `src/` changed between them**, only
six test cases added. The total moved 80.00% → 79.69%, and underneath that
nearly-still number:

| file | run 1 | run 2 | move |
| --- | ---: | ---: | ---: |
| `rules.ts` | 81.32 | 76.56 | **-4.76** |
| `paths.ts` | 94.59 | 90.54 | **-4.05** |
| `report.ts` | 76.46 | 74.32 | -2.14 |
| `markdown.ts` | 80.39 | 82.34 | +1.95 |
| `runner.ts` | 91.77 | 94.30 | +2.53 |
| `lifecycle.ts` | 75.58 | 78.68 | **+3.10** |

Nine files moved a point or more, in both directions, and not one of them was
touched. `paths.ts` is sixty lines of string handling that no added test goes
near, and it lost four points. `markdown.ts`, the only file the new tests
actually target, gained two - which is the one movement that means anything.

This is the reason the practice in `CLAUDE.md` is worded the way it is. **A
per-file drop is a question, not an answer**, and the way to answer it costs
seconds: change the line by hand and see whether the suite goes red. All nine
mutants the 0.3.0 work was chasing were confirmed killed that way, while the
score they belong to went *down* by a third of a point.

`perTest` stays, because `coverageAnalysis: all` runs the whole suite per mutant
and the hosted run already takes 80 minutes of its 90-minute cap. The cost is
paid in honesty instead: **the hosted figure is the one that governs**, because
that is where the build actually fails, and the developer figure is a fast local
proxy that reads a few points high.

**Incremental runs are trusted for the gate, and rebuilt weekly anyway.** A full
hosted run takes 80 minutes; an incremental one on a warm cache takes 36
seconds. Measured against each other on the same source, they read 73.82% and
73.34% - within half a point, with incremental reporting 35 more survivors than
the rebuild. It errs low, which is the safe direction for something that fails a
build: it can cost a false alarm, and it cannot hide a regression by reading
high. The weekly rebuild is what keeps that half-point from accumulating.

This also corrects the headroom. Against 73.32% with 305 timeouts - four percent
of the corpus, and a timeout is a timing measurement - a bad run reads 69.3%.
`break: 70` has about three points of real margin, not seven, which is the
argument for leaving it exactly where it is.

**Read "no coverage" before reading the score.** The v0.2.0 modules landed at
74.61% and 83.08%, and the number worth acting on was neither: it was that 42 of
their mutants had no covering test at all. Most were genuine - a config key no
test ever parsed, a comparator that never saw two entries sharing a rule - and
closing them moved those files to 90.16% and 92.04% measured on their own. The
rest were `perTest` mis-attribution, and measure fine under
`--coverageAnalysis all`. A survivor is a test that is too weak; a no-coverage
mutant is a test that does not exist, and the second is the cheaper thing to
fix.

**`break` stays at 70 even though the measurement rose.** The guard has to clear
the noise, and the noise here has a size: 303 of those mutants were detected by
timeout, and a timeout is a timing measurement. If every one of them flipped to
`survived` on a slower machine the score would read 71.5%. A guard at 72 would
fail that build for being slow rather than for being wrong. 70 is the closest
round number that survives the worst case, so it stays where it is until the
timeout population shrinks.

It is worth being straight about what that number is and is not.

**It is not "all vocabulary tables".** That would be a convenient story, and the
data does not support it. String literals - message text and vocabulary entries -
are still the largest surviving bucket at 428 mutants, but excluding them
entirely moves the score only to 75.8%. The body of the survivors is 393
conditional-expression mutants spread across every module. About a quarter of the
mutants survive, and most of that is genuine headroom rather than noise.

**The survivor list is more useful than the score.** Reading it, rather than
chasing the number, is what produced `tests/edge-cases.test.ts` - and every test
in its first batch passed on the first run. The behaviour was already correct; it
was simply unverified, and unverified behaviour is what silently changes under a
refactor. That is the return on this tool, and it does not require the score to
be high to pay out.

**End-to-end tests over a real directory kill more than unit tests over
synthetic input.** This was the surprise of the v0.1.1 pass. The goal was
`runner.ts`, which went from 45.3% to 84.2%. But the total moved 63.31% → 74.05%,
and *forty per cent of that gain came from modules that got no new tests at all* -
`extract.ts` +16.4, `identity.ts` +13.7, `markdown.ts` +11.3, `yaml.ts` +10.1.

The reason is that the new tests drive `analyse()` over a fixture directory of
realistic documents - front matter, four kinds of checkbox, a wrapped item, a
relative link crossing two directories, a document that opts out - rather than
over the minimal in-memory corpora the unit tests use. Those minimal corpora are
easy to read and pin down one behaviour precisely, but they never exercise the
paths a real file takes. Both kinds of test earn their place; only one of them
finds the code that no input in the suite had ever reached.

**The per-file figures are a floor, not a point estimate.** Two effects pull
them around, and both were visible on the v0.1.2 pass.

A timeout counts as a detection, and 296 of these mutants time out - most of
them in `state.ts`, where a mutated marker regex turns linear scanning into
catastrophic backtracking. Whether a given mutant crosses the 15s budget depends
on how loaded the machine is, so a *faster* run scores *lower*: mutants that
would have hung instead run to completion and survive. Per-module swings of two
or three points between runs are this, not the suite changing.

More seriously, `coverageAnalysis: 'perTest'` mis-attributes coverage for async
tests that touch the filesystem. `runner.ts` reported 74.2% on the full run and
84.2% on the one before, which looked like a ten-point regression from new
`--ignore-ref` wiring. It was not. Mutating `openObligations` by hand fails
`runner.test.ts` immediately, and re-measuring that one file with
`coverageAnalysis: 'all'` gives **83.51%**. Stryker had linked those lines to
tests that execute them without asserting on them, and never ran the test that
does.

The lesson is to read a per-file drop as a question rather than an answer.
Confirm it by mutating the line by hand, or re-measure that file with
`--mutate src/<file>.ts --coverageAnalysis all`, which takes seconds.

**Some survivors are not worth killing.** Removing `'provisional'` from the draft
vocabulary fails no test, and the test that would catch it asserts that one word
of a thirty-word table exists. A hundred such tests would raise the score and
detect nothing a human would call a defect. Where a table entry is load-bearing -
the checkbox characters, the four lifecycle phases - it has a test. Where it is
one synonym among many, it does not.

## Open Questions

- [x] Should the `Regex` mutator be scoped? At 57.9% it was among the weakest.
      **Resolved (2026-09-07):** no. It rose to 74.0% - exactly the corpus
      average - on the v0.1.1 pass without anyone targeting it, which says the
      weakness was in the tests rather than in the mutator.
- [x] `runner.ts` at 45.3% is the weakest module. **Resolved (2026-09-07):**
      84.2%, with no uncovered mutants left. The tests assert decisions rather
      than shapes, and where a mutant is genuinely equivalent - a pre-sized
      array, a worker count that changes throughput and not output - there is
      deliberately no test and a comment saying why.
- [x] `report.ts` at 56.9% is now the weakest module by a clear margin.
      **Resolved (2026-09-07):** 74.9%, the largest single-module gain of any
      pass. The kills came from contracts rather than from asserting output
      verbatim: the SGR code for each role, an empty environment variable
      meaning unset, all three severities and both success glyphs, parse
      problems in the JSON report, and item shapes in the export.
      `shouldUseAscii` now takes its platform the way it already took its
      environment - without that, half of it was unreachable from a test and a
      rule about Windows consoles could only ever break on Windows.
- [ ] Should `coverageAnalysis` be `all` in CI? It is the only setting that
      measures async modules honestly, and at roughly seven times the runtime
      it would not fit a per-push job. A nightly `all` run against a weekly
      `perTest` one would give both, at the cost of a second workflow.

## See also

- [ADR-0006](0006-false-positives-cost-more.md) - the other half of what
  "verified" means here: not just that the code does what the tests say, but
  that what it reports is worth reporting.
