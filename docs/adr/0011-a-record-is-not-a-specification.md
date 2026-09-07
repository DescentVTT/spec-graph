---
status: accepted
date: 2026-09-07
---

# ADR-0011: A historical record is not a specification

## Context

Every engineering repository of any age keeps documents that are not
specifications: journals, changelogs, sprint summaries, meeting minutes, an
`RFC_ARCHIVE.md`. They look like specifications to a scanner - headings,
identifiers, checkboxes, citations - and they are nothing of the kind.

Run against one, spec-graph reported this:

```text
x docs/journal/JOURNAL_2024.md:5:22  ghost-handover
    obligation delegates to ADR-0002, which is retired
    > nothing will be read from ADR-0002 again - re-home this in a live document
```

The sentence it read was `Decision deferred to ADR-0002. Sharding would land in
Q3.` written in March 2024, about a decision retired two years later. The
finding is not wrong about the facts and there is nothing anybody can do with
it. The journal is not delegating; it is reporting that somebody once did.

Two answers were already available and both are bad. **Excluding the file** with
`--ignore` gives up link checking, and a journal full of links that 404 is
exactly what this tool is for. **Calling it retired** is closer, but a retired
specification is presumed to have had obligations that should have been closed
or handed on - which is why `orphaned-obligation` fires on retired documents.
A record never had obligations to close.

## Decision

**A record is a phase.** `draft | active | frozen | retired | record | unknown`.

It is not reachable from any status word, and that is deliberate. `Status:
Historical` on an ADR almost always means retired, and guessing that
`CHANGELOG.md` is a record from its name is the kind of inference
[ADR-0006](0006-false-positives-cost-more.md) exists to prevent. A record is
declared, two ways:

```jsonc
{ "historyPatterns": ["**/JOURNAL_*.md", "archive/**"] }   // a class of files
```

```md
<!-- @spec-history -->                                     <!-- one file -->
```

**Being a record outranks a status word written inside the file**, at the file
level and at the section level both. It is a categorical statement about what
the document is, made deliberately from outside it; a `Status: accepted` line in
a changelog entry is describing something else entirely.

**A record is sealed**, by the same rule as anything else that cannot absorb an
obligation - reached by a different route. It never was asking.

### What a record still answers for

Exactly one thing, and it is the thing worth keeping:

| | |
| --- | --- |
| its links resolve | **checked** - a broken link is broken whoever wrote it |
| its checkboxes | not obligations |
| its delegations | reports of what was said, not handovers |
| its lifecycle | not a lifecycle |
| work handed *into* it | **checked** - see below |

Delegating live work into a log is not exempted. It is the ghost handover this
tool was built to find, and being a record is what makes it certain: a log will
never act. The finding says so.

### Where the exemption lives

In one place: the boundary where a finding becomes a finding.

```ts
function exempt(graph, rule, nodes) {
  if (REFERENCE_RULES.has(rule)) return false;
  return graph.owningDocument(nodes[0])?.phase === 'record';
}
```

Not as a guard repeated in eight rules. The exemption is a property of what
counts as a finding at all - spec-graph reports work a human can do, and a
record documents work already done - so it is stated once and every rule
inherits it, including rules written later that would have forgotten.

The one exception is `circular-delegation`, whose subject is a set rather than a
node. A cycle with a record in it is partly a report of what was once said, and
nothing in it is owed by anybody, so the traversal skips it there.

## Alternatives considered

**An orthogonal attribute rather than a phase.** Truer to the model - a record
is not at a lifecycle position, it is outside the axis - and rejected for
costing more than it explains. It would have meant a second attribute in every
selector, a second thing for `receptivity` to derive from, and a second
question in every rule. The phase carries it with no engine change at all.

**Deriving it from the filename.** `CHANGELOG.md`, `JOURNAL_*.md`, `**/minutes/**`
are all obvious, right up until a repository keeps its specifications in
`docs/journal/` because that is what it calls its ADR directory. A wrong guess
here silently stops checking a real specification, which is the worst failure
this tool has.

**A `record` severity, or a rule to switch off.** Turning `ghost-handover` off
for a path turns it off for everything in that path, including the real ones. The
distinction being drawn is about the document, not about the rule.

## Consequences

The journal above reports nothing, its broken link still reports, and the
headline count of open obligations drops from three to one - which matters more
than it looks, because two of those three were minutes from 2024 and the number
was the one thing in the report nobody could act on.

The cost is a repository that has to say which of its files are records. That is
the same cost [ADR-0008](0008-wiki-links-carry-no-path.md) accepted for concept
tags and for the same reason: the alternative was a guess about a convention only
the repository knows.

## Open Questions

- [ ] Should a record's items be extracted at all? They are today, so they stay
      queryable and the text is still honest about what it says. Nothing has
      asked to hide them.
- [ ] A document that is partly a record - a specification with a changelog
      section at the bottom - is one node with one phase. Regions
      ([ADR-0009](0009-a-specification-is-a-region.md)) could express it, and
      nothing has needed it yet.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) - the lifecycle this adds a phase to,
  and the `receptivity` it derives.
- [ADR-0006](0006-false-positives-cost-more.md) - why a record is declared
  rather than guessed from a filename.
