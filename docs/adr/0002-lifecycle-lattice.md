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

## Open Questions

- [ ] Should `frozen` and `retired` be distinguishable in the `receptivity`
      predicate rather than collapsing to `sealed`? No caller needs it yet.

## See also

- [ADR-0003](0003-item-state-signals.md) applies the same reasoning to items.
