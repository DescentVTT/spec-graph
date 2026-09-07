# spec-graph

**Turn Markdown specifications into a verifiable relational graph.**

Your code has a compiler. Your specifications have nothing. `spec-graph` gives
them a type system: documents become nodes with a lifecycle, tasks become
obligations with real state, and citations become foreign keys that are actually
checked.

```text
✖ docs/adr/0003-event-log.md:13:65  ghost-handover
    open obligation delegates to ADR-0002, which is retired
    ↳ docs/adr/0002-single-node-storage.md:2:9  ADR-0002 is retired ("Superseded by ADR-0007")
    ↳ docs/adr/0003-event-log.md:13:1           the obligation: Which compaction policy do we use? Deferred to ADR-0002.
    → nothing will be read from ADR-0002 again - re-home this in a live document, or close it here
```

Exit code 1. The obligation was about to disappear.

---

## Why this exists

Specifications rot in ways nobody notices, because nothing checks them.

**Ghost handovers.** An active decision defers an open question to a document
that was archived three months ago. The question is now nowhere. Nobody deleted
it; it just stopped existing.

**Stale premises.** A decision closes, but the sentence explaining the *original*
constraint stays in the text. Two quarters later a new design is still working
around a 4 KB row limit that was abolished in the rewrite. The premise is
disproven and still load-bearing.

**Fragile verification.** Teams reach for `grep -r '\- \[ \]'`. It breaks on
wrapped lines, matches inside code samples, harvests `adr-0007` out of a URL, and
cannot tell an open question from one that was narrowed, satisfied, or
consciously accepted as debt.

**Broken reference graphs.** `ADR-0009` is cited forty times and has never
existed.

Every one of these is a *relational* defect. They are invisible when you read one
document and obvious when you can query all of them at once.

## Quickstart

```bash
npm install --save-dev @descent-vtt/spec-graph
npx spec-graph
```

No configuration, no annotations, no migration. It reads what your repository
already looks like:

```bash
npx spec-graph "docs/**/*.md"
```

**The package is scoped; the command is not.** After a local install the binary
is plain `spec-graph`. Without one, `npx` needs the full name:

```bash
npx @descent-vtt/spec-graph "docs/**/*.md"
```

## What it checks

| Rule | Default | What it catches |
| --- | --- | --- |
| `ghost-handover` | error | An open obligation handed to a document that can no longer absorb it |
| `stale-premise` | error | A live document resting on a decision that was retired or obviated |
| `broken-reference` | error | A citation naming a document or anchor that does not exist |
| `circular-delegation` | error | Obligations or supersessions in a cycle, so none can ever land |
| `orphaned-obligation` | error | A retired or frozen document still holding open work |
| `live-supersession` | error | A superseded document still presenting itself as current |
| `reference-outside-corpus` | warn | A citation naming a real document the include patterns did not reach |
| `ambiguous-reference` | warn | A citation matching more than one document |
| `unreciprocated-supersession` | warn | A retired document that never says what replaced it |
| `state-conflict` | warn | An item whose two state signals disagree about whether work remains |
| `self-reference` | info | A document delegating to, or depending on, itself |

Override any of them:

```bash
spec-graph --rule self-reference=off --rule state-conflict=error
```

Once a repository is clean, `--strict` raises every warning to an error so the
build stops tolerating them:

```bash
spec-graph --strict
```

```text
✖ docs/adr/0001-single-writer.md:2:9  unreciprocated-supersession (strict: warn -> error)
    ADR-0001 is retired but never says that ADR-0002 replaced it
    ↳ docs/adr/0002-multi-writer.md:3:13  only ADR-0002 records the relationship
    → add "superseded-by: ADR-0002" to docs/adr/0001-single-writer.md so a reader who lands there is redirected

2 errors · 20.73ms · 2 raised by --strict
```

Every escalated finding says so, so you can always tell what the build would do
without the flag. Two deliberate limits: strict leaves `info` rules alone, since
those are advisory by design and promoting them would reintroduce exactly the
noise the defaults avoid; and an explicit `--rule` always wins, so
`--strict --rule state-conflict=warn` turns strict on and exempts one rule
rather than making you choose between all of it and none.

## How it reads your documents

### Lifecycle, normalised

Every ecosystem invented its own status vocabulary. `spec-graph` maps all of them
onto four phases, chosen so one question can be answered from the phase alone:
**can this document still absorb new work?**

