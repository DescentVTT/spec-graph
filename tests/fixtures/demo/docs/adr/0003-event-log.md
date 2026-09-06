---
status: accepted
---

# ADR-0003: Append-only event log

## Decision

All writes go through an append-only log.

## Open Questions

- [ ] Which compaction policy do we use? Deferred to [ADR-0002](0002-single-node-storage.md).
- [x] Do we fsync per batch? Yes, per batch.
- [~] Should the log be shardable? Narrowed: shardable by tenant only.
