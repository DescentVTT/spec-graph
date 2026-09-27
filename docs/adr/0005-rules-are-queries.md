---
status: accepted
date: 2026-09-07
---

# ADR-0005: The rules and the query language share one engine

## Context

A fixed set of built-in rules is a ceiling. The first time a team has a
convention spec-graph did not anticipate - "no PRD may depend on a draft ADR",
"every accepted decision must be referenced by at least one runbook" - they need
a plugin API, and a plugin API for a linter is a second product.

Meanwhile the rules themselves need to traverse the graph, and writing that
traversal by hand once per rule produces eight subtly different implementations
of the same walk.

## Decision

Build one execution engine over a path-selector language, and write the rules
that can be written as selectors *as* selectors:

```text
ghost-handover  *[openness!=closed][phase!=retired] -delegates-to,blocked-by-> *[receptivity=sealed]
stale-premise   *[phase!=retired] -depends-on,assumes,amends,blocked-by-> document[phase=retired]
```

Those are not documentation of the rules. They are the rules, parsed at module
load in `src/rules.ts`. If the language cannot express them, the language is not
good enough to ship.

A query evaluates to **paths**, not endpoints. A rule holding the whole path can
say "ADR-0004 line 31 delegates this to ADR-0002, which was retired in March"
instead of naming two documents and leaving the reader to reconstruct why.

Items inherit their document's lifecycle attributes, so `item[phase=retired]`
means what a reader expects.

## Consequences

Anything a built-in rule can find, a user can find from the command line, and
`spec-graph query` exits non-zero on no matches so a team convention can gate a
build without writing any code.

Not every rule fits. Dangling references never became edges, and a cycle is not a
fixed-length path. Those are implemented directly and
[the module docstring says so](../../src/rules.ts) rather than pretending
otherwise.

*Amended 2026-09-27.* The cycle search is not run over every relation. When a
superseded document hands an open question to a document that superseded it,
the hand-off is left out: the newer decision supersedes the older, the older
defers its question to the newer, and projected onto documents the two
relations were a "delegation cycle" in which nothing is ever passed back. It is
the hand-off supersession exists for, and reporting it was a false alarm
([ADR-0006](0006-false-positives-cost-more.md)). Two documents passing a
question back and forth are still a cycle, with or without a supersession
elsewhere, and so is a question a superseded document hands to anything but
its successor.

Two guards keep a pathological query from becoming a denial of service: matches
are capped, and reflexive edges are excluded from traversal by default - a
document that links to itself is a formatting quirk, not a relationship.

## Open Questions

- [x] Should selectors support disjunction (`a, b` at the top level)?
      **Resolved (2026-09-12):** no - the union goes one level up. A project
      rule takes a list of complete selectors and reads it as a union
      ([ADR-0016](0016-a-query-needs-a-sentence.md)). Disjunction inside the
      grammar would have to interact with predicates, with steps and with the
      transitive forms; a list of whole selectors interacts with nothing.
- [x] Should users be able to register a named query as a project rule with its
      own severity? **Resolved (2026-09-12):** yes, shipped. The sentence this
      question was waiting for is
      [ADR-0016](0016-a-query-needs-a-sentence.md): a message, a hint, a
      severity, and a `project:` namespace that lets every existing surface
      carry a user-defined rule without being taught what one is.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) defines the `phase` and `receptivity`
  attributes the selectors above rely on.
- [ADR-0003](0003-item-state-signals.md) defines `openness` and `state`.
- [ADR-0016](0016-a-query-needs-a-sentence.md) is what makes the claim above
  true outside a command prompt.
- [ADR-0017](0017-a-predicate-must-finish.md) is what the shared engine costs
  and why the bill was paid rather than split: banning `~=` from rules and
  keeping it for queries would have been two languages wearing one grammar.
