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

0.4.0 reproduced the shape on a realistic change. Two full runs on one machine,
`src/` differing only by a simplified comparator, 23 test cases added to two
files. The total moved 79.03% → 79.41%; eight files nobody touched moved a point
or more, and again in both directions - `source.ts` +4.55, `runner.ts` +3.08,
`directives.ts` +2.60, against `state.ts` -2.14, `glob.ts` -2.08 and
`baseline.ts` -1.99. This is weaker evidence than the run above, because adding
tests genuinely does change which tests `perTest` believes cover which mutants.
That is the point: **the ordinary act of writing a test moves the score of files
you did not open**, so a per-file comparison across two runs is not a measurement
of anything you did.

The one number that meant something was the file the work was actually in.
`project-rules.ts` went 86.89% → 99.50%, and that did not come from re-running
anything. It came from reading its survivor list: a targeted
`--coverageAnalysis all` pass agreed with `perTest` to within half a point, which
said the gap was real, and sixteen of the survivors were tests nobody had
written.

`perTest` stays, because `coverageAnalysis: all` runs the whole suite per mutant
and the hosted run already takes 80 minutes of its 90-minute cap. The cost is
paid in honesty instead: **the hosted figure is the one that governs**, because
that is where the build actually fails, and the developer figure is a fast local
proxy that reads a few points high.

**Incremental runs are trusted for the gate, and rebuilt weekly anyway.** A full
hosted run takes 80 minutes; an incremental one on a warm cache takes 36
seconds. Measured against each other on the same source, they read 73.82% and
73.34% - within half a point, with incremental reporting 35 more survivors than
the rebuild.

*Amended 2026-09-10.* This paragraph used to continue "it errs low, which is the
safe direction for something that fails a build: it cannot hide a regression by
reading high." **That was wrong, and 0.3.0 measured it wrong.** The tag and the
branch push were the same commit, `84fa10d`, on the same hosted runner:

| | score | killed | timeout | survived |
| --- | ---: | ---: | ---: | ---: |
| full rebuild | 75.14 | 5,792 | 314 | 1,800 |
| incremental | 78.32 | 6,061 | 303 | 1,542 |

Incremental read **3.18 points high** and 258 survivors short. The direction was
never the property; the half-point was. What actually governs the size of the
error is **how far the restored report is from the source being measured**: the
earlier comparison restored a cache one commit old, this one restored from
v0.2.3, nine commits and two thousand lines back, because the nine were pushed
together. Incremental reuse is an inference about which mutants a change can
reach, and the further back the inference starts, the more of it is wrong.

So the honest statement is narrower. **Incremental is a fast signal, not a
verdict**, and it can read high enough to hide a regression for as long as the
cache stays stale. What keeps that bounded is not a direction it errs in - there
isn't one - but the two places a full run is unconditional: the Monday rebuild
and every tag. A regression can therefore sit on `main` behind a stale cache for
up to a week, and that is the cost of a fast gate against an 80-minute one.

*Confirmed 2026-09-12.* The claim above says the direction is not a property, and
0.4.0 is the first run to see the other one. The `main` push and the `v0.4.0` tag
were the same commit, `6f398ee`, on the same hosted runner:

| | score | mutants | killed | timeout | survived |
| --- | ---: | ---: | ---: | ---: | ---: |
| full rebuild | 75.40 | 8,585 | 6,161 | 312 | 1,896 |
| incremental | 74.11 | 8,585 | 6,044 | 318 | 2,007 |

Incremental read **1.29 points low** this time, having read 3.18 points high at
0.3.0. Two observations, opposite signs: the direction is not a property, and
nobody should build a safety argument on one.

Note the mutant count. The incremental run reported the whole corpus - 8,585,
the same as the rebuild - because the change was broad enough that there was
nothing left to reuse: a new module and eight touched files. An incremental run
after a wide change is a full run with extra bookkeeping, and it billed like one,
taking **110 minutes against the rebuild's 103**. The 36-second figure above is
real and belongs to a narrow change; it is not what the gate costs on a release.

**And the rebuild could not record having corrected anything.** The cache was
keyed on the commit, with a comment saying that gave every run a fresh entry. Two
runs share a commit: the branch push saved `stryker-Linux-6f398ee` at 11:00, and
at 12:45 the tag's full run logged *"Cache hit occurred on the primary key ...,
not saving cache"* and discarded its own report. The very next incremental run -
a documentation commit, nothing mutable changed - restored the incremental
lineage and reproduced it to within one mutant, 74.12 against 74.11, while the
rebuild that was supposed to supersede it had measured 75.40.

