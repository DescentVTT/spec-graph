---
status: accepted
---

# ADR-0004: Export format

## Decision

Exports are newline-delimited JSON, chunked to stay under the row limit
imposed by [ADR-0002](0002-single-node-storage.md).

## See also

- [ADR-0001](0001-record-decisions.md)
