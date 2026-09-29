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

*Amended 2026-09-27.* A marker is read however its writer typed it, as long as
the qualification holds. `IN_PROGRESS:` is `in progress`, `Won’t fix:` with a
curly apostrophe is `won't fix`, and `Resolved – one node` punctuates the marker
with an en dash as `Resolved - one node` does with a hyphen. The pattern already
found the en and em dash; the check that followed it asked only for a hyphen,
so an editor that typographs its dashes left every such marker as prose. None
of the three widens what counts as a statement's start, and a dash that runs
into the next word still qualifies nothing.

*Amended again 2026-09-27.* **An item delegated to a document that can still
take work is not an orphaned obligation**, though its openness stays `open`.
The question went on: `orphaned-obligation` asks for each item of a retired or
frozen document to be moved to a live document or closed, and delegating it
is the move. Delegated into another retired or frozen document, or a record,
it disappears all the same and is still counted - no ghost handover reports it,
since that rule leaves a retired source out. Blocked by a live document is not
delegated to one: the work is still the sealed document's.

*Amended 2026-09-30.* Markers and obligation headings are read in Chinese,
Traditional and Simplified, each as the English word it translates: `已解決`
and `已決定` are `resolved` and `decided`, `部分解決` is `partially resolved`,
`已移交` is `handed off`, `技術債` is `technical debt`, and `待辦事項` holds
obligations as `To Do` does. The qualification is the same: a Chinese marker
has no case to shout in, so it counts punctuated, `已決定：`, or emphasised,
`**已決定**`, and never as a word in a sentence, `我們已決定採用`. A statement
also starts after a Chinese sentence end, `。`, `？`, `！` or `；`, with a space
after it or none, since Chinese writes none: `是否分片？已決定：不分片。` closes
its item. The README lists every word, and the tests read the list.

## Open Questions

- [ ] Should `narrowed` items carry the *remaining* scope as structured data
      rather than as free text? It would let a rule check that the remainder was
      re-homed, but no convention for expressing it exists yet.
- [~] Which checkbox characters to support beyond `[ ]` and `[x]`. Narrowed to
      the set several ecosystems already share: `~`, `-`, `?`, `/`, `!`, `*`, `+`.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) does the same thing for documents.
