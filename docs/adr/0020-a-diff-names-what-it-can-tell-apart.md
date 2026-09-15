---
status: accepted
date: 2026-09-15
---

# ADR-0020: A diff names only what it can tell apart

## Context

[ADR-0015](0015-feedback-goes-where-the-tools-already-look.md) deferred one
question rather than declining it:

> Should `spec-graph diff` report what changed *relationally* between two states
> of the graph - dependencies added or removed, a specification that moved from
> `draft` to `accepted`, an obligation that is newly unfulfilled?

It recorded half the design. The diff is not between two git revisions, which
would put process control underneath a pipeline that is a pure function of text.
It is between two `--graph-format json` exports: two files in, one report out. It
also claimed the other half was done: "a node is keyed the way ADR-0012 keys a
baseline entry, which survives a file being moved or renamed."

That claim is true of documents. It is not true of obligations, and a run shows
it. Two states of a two-file corpus, where the second adds one open question
above the others and renames `0002-plans.md` while accepting it:

| id | before | after |
| --- | --- | --- |
| `ADR-0001#open-questions.1` | "Eviction policy?" - open | "Cache size limit?" - open |
| `ADR-0001#open-questions.2` | "Wire format? Resolved: CBOR." - **closed** | "Eviction policy?" - **open** |
| `ADR-0001#open-questions.3` | - | "Wire format? Resolved: CBOR." - closed |
| `ADR-0002` | `0002-plans.md`, draft | `0002-cache-plans.md`, accepted |

An item's id is its document, its section and its ordinal within the section,
unless the item declares one. Inserting a question renumbers every question
after it. A diff keyed on ids would report that the wire-format question had
been **reopened**. Nobody reopened it. That is the kind of confident, wrong
finding [ADR-0006](0006-false-positives-cost-more.md) exists to prevent, in a
report whose whole job is to be read on a pull request. The document is fine:
`ADR-0002` kept its id through the rename, as
[ADR-0009](0009-a-specification-is-a-region.md) made sure it would.

Findings are the other thing the question named, and they already have a home.
"An obligation that is newly unfulfilled" is a finding - `orphaned-obligation`,
`ghost-handover` - and a finding that appears between two states is exactly what
`--baseline` reports ([ADR-0012](0012-a-baseline-is-a-ratchet.md)).

## Decision

**`spec-graph diff <before.json> <after.json>` compares two graph exports and
reports changes to documents, the relations between them, and the obligations it
can match. It names nothing it cannot tell apart.**

### Two exports, one binary

The comparison is a pure function in its own module, over two parsed exports;
`cli.ts` reads the files, as it reads everything else. There is no git and no
checkout in the tool. CI already has both states:

```yaml
- run: git fetch --depth 1 origin "$GITHUB_BASE_REF" && git worktree add ../base FETCH_HEAD
- run: npx spec-graph graph --root ../base --graph-format json > base.json
- run: npx spec-graph graph --graph-format json > head.json
- run: npx spec-graph diff base.json head.json --format markdown >> "$GITHUB_STEP_SUMMARY"
```

Both exports come from the same binary, and the recipe says so because the
alternative is quietly wrong. Two exports made by different versions differ
wherever extraction changed between them - a status word added to the vocabulary
reads as every document that uses it leaving `unknown` - and the diff would
report the tool's change as the repository's. So the export gains a `generator`
field naming the package and version. The diff prints one warning line when the
two differ or either is missing, and refuses exports whose schema `version` it
does not know. The addition is additive and deterministic, and the schema stays
at 1.

### What is compared

**Documents, by id.** Added and removed. A document whose id is unchanged and
whose path is not has **moved**; it is never reported as one removal and one
addition. Phase and raw status transitions are reported with both values, since
`draft` to `accepted` is the change a reviewer is looking for. A changed title is
reported as a retitle. Aliases are derived from the others and are not compared.

**Relations between documents.** Each export is projected the way
`--documents-only` projects a graph: an item's edges are lifted onto the
document that owns it, `contains` survives only between documents, a relation
that ends where it began is dropped, and the rest is deduplicated by kind and
ends. Where a relation was declared is ignored - moving `supersedes: ADR-0003`
from a sentence into front matter changes its `origin` and its line, and no
relation. Added and removed relations are reported by kind and ends.

