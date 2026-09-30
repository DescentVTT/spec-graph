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

**Running against an unseen corpus keeps finding these, and nothing else does.**
Two more surfaced on the v0.1.2 pass, both in how far a governing verb reaches,
and neither was visible to 454 passing tests:

- The look-behind window crossed a **table cell edge**. An index of archived
  documents whose column ended "...read the banner before assuming the drift was
  fixed" made every following row's link an `assumes` edge, and so made every
  archived document it listed a stale premise. A table row is a list of
  independent fields; the cell edge now ends a statement.
- A verb reached across a **negation**. "Owned by nobody today and disclaimed by
  [138]" was read as a delegation *to* 138 - the opposite of what the sentence
  says. An inference that inverts its own source is worse than no inference.

Nine of eighteen findings on that corpus were these two bugs. The lesson is not
that the heuristics were badly chosen; it is that a synthetic fixture never
writes a sentence like that, and only a repository nobody wrote for the tool
will.

*Amended 2026-09-27.* Two more, found the other way round: by reading what a
mutation sweep could not pin down, where the only test that would have pinned
it asserted a false alarm.

- **A link to a file was read as a link to a document** when the file was a
  dotfile or its extension was long. `../.nvmrc` has its only dot first, which
  counted as no extension at all, and `arch.excalidraw` has an extension of
  ten letters, which counted as part of an identifier. Both were broken
  references. An extension is now a dot and a letter, however long, and a
  dotfile has one; either makes the link a link to a file, which is not a
  reference. A dot followed by a digit - `ADR-0007.1`, `v1.2` - is still part
  of an identifier.
- **A superseded document handing its open question to its successor was a
  delegation cycle.** The newer decision supersedes the older, and the older
  defers its question to the newer: projected onto documents that is a loop,
  and nothing in it is ever passed back. It is the hand-off supersession exists
  for, so the cycle search leaves it out
  ([ADR-0005](0005-rules-are-queries.md)).

Three more, raised in review of the two above:

- **A loop that took a supersession to close was a delegation cycle** when the
  hand-off went further than one step: to the latest of two successors, or to
  the successor by way of a third document. Obligations and supersessions are
  now searched for cycles apart ([ADR-0005](0005-rules-are-queries.md)).
- **A superseded document whose open question was delegated to a live
  document still held an orphaned obligation.** The finding's own hint - move
  each item to a live document - had been followed. An item delegated to a
  document that can still take work is not counted
  ([ADR-0003](0003-item-state-signals.md)).
- **A link to a directory without its trailing slash was a reference outside
  the corpus**, "resolves to a file that is not a specification", with a hint
  to widen patterns that could never reach it. The disk now says whether the
  path is a directory, and a directory is not a reference either way.

*Amended 2026-09-30.* A governing phrase is read in Chinese, and the two
limits above carry over to it. Ten phrases hand work on as `deferred to` and
`handed to` do - `延後至`, `延至`, `移交至`, `移交給`, `留待`, `交由`, `併入` and
their Simplified forms - each standing before the reference. Chinese puts no
space between words, and a Han character is a letter, so the word boundary an
English phrase needs would never match inside Chinese; a Chinese phrase has
none, and an English phrase no longer counts a Han character as part of its
word, so `此問題deferred to ADR-0002` is a delegation as it is with a space.
The negation that inverts a Chinese phrase stands directly before it,
`未移交給 ADR-0002`, and cancels it. And a statement ends at `。`, `？`, `！`
and `；`, with or without a space after: without that,
`上次延後至別處。另見 ADR-0002` handed a question to ADR-0002 from the sentence
before, the table-cell bug again in another script.

Two things are left out on purpose. `根據`, `依據` and `基於` would be `assumes`,
and Chinese uses them for any citation: read as premises, they would make a
stale premise of every document that mentions a retired one. And a verb
written around the reference, `由 ADR-0002 決定` or `在 ADR-0002 中追蹤`, is not
something a phrase before the reference can express; those are missed, which
is the direction this ADR prefers. `併入`, merged into, is a hand-off rather
than the supersession `rolled into` is: read as a supersession, a constraint
merged into another decision's design would retire the document stating it.

*Amended 2026-09-30, after 0.10.0.* The Chinese phrases are taken out with
the Chinese statuses (ADR-0002, the same day), and with them the negation
read directly before a phrase and the boundary that let an English phrase
touch a Han character: a Han character is a letter again, so
`此問題deferred to ADR-0002` is a reference and no more. The stop at `。`,
`？`, `！` and `；` stays. It only ends a statement sooner, so it reads fewer
relations and never more - `Deferred to later。另見 ADR-0002` hands nothing
to ADR-0002 - which is this ADR's direction whatever language a document is
written in.

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
