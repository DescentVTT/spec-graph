---
status: accepted
date: 2026-09-07
---

# ADR-0006: False positives cost more than misses

## Context

Every design decision in this repository eventually reduces to one question:
when the evidence is ambiguous, should spec-graph report or stay quiet?

The temptation is to report. A finding is visible work; a miss is invisible. But
a specification linter has an unusual failure mode. It runs against documents
nobody wrote for it, on a repository whose conventions it has never seen, and it
runs *first* on a corpus with years of accumulated history. If that first run
produces a wall of findings, the tool does not get tuned. It gets uninstalled
that afternoon, and then it catches nothing at all, forever.

This stopped being theoretical. Run against a third repository - 66 briefs, none
written with spec-graph in mind - the tool produced **648 errors**. Every one was
a link into an `archive/` folder that exists on disk but that the default include
patterns did not reach. Not one of them was a defect in the specifications. The
tool was reporting *its own configuration* as the user's mistake.

## Decision

When evidence is ambiguous, stay quiet. Concretely, four rules that the codebase
applies everywhere:

**An inference that cannot be justified is not made.** An unrecognised status
becomes `unknown`, not a guess. A link with no governing verb becomes a neutral
`references`, not a dependency - because a wrongly inferred `assumes` produces a
confident stale-premise finding about a document that never depended on anything.

**Distinguish the user's mistake from ours.** A citation naming a document that
does not exist is a broken foreign key and an error. A citation naming a real
document that the include patterns did not reach is
`reference-outside-corpus` at `warn`, and the hint names the exact pattern that
would fix it, resolved against the citing file. "Widen the include patterns" is
advice the reader then has to translate; `spec-graph "archive/**/*.md"` is not.

**Some things are not references at all.** A link to source code
(`../../src/rules.ts`), an image, or a directory (`archive/`) is ordinary in a
design document. Reporting those would fire on the most common thing a
specification does. Identifiers found in prose are opportunistic: reported only
when their family already exists in the corpus, so `ADR-0099` in a repository of
ADRs is a finding and `SHA-256` is a sentence.

**One defect is one finding.** `blocked-by` both transfers an obligation and is
load-bearing, so `ghost-handover` and `stale-premise` both match it. The first
claims the edge and the second skips it. Two findings on one line, for one
defect, with one fix, is a bug.

## Consequences

Real defects are missed. A dangling citation to a family that appears nowhere in
the corpus is indistinguishable from prose and goes unreported. A team that
writes wiki links to concepts rather than documents will see findings that are
correct by the tool's contract and useless to them; they turn the rule off.

That is the right trade. The same 66-brief repository now reports 11 errors and
637 warnings, and following the hint once brings it to 29 errors and none - a
corpus a human can actually work through. The tool survives contact with a
repository it has never seen, which is the only condition under which it catches
anything at all.

## Open Questions

- [ ] Should the default include patterns be widened, or is naming the fix in
      the hint enough? Widening risks pulling in changelogs and issue templates,
      which is a different kind of noise.
- [x] Should there be a `--strict` that promotes every warning to an error, for
      teams past the first run? **Resolved (2026-09-07):** yes, shipped. It
      raises `warn` to `error`, leaves `info` alone because those rules are
      advisory by design, and lets an explicit `--rule` win so a team can adopt
      strict and exempt the one rule their repository disagrees with. Every
      escalated finding is labelled, so a reader can always tell what the build
      would do without the flag.

## See also

- [ADR-0004](0004-reference-resolution.md) applies this to reference resolution.