**Obligations, only where a pair is certain.** Two items are the same item when
they share a declared id, or when they share their document, their section path
and their title, and no other item on either side shares all three. Nothing else
counts as a match. The section path is read below the document's own heading,
which is its title, so retitling a document does not unpair every question in
it.

- A matched pair whose openness changed is reported as a **transition** -
  resolved, narrowed or reopened - with its title.
- An item with no match is reported as having **appeared** or **disappeared**,
  under its document and section, and nothing more. A reworded question reads as
  one disappearing and one appearing, which is literally what the two exports
  say. The diff never infers that a question was resolved by comparing it with a
  different one.
- A title shared by two items in one section matches nothing, since two identical
  titles cannot be paired with certainty.

Titles in the export are summaries cut to 120 characters, so a match needs the
declared id or the whole of that summary. The export also gains one flag per item
saying whether its id was declared, because `open-questions.1` could be either.

**Findings are not compared.** A diff has no text to run rules over, and a
baseline already answers "what is wrong now that was not before". Running `check`
with `--baseline` against the base branch's recorded file is how a pull request
learns which findings it introduced.

### Output

Human by default, `--format json` for a bot, and `--format markdown` for a job
summary or a pull-request comment, with the conventions ADR-0015 set for the
check report: a verdict line first, tables that stay rectangular, no timestamps,
and byte-identical output for identical input. There is no SARIF: nothing here is
a defect with a line to annotate.

Sections come in a fixed order - documents, relations, obligations - and each is
sorted by code unit: documents by id, relations by kind and then their ends,
obligations by document, section and title. An empty diff is one line saying
there is no relational change.

**The exit code is 0 whether anything changed or not**, and 2 when an input cannot
be read or is not an export. A diff describes; `check` gates. A diff that failed
on a removed relation would fail every legitimate supersession.

## Consequences

**A fifth command, and one new pure module.** The module sits between the edges,
so the docs test that holds I/O to `glob.ts`, `runner.ts`, `config.ts` and
`cli.ts` keeps holding.

**The export changes, additively.** `generator` at the top, and a `declared` flag
on each item. A consumer that reads version 1 keeps working; one that compares
exports byte for byte across releases will see the new fields once.

**A pull request can say what it does to the decisions**, not only what is wrong
with them. That was ADR-0015's reason to defer this rather than decline it.

**ADR-0015's claim about identity is corrected**: done for documents, and for
obligations only by the matching rule above.

## Alternatives considered

**Between two git revisions.** Declined in ADR-0015, and the reason stands: git
would sit underneath a pure pipeline, and CI has both checkouts without it.

**Keying obligations on their ids.** The table above shows a false "reopened"
from inserting one line. Declared ids fix it for the repositories that write
them, and most do not.

**Matching reworded obligations by similarity.** "Eviction policy?" and "Eviction
policy for large objects?" are very likely one question. They are also a guess,
and a transition reported from a guess is exactly the finding this ADR declines.
ADR-0004's near-miss suggestions show the acceptable form: one candidate or
silence, offered as a question and never reported as a fact. That is left open
below rather than built.

**Diffing two check reports.** Findings between two states are what a baseline
is for, and a second mechanism for the same question would drift from the first.

## Open Questions

- [ ] Should `--exit-code` exit 1 when anything changed, as `git diff` does? It
      helps a script asking "did this pull request touch the decisions at all",
      and it is a flag nobody has asked for yet.
- [ ] Should an obligation that disappeared beside one that appeared, in the same
      section, be offered as "possibly reworded", in the one-candidate-or-silence
      form of ADR-0004? Only if it can be done without ever reporting a
      transition.
- [ ] Should the recipe above ship as a documented GitHub Actions snippet, or as
      a composite action? A snippet is four lines anyone can read; an action is a
      second thing to version.

## See also

- [ADR-0015](0015-feedback-goes-where-the-tools-already-look.md) - where this was
  deferred, and the markdown conventions the output follows.
- [ADR-0012](0012-a-baseline-is-a-ratchet.md) - the identity documents are keyed
  on, and the mechanism that already reports findings between two states.
- [ADR-0006](0006-false-positives-cost-more.md) - why an obligation is matched or
  left unmatched, and never guessed at.
