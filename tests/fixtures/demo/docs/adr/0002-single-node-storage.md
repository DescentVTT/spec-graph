---
status: Superseded by ADR-0007
---

# ADR-0002: Single-node storage

## Decision

One Postgres instance holds everything. Rows are capped at 4 KB.

## Open Questions

- [ ] Who owns the nightly vacuum window?
- [ ] Do we need a read replica before the 4 KB cap becomes a problem?
