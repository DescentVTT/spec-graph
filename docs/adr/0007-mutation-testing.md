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

**`break` sits at 60, below the measured 63.31%.** Its job is to fail the build
when the suite gets weaker, not to assert an aspiration nobody has met.

## Consequences

The measured score is **63.31% over 6,083 mutants** at commit `aff5533`. It has
moved 48.11% → 60.6% → 63.31% as the suite grew from 149 to 363 tests.

It is worth being straight about what that number is and is not.

**It is not "all vocabulary tables".** That would be a convenient story, and the
data does not support it. String literals - message text and vocabulary entries -
are the single largest surviving bucket at 632 mutants, but excluding them
entirely moves the score only to 66.5%. The body of the survivors is 542
conditional-expression mutants spread across every module. Roughly a third of the
mutants survive, and most of that is genuine headroom rather than noise.

**The survivor list is more useful than the score.** Reading it, rather than
chasing the number, is what produced the 28 tests in `tests/edge-cases.test.ts`.
Every one of them passed on the first run - the behaviour was already correct,
it was simply unverified, and unverified behaviour is what silently changes under
a refactor. That is the return on this tool, and it does not require the score to
be high to pay out.

**Some survivors are not worth killing.** Removing `'provisional'` from the draft
vocabulary fails no test, and the test that would catch it asserts that one word
of a thirty-word table exists. A hundred such tests would raise the score and
detect nothing a human would call a defect. Where a table entry is load-bearing -
the checkbox characters, the four lifecycle phases - it has a test. Where it is
one synonym among many, it does not.

## Open Questions

- [ ] Should the `Regex` mutator be scoped? At 57.9% it is among the weakest, and
      the Markdown scanner is mostly regex - but several of its survivors look
      like genuinely equivalent mutants rather than gaps.
- [ ] `runner.ts` at 45.3% is the weakest module. Most of it is orchestration
      that the CLI suite covers end to end; the survivors are concentrated in
      default values. Worth a closer look before the next release.

## See also

- [ADR-0006](0006-false-positives-cost-more.md) - the other half of what
  "verified" means here: not just that the code does what the tests say, but
  that what it reports is worth reporting.
