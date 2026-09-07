---
status: accepted
date: 2026-09-07
---

# ADR-0010: Configuration belongs to the repository

## Context

Three ADRs left the same open question. [ADR-0005](0005-rules-are-queries.md)
wanted a home for named queries. [ADR-0008](0008-wiki-links-carry-no-path.md)
asked whether `--ignore-ref` patterns belonged in a file. And running against
enterprise repositories produced npm scripts like this:

```json
"specs": "spec-graph docs/**/*.md --ignore-ref 'trap *' --ignore-ref 'Q-*' --ignore-family RFC --rule self-reference=off --strict"
```

That is a configuration file which has not admitted what it is. Everything in it
is true of the repository rather than of the person typing the command, and none
of it is discoverable by someone reading the repository rather than its scripts.

A second problem surfaced alongside it. A repository that keeps its own `RFC-*`
documents and writes the sentence every specification writes -

> The key words MUST and SHOULD are to be interpreted as described in RFC 2119.

- gets `RFC 2119` reported as a dangling reference to a local RFC it does not
have. The corpus-family witness from [ADR-0004](0004-reference-resolution.md) is
working exactly as designed here: the family *is* in the corpus. The number
belongs to somebody else.

## Decision

**A configuration file, in JSON, read from the repository root.**

```json
{
  "patterns": ["docs/**/*.md"],
  "ignoreReferences": ["trap *"],
  "ignoreFamilies": ["RFC"],
  "severities": { "self-reference": "off" },
  "strict": true
}
```

Read from `.spec-graph.json`, then `spec-graph.config.json`, then a
`"spec-graph"` key in `package.json`. JSON, and parsed with `JSON.parse`, is not
a shortcut: a YAML or TOML reader would be the largest thing in a package that
has no runtime dependencies at all, to read a file with nine keys in it.

**A flag always wins, and list flags add rather than replace.** Configuration is
what is true of the repository; a flag is somebody overriding it for one run. A
`--ignore-ref` on the command line is one more exclusion, not a decision to
throw away the ones the repository already declared.

**Family rules**, carried by the same file and by `--family` / `--ignore-family`:

- `ignoreFamilies` names families that are never citations here. `RFC` for the
  repository above.
- `families` is the stronger statement - "these are the families this repository
  has" - and turns every other noun-number construct back into prose.

Both are consulted *only after resolution has already failed*, like every filter
since ADR-0008. `RFC 0001` still resolves to the local RFC-0001 with
`ignoreFamilies: ["RFC"]` set. No configuration can delete an edge.

**A broken configuration is reported, not fatal.** Malformed JSON, an unknown
key, a misspelled rule, a value of the wrong type: each is printed and the run
continues on defaults. A config file with a typo in it should not stop a team
seeing the findings it was about to show them. An unknown key is *reported*
rather than ignored, because a silently dropped `ignoreReference` is a
configuration that looks applied and is not.

## What this does not fix

The "greedy prefix" flood is narrower than it looks, and worth stating precisely
so the next person does not go hunting for it. Opportunistic prose identifiers
already require a family witness in the corpus before they are read as citations
at all. Measured on a corpus with an ADR family present:

| Written in prose | Reported |
| --- | --- |
| `Phase 1`, `R69`, `Q-120`, `Table 2`, `Step 4`, `ISO 8601` | no |
| `ADR 999` | yes |
| `RFC 2119`, in a repository holding `RFC-*` documents | yes |

Only the last two rows reach a report, and only the last one is a false
positive. That is what the family rules are for. The first row has been silent
since ADR-0004, and no change here was needed.

## Consequences

The npm script above becomes `spec-graph` with a file beside the ADRs that
anyone reading the repository can find. Family rules make the one genuine prose
false-positive class configurable without weakening the witness rule that keeps
the rest silent.

The cost is a second place to look when behaviour surprises someone.
`--verbose` therefore prints which file was read, and `--no-config` turns the
whole mechanism off for one run.

## Open Questions

- [ ] Should configuration be discovered upward from the working directory
      rather than read from `--root`? A monorepo with per-package specs would
      want that, and nothing has asked yet.
- [ ] Named queries from ADR-0005 still have no home. The file is now the
      obvious one, but a query needs a severity and a message to be a rule, and
      that is a larger design than this.

## See also

- [ADR-0004](0004-reference-resolution.md) - the corpus-family witness these
  rules refine rather than replace.
- [ADR-0008](0008-wiki-links-carry-no-path.md) - the same
  suppresses-findings-never-edges guarantee.
