---
status: accepted
date: 2026-09-07
---

# ADR-0009: A specification is a region of a file, not a file

## Context

Every layout spec-graph was built against keeps one specification per file.
MADR does, Kubernetes KEPs do, Rust RFCs do. So `DocumentNode` was bound to a
file, and that binding went unexamined because nothing in the corpora tested it.

Plenty of organisations do not work that way. A register, a living whitepaper or
a master architecture document holds dozens of decisions in one file, each with
its own identifier, its own status and its own dependencies. Run against a
twenty-decision register, spec-graph reported:

```text
spec-graph 1 document - 20 items - 20 relations - 20 open
```

One node, `phase=unknown`, and every obligation attributed to the file rather
than to the decision that owns it. The supersession inside it, the dependency
chain and the question handed to a superseded decision were all invisible. A
register kept as a table was worse - one node, no items, **no relations at
all**.

This is not a missing feature. It is the file binding being wrong.

## Decision

**A specification is a region of a file.** A file yields at least one region -
itself - and may yield more.

The change is small because a region produces exactly the `DocumentNode` a whole
file produced. Nothing downstream knows regions exist: no rule, no query, no
reporter, no resolution path changed, and all 463 tests that existed before this
passed through it unaltered.

Two forms of register are recognised, and **both require two independent
signals**:

**A heading** becomes a specification when it *begins* with an identifier and
the section *declares a status*. One signal is not enough in either direction.
`## Q3 2026 Roadmap` parses as family `Q`, number 3; `## v1.2.0` in a changelog
parses as family `v`, number 1. Neither declares a status. And a status alone is
every ordinary `## Status` section in every normal ADR.

**A table row** becomes a specification when the table has an identifier column
and either a status column or at least one relation column. A table of
identifiers and prose is a citation list, and promoting its rows would invent a
register nobody wrote. Relations are typed by the column header the author
wrote - `Depends on`, `Superseded by` - rather than guessed from prose, and a
finding points at the declaring cell.

Three details that keep the model honest:

- **A region does not claim the file's path.** The file already answers to it,
  and two nodes answering to one path would make every link to that file
  ambiguous.
- **Obligations are numbered within their own specification**, so two decisions
  in one register each get `#open-questions.1` rather than sharing a sequence.
- **Cells a column already typed are skipped by prose scanning**, so a link in a
  `Depends on` column yields one typed edge rather than a typed edge and a
  neutral citation beside it.

## Alternatives considered

**A new node kind for sections.** Rejected: it would have meant teaching every
rule, every selector attribute and every reporter about a third kind of node, to
express something that is already a specification in every way that matters.
The existing lifecycle applies to it unchanged.

**Synthetic child identifiers, `register.md#ADR-0001`.** Rejected because it
makes the identity of a decision depend on where it currently lives. `ADR-0001`
is the decision's name; moving it out of the register into its own file should
not break every citation of it. Regions carry the bare identifier, so a citation
resolves the same before and after the move, and a register can be split up
without a single reference changing.

**Recognising a heading on the identifier alone.** Rejected on the evidence
above. It costs nothing to require a status and it is the difference between
reading a register and reading a roadmap.

## Consequences

The twenty-decision register now reports twenty-one documents, each with its own
phase, and finds the supersession, the dependency and the ghost handover that
were invisible. The table register reports twenty-one documents and nineteen
typed relations pointing at their cells.

The cost is that a register whose sections carry no status is still one node.
That is the deliberate direction: the fix is one line per section, or one
`@spec-node` directive, and the alternative was inventing specifications out of
roadmap headings.

## Open Questions

- [ ] Should a region inherit its file's front matter? It does not today, so
      `supersedes:` at the top of a register applies to the file rather than to
      every decision in it - which is right - but it also means `fm.owner` is
      not queryable on a section.
- [ ] Definition lists and `<dl>` blocks are a third register form seen in
      older documents. Nothing has asked for them yet.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) - the lifecycle a region carries,
  unchanged from the one a file carries.
- [ADR-0006](0006-false-positives-cost-more.md) - why both forms demand two
  signals rather than one.
