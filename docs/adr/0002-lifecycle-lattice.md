---
status: accepted
date: 2026-09-07
---

# ADR-0002: A four-phase lifecycle lattice

## Context

Every specification ecosystem invented its own status vocabulary and no two
agree. MADR says `accepted`. Kubernetes KEPs say `provisional`, `implementable`,
`implemented`, `deferred`, `withdrawn`, `replaced`. Rust RFCs say `merged` and
`postponed`. Internal wikis say `Live`, `Signed off`, `DONE`, and
`Accepted (2024-06) — superseded by the platform rewrite`.

A tool that hard-codes one vocabulary is a tool for one ecosystem. A tool that
tries to model all of them accumulates an enum nobody can reason about, and every
rule grows a switch statement over thirty cases.

## Decision

Normalise every status onto four phases, chosen so that the questions spec-graph
asks can be answered from the phase alone:

| Phase     | Binding? | Mutable? | Absorbs new work? |
| --------- | -------- | -------- | ----------------- |
| `draft`   | no       | yes      | yes               |
| `active`  | yes      | yes      | yes               |
| `frozen`  | yes      | no       | no                |
| `retired` | no       | no       | no                |

The last column is the whole point. It is a single predicate - `receptivity` -
and it is what ghost-handover detection runs on. Delegating an open obligation
into a `frozen` or `retired` document is a write to a closed ledger.

A fifth value, `unknown`, exists for documents that never declared a status.
It is deliberately outside the lattice: rules treat it permissively rather than
guessing.

Retirement is terminal, so a retirement word anywhere in a status string wins.
`Accepted, later superseded by ADR-0001` is retired, not active.

## Consequences

Supporting a new ecosystem is a table entry in `src/lifecycle.ts`, never a rule
change. That is what keeps the engine domain-agnostic.

The cost is that nuance is lost: a KEP that is `deferred` and one that is
`withdrawn` both become `retired`. The raw string is preserved on the node and
printed in reports, so a human still sees which one it was.

Status is also inferred from directory layout - a document under `archive/` or
`superseded/` is retired even with no front matter - because moving a file is the
most common way a team retires a decision without editing it.

*Amended 2026-09-26.* The status word `archived` has left the retired row. It
reads as a record ([ADR-0011](0011-a-record-is-not-a-specification.md)), which
is what every spec-* tool means by it: a finished round of work, which it is
normal to depend on. The directories are unchanged.

*Amended 2026-09-27.* A word is read however its parts are joined. `not_planned`
and `in_progress`, the spelling issue trackers export, read as `not planned` and
`in progress`: an underscore between two letters joins two words, and stripped
along with emphasis it had run them into one word that is in no row. An
underscore at either end of a word is still emphasis. And `Superseded – ADR-0009`
names its successor with an en dash as it already did with a hyphen or an em
dash.

*Amended 2026-09-30.* A status is read in Chinese as well, Traditional and
Simplified, and each Chinese word is the English word it translates, in that
word's row: `延後` is `deferred` and retired, `封存` is `archived` and a record,
and `暫定` is `provisionally accepted`, ahead of the active row. That keeps the
spec-* tools in step with no rule of their own for Chinese: each does with a
Chinese word what it already does with the English one. The words are in the
README's table, which the vocabulary test reads.

Chinese puts no space between words, so a word in Han characters cannot be
looked up whole: `已接受，後被ADR-0003取代` split on everything that is not a
letter is `已接受`, `後被adr` and `0003取代`, and read as active. A Han term is
found anywhere in the status instead, as a hyphenated term already was, except
directly after a negation - `不`, `未`, `非`, `沒`, `没`, `無`, `无`, `勿`, and
`不再`; `尚未` ends in `未` - so `未接受`, `尚未核准` and `不再生效` say nothing.
A term that starts with one, `不採納`, is itself.

Two superseded forms are rules rather than words, tried before the table. `被`
followed within thirty characters, in the same sentence, by `取代`, `替代` or
`取而代之` is superseded, and what stands between them names the successor:
`已被 ADR-0003 取代` is retired and says ADR-0003 replaced it, so the other
document's `supersedes:` is answered. `已取代` said alone is superseded;
followed by a name, after spaces or a colon - `已取代 ADR-0002`, `已取代舊方案`
- it usually says what this document replaced, and it is not read at all,
since reading it either way would be a guess (ADR-0006). `取代` with no `被`,
`已接受（取代 ADR-0002）`, retires nothing.

`## 狀態` and `## 状态` head a status section, with an ASCII or a full-width
colon, and `**狀態：**` labels a register section's status. In front matter
`狀態:` and `状态:` are status keys, after `status` and before `state`, from
spec-core 5666c96, which reads a key of any script. Only an ASCII colon ends a
key there, as YAML has it, so `狀態：已接受` in front matter is a line left
unread, counted as a status left out, and not a status.

A status is also read from a key-value table at the top of a document,
`| 狀態 | 已接受 |` or `| Status | Accepted |`: a table of exactly two columns,
above the first heading below the title, whose left cell, emphasis stripped,
is `Status`, `State`, `狀態` or `状态` in any case, the header row included. The
first such row gives the right cell as the status. It ranks with a `## Status`
section, after one, and front matter still wins. A table with more columns,
one under a heading, and one spec-graph reads as a register are never read for
it: a legend or a register describes other things.

*Amended 2026-09-30, after 0.10.0.* The Chinese reading above is taken out
again, and a status is read in English. A document may be written in any
language; its status is written in English - `status: superseded`, or
`Superseded by ADR-0007` under `## Status` - and every spec-* tool reads
that. The maintainer chose one language: a small team keeps one vocabulary
right, and a heuristic in a second language is where false positives come
from (ADR-0006). A term found anywhere in a status, a list of negations and
two passive forms were rules nobody here could check against the documents
they read. So a Chinese status word, `被 ... 取代`, `已取代`, `狀態` or `状态`
as a key, a heading, a label or a table key, and a full-width colon after a
status label or heading, all say nothing: the phase is unknown, as it is for
any status the table does not hold. The table at the top stays, with the
English keys `Status` and `State`: a table of a document's fields is where
many teams put its status, whatever language they write in. A front-matter
key of any script is still read as a key, as YAML reads one, and so is no
parse problem; `狀態` is simply no status key. And a list of successors
punctuated full-width, `Superseded by ADR-0003，ADR-0004`, is split as one
punctuated in ASCII: left whole, it names no document, and each successor
would be reported as one the status never acknowledged.

## Open Questions

- [ ] Should `frozen` and `retired` be distinguishable in the `receptivity`
      predicate rather than collapsing to `sealed`? No caller needs it yet.

## See also

- [ADR-0003](0003-item-state-signals.md) applies the same reasoning to items.
