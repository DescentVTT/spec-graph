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

Three asymmetries.

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

- [ ] Should cross-repository references resolve? A monorepo can already pass
      several roots, but two separate checkouts cannot see each other.
- [ ] Should a near-miss suggest a correction (`did you mean ADR-0009?`) by edit
      distance? The plumbing carries candidates; nothing computes them yet.
