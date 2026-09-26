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

*Amended 2026-09-26.* **One status word reaches it: `archived`.** spec-brief
closes a round of work by writing `status: archived` into the brief and moving
it to an archive directory, and the family's lifecycle table gives the word
one meaning in every spec-* tool: a closed round, frozen, and a record -
depending on it is normal
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
spec-graph read it as retired, so a live brief that depended on an archived
one was a stale premise, and an archived brief with a task left unticked was
an orphaned obligation: two findings about a round nobody can reopen, which is
the noise [ADR-0006](0006-false-positives-cost-more.md) exists to prevent.

That does not reopen the argument above. `Historical` was a guess about what
one team meant by a word another team uses differently; `archived` is the
family's word, written by a tool, with one meaning. It is a table entry
(`lifecycle.ts`), after the retirement words, so a status of
`archived, superseded by B-0007` is still retired. The `archive/` directory
still retires a document that declares no status of its own, as
[ADR-0002](0002-lifecycle-lattice.md) says - it is how a team retires an ADR
without editing it, and a brief that spec-brief archives says `archived`
itself. A team that wrote `archived` to retire a decision now has a record: its
links are checked and its open items are nobody's, and a document resting on
it is no longer told it rests on something retired. `superseded`, `deprecated`
or `retired` says that.

**An archived document is a closed round, not a log.** The exemption below was
written for logs, and reached through the status word it covered more than the
word means: a supersession an archived brief declares, a cycle it closes and a
link it makes to itself are claims somebody can still correct, and 0.8.0, which
read the word as retired, reported each. So a document says which way it became
a record - `history` is true when it was declared - and an archived one is
exempt only from what it was exempt from as retired: the work it hands on and
the premises it rests on. What changes from retired is what the rest of the
graph is told about it, which is the point of the amendment: what depends on it
rests on nothing stale, and its open items are orphaned from nobody. And one
thing about itself: an archived document something else supersedes, and that
never says so, is told to make its status `archived, superseded by ADR-0002`,
which retires it and tells what rests on it, rather than to add a
`superseded-by` key beside `archived`, which would do neither.

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
  const owner = graph.owningDocument(nodes[0]);
  if (owner?.phase !== 'record') return false;
  // A log is exempt from all of it; an archived round, from two rules.
  return owner.history || CLOSED_ROUND_RULES.has(rule);
}
```

Not as a guard repeated in eight rules. The exemption is a property of what
counts as a finding at all - spec-graph reports work a human can do, and a
record documents work already done - so it is stated once and every rule
inherits it, including rules written later that would have forgotten.

Two cannot be exempted there. One is `circular-delegation`, whose subject is a
set rather than a node. A cycle with a log in it is partly a report of what was
once said, and nothing in it is owed by anybody, so the traversal skips it
there. The other is a supersession a log declares, whose finding lands on the
document it names, so `supersessions` skips that one itself. Neither skip
applies to an archived document, whose claims are its own.

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
- [x] A document that is partly a record - a specification with a changelog
      section at the bottom - is one node with one phase.
      **Declined (2026-09-12),** and the premise turned out to be wrong on the
      way. Regions cannot express it: a region is a row of a register, and
      `record` is decided once for a file and inherited by everything inside it.
      A `<!-- @spec-history -->` written in the changelog section marks the whole
      document, which is the opposite of what somebody reaching for it wants.

      Making it work means a second place `record` can come from - a section
      flag as well as a file one - and `record` is currently a categorical
      statement about what a file *is*, which is why the exemption in
      `rules.ts` can be stated once and inherited by every rule written after
      it. Trading that for a case with a free workaround is a bad trade: move
      the changelog into its own file, which is where a changelog belongs
      anyway, and `historyPatterns` already covers it.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) - the lifecycle this adds a phase to,
  and the `receptivity` it derives.
- [ADR-0006](0006-false-positives-cost-more.md) - why a record is declared
  rather than guessed from a filename.
