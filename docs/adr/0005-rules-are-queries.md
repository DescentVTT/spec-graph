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

Two guards keep a pathological query from becoming a denial of service: matches
are capped, and reflexive edges are excluded from traversal by default - a
document that links to itself is a formatting quirk, not a relationship.

## Open Questions

- [ ] Should selectors support disjunction (`a, b` at the top level)? Every rule
      so far is expressible as a union of separate queries, which is clearer.
- [ ] Should users be able to register a named query as a project rule with its
      own severity? This is the natural next step and wants a config file first.

## See also

- [ADR-0002](0002-lifecycle-lattice.md) defines the `phase` and `receptivity`
  attributes the selectors above rely on.
- [ADR-0003](0003-item-state-signals.md) defines `openness` and `state`.
