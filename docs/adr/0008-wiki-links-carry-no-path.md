---
status: accepted
date: 2026-09-07
---

# ADR-0008: A wiki link carries a name, not a path

## Context

Run against a repository of 66 design briefs, spec-graph reported eleven broken
references. All eleven were wiki links, and none of them named a document:

```md
A brief that subordinates its own copy cannot go stale in the way [[trap 55]]
describes — it can only be out of date, which is different.
```

`trap 55` is an entry in a numbered catalogue of recurring pitfalls, kept as a
section inside one brief. It is a concept tag. So are `[[services]]`,
`[[bin]]` and `[[http_service.checks]]` in the same corpus. Of the eighteen
distinct wiki links in that repository, **zero** were document references.

The same syntax in an Obsidian, Foam or Dendron vault means the opposite:
`[[My Note]]` is a link to `My Note.md`, and one that stops resolving is a
genuine break that a graph tool exists to catch.

The link itself does not distinguish the two. Compare:

| Written | States |
| --- | --- |
| `[ADR-7](../adr/0007.md)` | a location - unambiguously a file |
| `[[0007-sharding]]` | a name that happens to be a file stem |
| `[[trap 55]]` | a name |

A Markdown link with a path asserts where the target lives. A wiki link asserts
only what it is called. **Whether a name means a document is a property of the
repository, not of the link**, and spec-graph cannot read it off the syntax.

## Decision

Keep the strict default and let a repository declare the exception, with the
tool naming the flag in the hint.

`--ignore-ref <glob>` (repeatable; `ignoreReferences` in the API) takes patterns
matched against reference *targets*:

```bash
spec-graph --ignore-ref "trap *"
```

Three properties make this safe:

**It suppresses findings, never edges.** The filter is consulted only after
resolution has already failed. A reference that resolves is still an edge, so
no configuration can silently delete a relation from the graph - not even
`--ignore-ref "*"`.

**The hint names the flag, and generalises the family.** An unresolved wiki link
reports:

```text
> fix the identifier, or - if [[...]] tags a concept here - exclude it: --ignore-ref "trap *"
```

`trap *`, not `trap 55`: these tags come in numbered series, and excluding them
one at a time is not a fix anybody would accept. Discovery costs one run.

**Targets are matched case-insensitively on every platform.** Path matching
follows the host filesystem, which is right for paths; a repository's findings
must not depend on which machine ran the check.

## Alternatives considered

**Treat every unresolved wiki link as a concept.** Silences the noise and
destroys the feature for vault-style repositories, where an unresolved
`[[...]]` is the single most common broken reference there is. Rejected: ADR-0006
says false positives cost more than misses, but this is not a marginal miss - it
is the whole check.

**Decide per corpus: if no wiki link resolves anywhere, treat them all as
concepts.** Tempting, and it would have needed no configuration at all. Rejected
because it has a cliff. Adding one resolving link would turn on hundreds of
findings at once, and a finding whose presence depends on an aggregate is one
nobody can predict from the line in front of them. ADR-0006 asks for inferences
that can be justified; a corpus-statistical guess cannot be justified at the
level of the single finding it produces.

**A lower severity for unresolved wiki links.** The pattern already used for
`reference-outside-corpus`, and it would have worked. Rejected because it is the
wrong shape of answer: a warning is still a false positive, only quieter, and it
would leave vault users unable to fail a build on a genuinely broken link
without also failing on every concept tag.

## Consequences

The 66-brief corpus goes from thirteen errors to none with one flag, and the
flag is the one the tool printed. Vault repositories are unaffected: their
wiki links resolve, and the ones that do not are still errors.

The cost is a denylist that a repository has to maintain. That is acceptable
here because the list is short - one pattern covered every concept tag in the
corpus that motivated this - and because the alternative was a guess.

`--ignore-ref` is deliberately not limited to wiki links. A pattern matches any
unresolved target, so the same flag handles a legacy identifier scheme or a
citation style the resolver does not understand, without a second option.

## Open Questions

- [x] Should these patterns live in a config file rather than a flag?
      **Resolved (2026-09-07):** yes - see
      [ADR-0010](0010-configuration-belongs-to-the-repository.md).
      `ignoreReferences` in `.spec-graph.json`, with the flag still available
      and still winning.
- [x] Should a suppressed reference still appear somewhere, so a repository can
      audit what it has silenced? **Resolved (2026-09-12):** yes, and
      `--verbose` was the right home. The human report groups by target - a
      concept tag used forty times is one decision - and names the setting that
      did it, `ignoreReferences` or `ignoreFamilies`. The JSON report carries
      every site unconditionally, because a machine reader that has to ask for
      something twice will not ask.

      What is *not* logged is the line that matters most: a bare identifier
      spec-graph read as prose on its own, by the asymmetry in
      [ADR-0004](0004-reference-resolution.md). `T-1000` was never suppressed by
      anybody - crediting a configuration setting with silence the tool produced
      itself would bury the handful of entries a team can actually act on.

## See also

- [ADR-0004](0004-reference-resolution.md) - the asymmetry this extends: a
  deliberate reference is validated, an opportunistic one is not.
- [ADR-0006](0006-false-positives-cost-more.md) - why the default stays strict
  and the escape hatch is one flag away rather than automatic.