| Phase | Recognised from | Absorbs work? |
| --- | --- | --- |
| `draft` | `proposed`, `provisional`, `wip`, `in-review`, `experimental`, … | yes |
| `active` | `accepted`, `implementable`, `implemented`, `merged`, `adopted`, … | yes |
| `frozen` | `final`, `ratified`, `locked`, `published`, … | **no** |
| `retired` | `superseded`, `deprecated`, `rejected`, `withdrawn`, `archived`, … | **no** |

The status is found wherever your team writes it — front matter (`status:`,
`state:`, `stage:`), a `## Status` section, `**Accepted** (2026-03-01) ✅`, or a
`docs/adr/archive/` directory. `Accepted, later superseded by ADR-0009` is
retired: retirement is terminal, so a retirement word anywhere wins.

An unrecognised status becomes `unknown`, and rules treat it permissively. It
never guesses.

### Obligations, with real state

A checkbox is the *least* reliable thing a document says about a task:

```md
- [ ] Should the write path shard before the migration?
      **Resolved (2026-03):** no — one node holds three years of growth.
```

`grep '\- \[ \]'` re-opens a settled debate. `grep '\- \[x\]'` misses it. Both
are confidently wrong.

`spec-graph` reads every signal — a directive, a prose marker, strikethrough, the
checkbox, the enclosing section — lets the most specific one win, and **reports
the disagreement** as `state-conflict` rather than hiding it.

Obligations have seven dispositions, not two:

| Disposition | Work remains? | Written as |
| --- | --- | --- |
| `unresolved` | open | `- [ ]`, under `## Open Questions` |
| `narrowed` | partial | `- [~]`, `**Narrowed:** only the payment path` |
| `delegated` | open | `**Tracked in** …`, `deferred to …` |
| `satisfied` | closed | `- [x]`, `**Resolved:**`, `~~struck through~~` |
| `accepted-debt` | closed | `**Accepted debt:**`, `**Won't fix:**` |
| `rejected` | closed | `- [-]`, `**Rejected:**` |
| `obviated` | closed | `**Moot** — the limit was removed in v9` |

`obviated` is the one that matters most: it is the marker that turns every
load-bearing citation of that item into a stale premise.

Markers only count in the forms documents actually use — punctuated
(`Resolved:`), emphasised (`**Moot**`) or shouted (`RESOLVED`) — and never inside
code. *"We resolved to keep the queue"* does not close anything.

### References, resolved forgivingly and validated strictly

All of these reach the same document:

```md
[ADR-0007](../adr/0007-sharding.md)   [[0007-sharding]]   [ADR-7][a7]
As decided in ADR-0007, ...           see 0007 (within the same family)
```

Resolution is deliberately asymmetric, because the alternative is a tool nobody
trusts:

- **Deliberate references are validated.** A link, a front-matter field or a
  directive that does not resolve is a broken foreign key and is reported.
- **Bare identifiers in prose are opportunistic.** They are reported only when
  their family already exists in the corpus. `ADR-0099` in a repository of ADRs
  is a real dangling citation; `SHA-256` in the same repository is a sentence.
- **Bare numbers are family-scoped.** `0007` inside an RFC means `RFC-0007`,
  never `ADR-0007`. A repository with both is ordinary, and guessing would be
  worse than silence.
- **Two candidates is worse than none.** An ambiguous citation is reported, not
  bound to whichever document was indexed first.
- **Code never counts.** Links inside fences and inline spans are masked before
  anything is extracted, and link constructs are blanked before prose is scanned,
  so `[ADR-7](https://example.com/adr-7)` yields one reference rather than three.
