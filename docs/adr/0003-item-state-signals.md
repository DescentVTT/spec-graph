---
status: accepted
date: 2026-09-07
---

# ADR-0003: Item state is resolved from competing signals

## Context

A checkbox is the least reliable statement a document makes about an obligation.
Real specifications record outcomes in prose, on a continuation line, days after
the checkbox was written, and nobody goes back to tick it:

```md
- [ ] Should the write path shard before the migration?
      **Resolved (2026-03):** no - one node holds three years of growth.
```

A grep for `- [ ]` calls that an open question and re-opens a settled debate. A
grep for `- [x]` misses it entirely. Both are wrong, and being confidently wrong
about whether work remains is the failure that makes teams switch a linter off.

The state space is also larger than two. An obligation can be open, narrowed to a
smaller scope, satisfied, consciously accepted as debt, rejected, delegated, or
obviated because the premise it rested on evaporated.

## Decision

Model state as two orthogonal fields:

- `disposition` - what happened to it (seven values).
- `openness` - whether work remains (`open`, `partial`, `closed`), derived from
  the disposition.

Rules almost always want `openness`; humans reading a report always want
`disposition`.

Collect every signal an item carries and let the most specific one win:

| Priority | Signal          | Example                       |
| -------- | --------------- | ----------------------------- |
| 5        | directive       | `<!-- @spec-item state=... -->` |
| 4        | prose marker    | `**Resolved:**`, `RESOLVED -` |
| 3        | strikethrough   | `~~...~~`                     |
| 2        | checkbox        | `[ ]`, `[x]`, `[~]`, `[-]`    |
| 1        | section         | under `## Open Questions`     |
| 0        | default         | nothing at all                |

Ties are broken by document order, so the last word a reader sees is the one that
counts.

**Disagreement is reported, not hidden.** When two signals disagree about
`openness`, the winner decides the state and a `state-conflict` diagnostic names
the loser. A checkbox that contradicts its own body is a defect in its own right.

Markers are matched only in the qualified forms documents actually use -
punctuated (`Resolved:`), emphasised (`**Moot**`) or shouted (`RESOLVED`) - and
always against masked text. "We resolved to keep the queue" must not close an
item, and neither must a `**Resolved:**` inside a fenced example.

## Consequences

The marker vocabulary is a maintained list and will never be complete. That is
acceptable: an unrecognised marker degrades to the checkbox, which is the
behaviour every other tool has anyway. Being wrong in the direction of "still
open" is the safe direction.

## Open Questions

- [ ] Should `narrowed` items carry the *remaining* scope as structured data
      rather than as free text? It would let a rule check that the remainder was
      re-homed, but no convention for expressing it exists yet.
- [~] Which checkbox characters to support beyond `[ ]` and `[x]`. Narrowed to
      the set several ecosystems already share: `~`, `-`, `?`, `/`, `!`, `*`, `+`.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) does the same thing for documents.