Which makes the paragraph above worse than it read. The claim was that a wrong
inference is bounded because a full run is unconditional on a tag and on Mondays.
The full run happened; its result was thrown away; the next inference started from
the wrong report anyway. The bound held only through the Monday rebuild - and
not for the reason first given here, that its commit has no earlier run to
collide with. The real reason is the cache's scoping, found a release later and
recorded below.

The key is `github.run_id` now, which is unique, so every run saves and the
prefix restore picks up the most recent entry it is allowed to see - which, as
0.5.0 showed, never includes a tag's. Worth writing down for what it
is: a declaration in a comment that had drifted from what the code did, in the
CI of the tool built to find exactly that, found by reading a log instead of
trusting the comment.

*Confirmed again 2026-09-13.* 0.5.0 gives the third observation, again the
`main` push against the tag on one commit, `940f8e2`, on the hosted runner:

| | score | mutants | killed | timeout | survived | minutes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| full rebuild | 76.83 | 9,697 | 7,109 | 341 | 2,023 | 168 |
| incremental | 76.43 | 9,697 | 7,064 | 347 | 2,062 | 64 |

**0.40 points low.** Three releases, three readings - 3.18 high, 1.29 low, 0.40
low - and the spread is the whole finding: incremental is a signal about the
direction of a change, and never a figure to quote.

This time it did reuse something: 4,465 of the 9,697 results came from the cache,
and the run took 64 minutes to the rebuild's 168. So the cost of the gate on a
release is not a constant either - it depends on how much of the corpus the
change leaves alone.

**A per-file gap in an incremental run looked like staleness, and mostly was
not.** Against the local full run, the incremental one read `lifecycle.ts` 18
points low, `directives.ts` 7 and `yaml.ts` 8, all files 0.5.0 never touched.
The tempting reading was that those were cached results from an older lineage,
and the first reading of the incremental result said so, as a question. The
rebuild answered it: `directives.ts` and `yaml.ts` scored identically in both
hosted runs, and only `lifecycle.ts` moved much (53.88 to 62.40, still nine
points under local). Most of that gap is the hosted-against-local attribution
difference this ADR already describes. Worth recording because the wrong answer
came with a plausible mechanism attached, and the only thing that separated them
was running the full measurement rather than reasoning about the partial one.

**The rebuild saved its report, and it still could not reach `main`.** The tag's
run logged `Cache saved with key: stryker-Linux-34724969717`, and this ADR first
read that as the correction arriving at last. The next push to `main` said
otherwise. A documentation commit, reusing 9,696 of 9,697 results, restored from
`stryker-Linux-34713469263` - the previous *incremental* run on `main` - and read
76.44: the incremental lineage to within a hundredth, not the rebuild's 76.83.

The reason is a rule of the cache rather than of this workflow. A run can restore
only caches created on its own ref or on the default branch, and the cache list
shows where each entry lives:

```text
stryker-Linux-34735515258   refs/heads/main     push, the docs commit after the tag
stryker-Linux-34724969717   refs/tags/v0.5.0    the tag's full rebuild
stryker-Linux-34713469263   refs/heads/main     push, the release commit, incremental
```

A tag's run can read `main`'s entries - which is exactly how 0.4.0's tag found a
primary-key hit and declined to save - and nothing on `main` can read a tag's. So
keying on the run fixed the discard and not the lineage, and the lineage was never
fixable from a tag at all. 0.3.0 had already shown it, unread: its tag *did* save,
under `refs/tags/v0.3.0`, with no collision to stop it, and `main` never saw that
report either.

So a wrong incremental inference is bounded by exactly one thing: **a full run
whose cache lands on `main`** - the Monday schedule, or a manual dispatch on
`main`. The tag's rebuild is still the figure a release quotes, because it
measures the tagged commit from nothing. It corrects nothing that runs after it.

This is the failure this section already records, one layer further down. A
comment said keying on the commit gave every run a fresh entry; the fix for that
said the prefix restore would pick up the tag's rebuild; and this ADR said the
next incremental would start from a full report. Each was a mechanism described
from its configuration and believed until a log was read.


