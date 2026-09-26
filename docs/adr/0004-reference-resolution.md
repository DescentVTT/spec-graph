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

Five asymmetries.

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

**A declaration and a file name *name* a document; a title only *describes*
one.** *Added 2026-09-16.* An identifier at the start of a title usually belongs
to the document the title is about, not to the document carrying it, and reading
it as a name attributed 27 of 232 rows of one register to the wrong entity.
`| OI-V-05 | ADR-040's enforcement point has no browser test |` became
`ADR-040` - and collided with the real `ADR-040`, which then owned the row's
span and left the issue with no node at all. Nine more rows opened with a noun
phrase and invented a `STAGE-1`, a `GUARDRAIL-5` and a `CLOSED-2026` that nobody
had written, each open, each drawing findings against a document that did not
exist.

So a title is read as a name only where nothing else has given one, and where a
title is not the name it contributes no alias either. The alias is the same
mistake one step removed and it lands somewhere worse: on a real document, whose
every citation then arrives at whatever quoted it, or goes ambiguous between the
two. `# ADR-0040 considered harmful` at the top of `0007-sharding.md` was
registering `adr0040` against ADR-0007.

Two things count as having given one. A **number**, from a declaration or a file
name, settles the identity outright - a different number in a title is about a
different document. And for a **region**, its declaration, whatever shape it is
in: a row's id column exists to hold an identifier, and its title cell is prose
about the rest of the corpus.

A *file* keeps the looser reading, and that limit is deliberate. There the two
cases are the same shape and nothing separates them. Front matter is an open
vocabulary where `slug:` is in `ID_KEYS` and holds a URL segment rather than an
id, so `slug: sharding` in `sharding.md` under `# ADR-0007: Sharding` has to
stay ADR-0007 - and `id: MY-THING` under `# ADR-0040 considered harmful` reads
identically and still becomes `ADR-0040`. That is the price. Separating them
needs a rule about what may follow an identifier in a title, which is a
convention nobody has written down, and inventing one is the trade
[ADR-0009](0009-a-specification-is-a-region.md) declined for `<dl>` blocks.

The declaration and the file name are *not* ranked against each other, which is
the asymmetry rather than an omission: both name the same file, so a declaration
carrying no number still takes the number from the name beside it.

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
- [x] Should a family prefix be allowed to contain a hyphen, so that `OI-V-05`
  and `KEP-SIG-1` parse as a family and a number rather than staying
  verbatim? **Declined (2026-09-16).** `PREFIXED_ID` is not only the shape
  of an identity: it is half the gate in `looksLikeCitation`, and it decides
  what a bare token in prose may be. Widening the prefix to admit a hyphen
  was measured against a corpus of ordinary hyphenated values, and of the
  eighteen strings it newly matched, sixteen were words: `og-image-2`,
  `font-weight-400`, `x-frame-options-1`, `end-to-end-2`, `ci-cd-1`,
  `top-level-0`. Two were the intended ones.

  What it would buy is small and the other way round from the cost. An
  unhyphenated declaration is kept verbatim and already resolves from every
  spelling `normaliseRef` folds - `oi-v-05`, `OI V 05`, `oi_v_05` - so what
  is lost is the zero-padding variants, `OI-V-5` for `OI-V-05`, and a bare
  `05` resolving within an `OI-V` family. Both are misses, and a miss is
  what this repository trades false positives for.

  What would reopen it: a corpus where the padded and unpadded spellings of
  a hyphenated family are both in use, at which point the convention is
  being read rather than guessed at - and the widening would belong to
  `identify`, which knows it is looking at a declaration, rather than to the
  regular expression that also reads prose.
- [x] Is zero-padding part of an identity? **Resolved (2026-09-16): no, and one
      comparison had assumed otherwise.** `ADR-40`, `ADR-040` and `ADR-0040`
      already resolve to one document everywhere references are read, but the
      guard that stops a file's own title heading being read as a region inside
      itself compared the folded *text*. So `# ADR-040` at the top of
      `0040-enforce.md` was a region within the file it names: one decision,
      two nodes, a split lifecycle, and a citation arriving at whichever
      spelling it happened to use. The guard now compares family and number.