- **Source links are not spec links.** `[rules.ts](../../src/rules.ts)` is not a
  broken reference. That is [spec-guard](#relationship-to-spec-guard)'s job.

### When `[[...]]` tags a concept

A Markdown link with a path says where the target lives. A wiki link says only
what it is called — and whether that name means a *document* is a property of
your repository, not of the link:

```md
[[0007-sharding]]   a file stem, in an Obsidian-style vault
[[trap 55]]         an entry in a catalogue that lives inside another document
```

spec-graph cannot tell them apart, so it validates by default — an unresolved
`[[...]]` in a vault is the most common broken reference there is. Where the
convention is the other one, say so once:

```bash
spec-graph --ignore-ref "trap *"
```

The tool names that flag in the hint, so it costs one run to find:

```text
> fix the identifier, or - if [[...]] tags a concept here - exclude it: --ignore-ref "trap *"
```

`--ignore-ref` suppresses *findings*, never edges. A reference that resolves is
still a relation in the graph no matter what you exclude — not even
`--ignore-ref "*"` can delete one. See
[ADR-0008](docs/adr/0008-wiki-links-carry-no-path.md).

### Relations

Relations are read from front matter, from link context, and from explicit
directives:

```yaml
---
status: accepted
supersedes: ADR-0002
depends-on: [ADR-0004, RFC-0011]
---
```

```md
The chunking scheme is constrained by [ADR-0002](0002-rows.md).  → assumes
Which policy? Deferred to [ADR-0011](0011-policy.md).            → delegates-to
Blocked by [ADR-0009](0009-compliance.md).                       → blocked-by

## See also
- [ADR-0001](0001-intro.md)                                      → relates-to
```

Two properties do the work. `loadBearing` relations (`assumes`, `depends-on`,
`blocked-by`, `amends`) make the source's validity depend on the target — those
are what turn stale. `transfersObligation` relations (`delegates-to`,
`blocked-by`) move work — those are what become ghosts. A "See also" link is
neither, and is never reported, which is what keeps the signal-to-noise ratio
high enough to leave the tool switched on.

## The query language

The two flagship rules are not hand-written traversals. They are selectors,
parsed at startup:

```text
ghost-handover   *[openness!=closed][phase!=retired] -delegates-to,blocked-by-> *[receptivity=sealed]
stale-premise    *[phase!=retired] -depends-on,assumes,amends,blocked-by-> document[phase=retired]
```

Which means anything a built-in rule can find, you can find too:

```bash
# What open work is stranded in documents nobody reads?
spec-graph query 'document[receptivity=sealed] -contains-> item[openness!=closed]'

# Which accepted decisions rest on a draft?
spec-graph query 'document[phase=active] -depends-on-> document[phase=draft]'

# What did ADR-0009 replace, transitively?
spec-graph query 'document[id=ADR-0009] =supersedes=> document'

# Where is our accepted technical debt?
spec-graph query 'item[state=accepted-debt]'
```

`query` exits non-zero when nothing matches, so a team convention becomes a build
gate without writing any code:

```yaml
- name: No PRD may depend on a draft decision
  run: |
    ! npx spec-graph query 'document[path^=docs/prd] -depends-on-> document[phase=draft]'
```

**Grammar**

```text
document[phase=active] -delegates-to-> item[openness=open]
└──────┘└────────────┘ └─────────────┘ └─────────────────┘
  node    predicate       relation            node

Node types   document · item · *
Attributes   id kind title path file line phase status receptivity alias
             document state (or disposition) openness section text body
             evidence conflicted fm.<front-matter-key>
Operators    =  !=  ^=  $=  *=  ~=   and [attr] for "is present"
Relations    -kind->   <-kind-   =kind=>   <=kind=      (= forms are transitive)
             comma-separate kinds: -assumes,depends-on->
```

Items inherit their document's lifecycle, so `item[phase=retired]` means what you
expect. A query evaluates to **paths**, not endpoints, which is why a finding can
name both ends and the line that connects them.

## Directives

Inference covers almost everything, but inference you cannot override is a trap.
Directives are ordinary HTML comments — invisible in every Markdown renderer:

```md
<!-- @spec-node id="ADR-0007" status="accepted" aliases="sharding, adr-7" -->
<!-- @spec-item id="shard-key" state="narrowed" -->
<!-- @spec-edge kind="delegates-to" to="ADR-0011#scope" -->
<!-- @spec-ignore -->
```

A directive always wins, and the report says the state came from a directive, so
an override is visible rather than mysterious.

## CLI

```text
spec-graph [check] [patterns...]     Validate the graph. The default.
spec-graph query <selector>          Run a selector, print matching paths.
spec-graph graph [patterns...]       Export for Graphviz, Mermaid or JSON.
spec-graph rules [--explain]         List the diagnostics.

--root <dir>            Directory patterns resolve against
--ignore <glob>         Skip paths (repeatable)
--ignore-ref <glob>     Do not report these reference targets (repeatable)
--format human|json     Report format
--graph-format <fmt>    dot | mermaid | json
--documents-only        Hide items; their relations lift onto their documents
--rule <id>=<severity>  error | warn | info | off (repeatable)
--strict                Raise every warning to an error
--max <n>               Show at most n findings
--max-warnings <n>      Fail when warnings exceed n
--color / --no-color    Force colour
--ascii                 ASCII glyphs only
--verbose               Include parse problems
```

Exit codes: `0` clean, `1` findings, `2` the tool could not run. A mistyped flag
never masquerades as a passing build, and a pattern matching nothing is an error
rather than a silent success.

## Continuous integration

```yaml
- name: Check the specification graph
  run: npx spec-graph "docs/**/*.md" --format json > spec-graph.json
```

The JSON report is versioned, flat, and carries start and end positions for
every finding, so a bot can annotate a diff:

```json
{
  "version": 1,
  "ok": false,
  "summary": { "documents": 7, "items": 7, "edges": 18, "openObligations": 6, "errors": 5 },
  "diagnostics": [
    {
      "rule": "ghost-handover",
      "severity": "error",
      "message": "open obligation delegates to ADR-0002, which is retired",
      "hint": "nothing will be read from ADR-0002 again - re-home this in a live document, or close it here",
      "nodes": ["ADR-0003#open-questions.1", "ADR-0002"],
      "file": "docs/adr/0003-event-log.md",
      "line": 13,
      "column": 65,
      "related": [{ "file": "docs/adr/0002-single-node-storage.md", "line": 2, "note": "ADR-0002 is retired" }]
    }
  ]
}
```

## Visualising

```bash
spec-graph graph --documents-only --graph-format mermaid > graph.mmd
spec-graph graph --graph-format dot | dot -Tsvg > graph.svg
```

Nodes are coloured by phase, so an archived document with arrows still pointing
into it is visible at a glance. Hiding items lifts their relations onto the
owning document rather than dropping them.

## Programmatic API

```ts
import { analyse, formatReport } from '@descent-vtt/spec-graph';

const result = await analyse({ root: process.cwd(), patterns: ['docs/**/*.md'] });
if (!result.ok) console.error(formatReport(result, { color: true }));
```

The filesystem is optional. Everything below the runner is a pure function of
text, so a monorepo tool or a language server can skip disk entirely:

```ts
import { analyseSources, query } from '@descent-vtt/spec-graph';

const { graph, diagnostics } = analyseSources([{ path: 'adr/0001.md', text: source }]);
const ghosts = query(graph, 'item[openness=open] -delegates-to-> document[phase=retired]');
```

The graph, the scanner, the selector engine and every vocabulary table are
exported. Reporters, editor extensions and custom rules are all first-class.

## Design

Eight ADRs, which `spec-graph` validates on every CI run:

- [ADR-0001 — A hand-written Markdown scanner](docs/adr/0001-hand-written-markdown-scanner.md)
- [ADR-0002 — A four-phase lifecycle lattice](docs/adr/0002-lifecycle-lattice.md)
- [ADR-0003 — Item state is resolved from competing signals](docs/adr/0003-item-state-signals.md)
- [ADR-0004 — Reference resolution is deliberately asymmetric](docs/adr/0004-reference-resolution.md)
- [ADR-0005 — The rules and the query language share one engine](docs/adr/0005-rules-are-queries.md)
- [ADR-0006 — False positives cost more than misses](docs/adr/0006-false-positives-cost-more.md)
- [ADR-0007 — Mutation testing, and what the score actually means](docs/adr/0007-mutation-testing.md)
- [ADR-0008 — A wiki link carries a name, not a path](docs/adr/0008-wiki-links-carry-no-path.md)

**Zero runtime dependencies.** Node 22+, native ESM, TypeScript strict with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The Markdown
scanner, the front-matter reader, the glob matcher and the query parser are all
written here, so the whole package is auditable in an afternoon.

**Verified, not just covered.** 411 tests; 94.2% statement and 96.9% line
coverage. Coverage says a line ran, so the suite is also held to a mutation
score - 74.05% over 6,150 mutants - because a vocabulary entry or a boundary
condition can be weakened by an ordinary-looking refactor without a single test
going red. [ADR-0007](docs/adr/0007-mutation-testing.md) is straight about what
that number is and is not.

**Fast enough to run on save.** A synthetic corpus of 2,000 documents — 8.9 MB,
6,000 obligations, 12,285 relations — is read, parsed, resolved and checked in
about 1.3 seconds on a laptop, roughly a third of which is file I/O. A typical
repository with a few dozen ADRs finishes in tens of milliseconds.

## Relationship to spec-guard

[`spec-guard`](https://github.com/DescentVTT/spec-guard) checks the **vertical**
dimension: whether your source code still honours what a specification claims
about it.

```md
<!-- @assert-absence target="src/services" symbol="LegacyPaymentGateway" -->
```

`spec-graph` checks the **horizontal** dimension: whether your specifications are
consistent with *each other*. They share conventions and a philosophy, compose
cleanly, and neither requires the other.

## Licence

MIT
