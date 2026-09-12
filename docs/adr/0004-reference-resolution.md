---
status: accepted
date: 2026-09-07
---

# ADR-0004: Reference resolution is deliberately asymmetric

## Context

Foreign-key validation across a corpus of Markdown only works if `ADR-7`,
`ADR-0007`, `adr 7`, `[[0007-sharding]]` and `../adr/0007-sharding.md` are all
understood to name the same document.

Getting that wrong is fatal in either direction. Too strict, and every real
repository drowns in false "broken reference" findings on the first run and the
tool is uninstalled that afternoon. Too loose, and `RFC 7` silently resolves to
`ADR-7`, which is worse than not checking at all.

There is a third trap. A naive scan for identifiers in prose finds `ADR-0007` -
and also `SHA-256`, `UTF-8`, `RFC-9999`, and the `adr-0007` inside
`https://example.com/adr-0007/notes`. Reporting those as broken references is
exactly the noise that teaches people to ignore the output.

## Decision

Four asymmetries.

**Deliberate references are validated; opportunistic ones are not.** A link, a
front-matter field or a directive that does not resolve is a broken foreign key
and is reported. A bare identifier found in prose is opportunistic: it is
reported only when its family already exists in the corpus. `ADR-0099` in a
repository full of ADRs is a real dangling citation. `T-1000` in the same
repository is a sentence about a robot.

**Textual aliases are global; bare numbers are family-scoped.** `adr-7` carries
its own family, so it resolves anywhere. A bare `0007` resolves only within the
citing document's family, because a repository holding both `adr/0007` and
`rfc/0007` is completely ordinary and guessing between them would be worse than
reporting nothing.

**Two candidates is worse than none.** A reference matching several documents is
reported as ambiguous rather than bound to whichever was indexed first. This
holds for paths as well as for names, and the distinction that makes it workable
is exact against inexact. A file's literal path has one owner and is never
ambiguous. The spellings that address a file without naming it - the extension
dropped, a directory standing for its README - can belong to more than one:
`docs/A` is both `docs/A.md` and `docs/A/README.md`, and only the author knows
which was meant. Through 0.2.2 those spellings shared an index that held one id
per key, so a second claimant did not make the link ambiguous, it overwrote the
first.

**A suggestion may be close in the name and never in the number.** Once a
reference has failed outright, spec-graph offers the one document the author
probably meant - `ARD-0015` for `ADR-0015`, `0002-cacheing.md` for its sibling
one letter away. It will not do the same for `ADR-0003`, and that restraint is
the whole design rather than a limitation of it: a family name is a word people
misremember, while a number *is* the identity, and every number sits one edit
from its neighbours. A repository of fifteen ADRs citing a sixteenth is told the
plain truth instead of being sent to the fifteenth.

The gates are narrow for the same reason. A path suggests only a sibling in the
directory it already named, because a typo that also moved the file is two
guesses stacked on one another. A family suggests only with its number intact.
Everything else falls back to a one-edit match against the spellings a document
already answers to, floored at six folded characters - below that an edit is
most of the word. And each gate ends the same way: exactly one candidate, or
silence, because a hint is the last place to reopen an ambiguity this module
refuses to resolve anywhere else.

There is deliberately no suggestion for a file that moved. Resolution already
binds a path by its basename, so a link to `../guides/onboarding.md` finds the
document now living in `handbook/` with no guess to confirm - and a suggestion
nobody needs is a suggestion that can only ever be wrong.

Link constructs are blanked before prose is scanned for bare identifiers, so a
citation written as `[ADR-7](https://example.com/adr-7)` yields one reference
rather than three. This relies on the masking guarantee in
[ADR-0001](0001-hand-written-markdown-scanner.md).

## Consequences

Some genuinely broken bare citations go unreported - a reference to a family that
exists nowhere in the corpus is indistinguishable from ordinary prose. That is
the right trade: a linter is only as useful as its signal-to-noise ratio, and
false positives cost more than the misses they prevent.

Relations also carry every site that declared them, not just the first. A
supersession recorded only in the superseding document leaves a reader who lands
on the superseded one with no redirect, and that is a finding
(`unreciprocated-supersession`) rather than a duplicate to be collapsed away.

## Open Questions

- [x] Should cross-repository references resolve? **Declined (2026-09-12).**
      Every way of doing it needs spec-graph to know about a second checkout it
      was not pointed at - a lockfile of remotes, a fetch, a cache - and all
      three put network or discovery underneath a pipeline whose whole test
      strategy rests on being a pure function of text. A monorepo passes several
      roots today. Two separate checkouts are two runs, and a reference between
      them is what `ignoreReferences` is for.
- [x] Should a near-miss suggest a correction (`did you mean ADR-0009?`) by edit
      distance? **Resolved (2026-09-12):** yes, under the fourth asymmetry above.
      Distance alone was the wrong question; what a suggestion needs is distance
      in the part of the spelling that is not the identity.