This also corrects the headroom, in the useful direction for once. Against 73.32%
with 305 timeouts - four percent of the corpus, and a timeout is a timing
measurement - a bad run read 69.3%, which is *below* the guard. Against 0.3.0's
75.14% with 314 timeouts of 8,126, the same worst case reads 71.28%. `break: 70`
now clears it by a point and a quarter rather than failing it, which is the first
time the guard has had real margin under the pessimistic reading - and still not
enough margin to justify moving it.

0.4.0's hosted figure is 75.40% with 312 timeouts of 8,585, so the same worst
case reads 71.76% - half a point better again. Three releases of the guard
holding while the pessimistic reading climbed from below it to a point and three
quarters above it is an argument for leaving it exactly where it is.

0.5.0's hosted figure is 76.83% with 341 timeouts of 9,697, so the worst case
reads 73.31%, the first time it has cleared the guard by more than three points.
Four releases of the same argument, and it still does not justify moving the
floor: the local figure over the same mutants is 80.54%, 3.71 higher, and that
gap has been about four points for two releases.

**The run nearly did not finish.** The rebuild took **168 minutes against a
job cap of 180.** 0.4.0's took 103 minutes on 8,585 mutants; 0.5.0 has 13% more
mutants and took 63% longer, while the local full run grew only 15%, from 64m30s
to 74m27s. The cap was raised from 120 at 0.4.0 on the argument that a ceiling
costs nothing unless it is reached; at 120 this run would have been cancelled at
two hours and reported nothing, and the release would have had no governing
figure at all.

The cause is not established, and two candidates are on the table without
either being measured. Hosted runner speed has moved this number before - 80
minutes to 103 on a 6% larger corpus between 0.3.0 and 0.4.0. And `regex.ts`
arrived with a differential test that compares two engines over roughly 19,000
pattern-subject pairs, which `perTest` re-runs for every one of that module's
~770 mutants it covers; locally that suite takes about 130 ms, which accounts for
minutes of worker time rather than an hour, but the hosted multiplier is
unknown. Twelve minutes of headroom is the position that once produced fourteen
consecutive cancelled runs, so this is recorded as an open question rather than
as a comfortable margin.


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

**A survivor can be a defect in the test corpus rather than in the tests.**
0.5.0 produced the clearest example this project has had, because the module in
question is verified against an oracle and the oracle agreed anyway.

`regex.ts` is checked by running every pattern through both it and `RegExp` and
comparing — 1.33 million pattern-subject pairs, no disagreements. Its mutation
score still had a survivor on the line that steps past the `^` in a negated
character class:

```ts
if (negated) this.position += 1;
```

Mutated to `-= 1`, `[^abc]` compiles as `[^[^abc]`, and the whole suite still
passed. Hand-mutating it — the practice above — confirmed the survivor was real
rather than a `perTest` artefact, and then the question was why 1.33 million
comparisons had missed it. The answer is that the corpus had a blind spot with a
name: **a two-character subject gives the pattern a second chance.** The class
tests were run against `"[]"`, where the wrongly-included `[` is cancelled by the
`]` that follows it. One character on its own is a different question, and the
corpus contained none.

Adding `[`, `]`, `^`, `{`, `|` and the rest as subjects in their own right killed
that mutant. It also found a **bug the oracle had been agreeing with all along**:
`[\d-\w]` matched U+017F, because upper-casing it gives `S` and the range
check tried the character's case forms without asking whether the fold survived.
It does not — the specification keeps a non-ASCII character out of ASCII, which
is the same clause that had already been read wrongly once, in the word-character
set for `\b`. Two bugs, one clause, found by two different techniques a week
apart.

So the composition is worth stating: **the oracle checks the implementation
against a corpus, and the mutation score checks the corpus.** Neither finds what
the other does. A differential test with a blind spot passes forever; a mutation
score with no oracle behind it only says the tests notice changes, not that the
changes are wrong.


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
- [ ] The full hosted run took 168 of its 180 minutes at 0.5.0. Raise the cap
      again - a hosted job may run for 360 - or make the per-mutant test cost
      smaller? Neither should be chosen before the time is attributed: runner
      variance and the new differential test in `regex.test.ts` are both
      plausible, and a cap raised to cover an unmeasured cause is the same
      guess as a floor lowered to cover an unmeasured regression.

## See also

- [ADR-0006](0006-false-positives-cost-more.md) - the other half of what
  "verified" means here: not just that the code does what the tests say, but
  that what it reports is worth reporting.
