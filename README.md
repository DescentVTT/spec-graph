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

The terms the spec-* tools share are defined in the family
[glossary](https://github.com/DescentVTT/spec-core/blob/main/docs/concepts.md),
and the [tutorial](https://github.com/DescentVTT/spec-core/blob/main/docs/tutorial.md)
takes one small repository through a round of work, from the brief to the
archive, in ten steps.

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
npx --no-install @descent-vtt/spec-graph
```

No configuration, no annotations, no migration. It reads what your repository
already looks like:

```bash
npx --no-install @descent-vtt/spec-graph "docs/**/*.md"
```

## Names

The package is `@descent-vtt/spec-graph`, and the command it installs is
`spec-graph`. The name without the scope is not this project: on npm,
`spec-graph` belonged to nobody on 2026-10-07, and whoever registers it decides
what it runs.

`npx` fetches and runs the package of whatever name it is given when the
project has none installed - a fresh clone, a worktree before `npm ci`, a CI job
without the install step - and without a terminal it does not ask first. So
give `npx` the full name:

- `npx --no-install @descent-vtt/spec-graph` in a project that installed it: it
  runs that install, the version the lockfile pins, and where there is none it
  stops with an error that names this package.
- `npx @descent-vtt/spec-graph`, without `--no-install`, where nothing is
  installed: it fetches this package and runs it.

<!-- bare-name: the two forms in the next sentence are shown as what not to write -->
Never `npx spec-graph`, and not `npx --no-install spec-graph` either:
`--no-install` stops a download, and npm still runs a copy of the bare name's
package that an earlier fetch left in its cache. The family's
[adopting guide](https://github.com/DescentVTT/spec-core/blob/main/docs/adopting.md#names)
has what was measured, under npm 10, 11 and 12.

Where this page writes the command alone, as in `spec-graph query ...`, it is
what a `package.json` script holds - npm fetches nothing for a script - and what
follows `npx --no-install @descent-vtt/` at a prompt.

## What it checks

| Rule | Default | What it catches |
| --- | --- | --- |
| `ghost-handover` | error | An open obligation handed to a document that can no longer absorb it |
| `stale-premise` | error | A live document resting on a decision that was retired or obviated |
| `broken-reference` | error | A citation naming a document or anchor that does not exist |
| `circular-delegation` | error | Obligations in a cycle, so none can ever land, or supersessions in a cycle - not a loop that takes one of each to close, such as a superseded document handing its question to what replaced it |
| `orphaned-obligation` | error | A retired or frozen document still holding open work - not a question it delegated to a document still taking work |
| `live-supersession` | error | A superseded document still presenting itself as current |
| `reference-outside-corpus` | warn | A citation naming a real document the include patterns did not reach |
| `ambiguous-reference` | warn | A citation matching more than one document |
| `unreciprocated-supersession` | warn | A retired document that never says what replaced it |
| `state-conflict` | warn | An item whose two state signals disagree about whether work remains |
| `unknown-relation-key` | warn | A front-matter key one edit from a relation, carrying what looks like a citation |
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
without the flag. Two deliberate limits:

- Strict leaves `info` rules alone. Those are advisory by design, and promoting
  them would reintroduce exactly the noise the defaults avoid.
- An explicit `--rule` always wins, so `--strict --rule state-conflict=warn`
  turns strict on and exempts one rule rather than making you choose between
  all of it and none.

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
| `retired` | `superseded`, `deprecated`, `rejected`, `withdrawn`, … | **no** |

The status is found wherever your team writes it, and however it is dressed
(`**Accepted** (2026-03-01) ✅`). A document may be written in any language; its
status is read in English (`status: superseded`):

- front matter: `status:`, `state:`, `stage:`
- a `## Status` section
- a `| Status | Accepted |` table at the top
- a `docs/adr/archive/` directory

`Accepted, later superseded by ADR-0009` is retired: retirement is terminal, so
a retirement word anywhere wins.

Front matter is read as YAML reads it, and a value YAML would not read -
`status: Superseded by ADR-9: see notes`, where a plain value cannot hold `: ` -
is left out rather than guessed at. Every run says how many statuses, ids and
relations it left out that way, and `--verbose` says where and why: quote the
value and it is read.

<details>
<summary>Every status word, and where a status is looked for</summary>

A word counts whole and in any case, once emphasis, links, HTML, emoji and dates
are stripped, so `Unapproved` is not `approved`. A hyphenated word matches
spaced, or joined by an underscore, as well: `signed-off` reads `Signed off` and
`signed_off`. A status holding words from two rows takes the higher row, except
that `provisionally accepted` is a draft.

| Phase | Status words |
| --- | --- |
| `retired` | `superseded`, `superceded`, `supersedes-by`, `replaced`, `replaced-by`, `deprecated`, `obsolete`, `obsoleted`, `retired`, `rejected`, `declined`, `withdrawn`, `abandoned`, `cancelled`, `canceled`, `dropped`, `revoked`, `reverted`, `moved`, `historical`, `defunct`, `inactive`, `dead`, `void`, `closed`, `postponed`, `deferred`, `not-planned`, `not_planned`, `wontfix` |
| `record` | `archived`, `archive` |
| `frozen` | `final`, `finalised`, `finalized`, `frozen`, `locked`, `ratified`, `immutable`, `sealed`, `standard`, `published` |
| `active` | `accepted`, `active`, `approved`, `adopted`, `agreed`, `implementable`, `implemented`, `implementing`, `current`, `effective`, `in-effect`, `enforced`, `stable`, `merged`, `released`, `shipped`, `live`, `done`, `complete`, `completed`, `signed-off`, `committed` |
| `draft` | `draft`, `drafting`, `proposed`, `proposal`, `provisional`, `provisionally-accepted`, `prospective`, `wip`, `work-in-progress`, `in-progress`, `in_progress`, `review`, `in-review`, `under-review`, `reviewing`, `discussion`, `discussing`, `pending`, `idea`, `exploratory`, `candidate`, `open`, `new`, `unreviewed`, `rfc`, `experimental`, `alpha`, `beta`, `incubating` |

| Where | Read from |
| --- | --- |
| Front matter, the first key present | `status`, `state`, `stage`, `lifecycle`, `phase`, `adr-status` |
| A section, under the heading, with or without a colon | `Status`, `State`, `Stage`, `Lifecycle`, `Current status` |
| A two-column table above the first `##`, in the cell right of the first key in the left column, the header row included | `Status`, `State` |
| A directory, for a document that declares no status | `archive`, `archived`, `attic`, `deprecated`, `graveyard`, `historical`, `obsolete`, `rejected`, `retired`, `superseded`, `superceded`, `withdrawn` |

The table is where many teams put a document's fields, `| Status | Accepted |`:

- It is read where a `## Status` section is, after one: a document with both is
  read from the section, and front matter still wins over either.
- A key is compared whole, in any case, emphasis stripped.
- A table with more columns, one under a heading below the title, and one
  spec-graph reads as a register are never read for the document's status: a
  legend or a register describes other things.

</details>

`archived` is none of the four. It is what spec-brief writes on a round of work
it has closed, and every spec-* tool reads it as a **record**:

- depending on it is normal;
- its unticked boxes are not anyone's work;
- its links are still checked;
- new work handed to it is still a ghost handover.

See [Journals, changelogs and minutes](#journals-changelogs-and-minutes). Unlike
a journal, it still answers for what it claims: a supersession it declares, a
cycle it closes and a link to itself are reported as they would be anywhere.

To retire a decision, say `superseded` or `deprecated` -
`archived, superseded by ADR-0009` is retired - and a document under an
`archive/` directory that says nothing about itself is still retired.

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

<details>
<summary>Every checkbox, marker and <code>state=</code> word</summary>

| Disposition | Checkboxes | Markers | `state=` |
| --- | --- | --- | --- |
| `unresolved` | `[ ]` `[?]` `[!]` `[*]` | `unresolved`, `still open`, `open question`, `tbd`, `undecided`, `reopened` | `open`, `unresolved`, `todo` |
| `narrowed` | `[~]` `[/]` | `partially resolved`, `partially answered`, `partially done`, `partly resolved`, `narrowed`, `narrowed to`, `scoped down`, `reduced scope`, `reduced to`, `partial`, `in progress`, `in_progress`, `remaining`, `split` | `narrowed`, `partial` |
| `delegated` | | `delegated`, `delegated to`, `moved to`, `tracked in`, `tracked by`, `handed off`, `handed off to`, `handed to`, `deferred to`, `follow up in`, `follow-up in`, `followup in`, `continued in`, `owned by` | `delegated` |
| `satisfied` | `[x]` `[X]` `[+]` | `resolved`, `answered`, `decided`, `settled`, `done`, `complete`, `completed`, `closed`, `fixed`, `shipped`, `addressed`, `implemented`, `solved`, `confirmed` | `satisfied`, `resolved`, `done`, `closed` |
| `accepted-debt` | | `accepted debt`, `accepted as debt`, `accepted risk`, `known limitation`, `known issue`, `known gap`, `technical debt`, `tech debt`, `wontfix`, `won't fix`, `won’t fix`, `will not fix`, `by design`, `tolerated`, `living with it` | `accepted-debt`, `debt`, `wontfix` |
| `rejected` | `[-]` | `rejected`, `declined`, `dropped`, `not doing`, `will not do`, `abandoned`, `cancelled`, `canceled`, `withdrawn` | `rejected`, `declined` |
| `obviated` | | `no longer applicable`, `no longer relevant`, `no longer needed`, `overtaken by events`, `premise invalid`, `obviated`, `obsolete`, `not applicable`, `moot`, `void`, `n/a`, `obe` | `obviated`, `moot` |

Where a marker counts, and how it may be written:

- A marker counts where a statement starts: at the start of the item or of a
  line, after the end of a sentence, or after `(` or `[`.
- Punctuated means followed by `:`, `：`, `-`, `–`, `—` or `.`, so `Done.`
  closes an item; emphasised means the emphasis closes on the marker, so
  `**Closed beta**` does not.
- A marker of more than one word may be spaced, hyphenated or joined by an
  underscore, whichever the table has: `**Tech-debt:**` and `TECH_DEBT:` are
  `tech debt`. An apostrophe may be straight or curly.

</details>

Without a box, a bullet is an obligation only at the top level of a section
whose heading names open work, however the heading is cased, spaced, emphasised
or punctuated - `## ❓ **Open questions:**` is one. The section ends at the next
heading of its level. Every other bullet is the document's own prose.

**Headings that hold obligations:** `Open Questions`, `Open Question`,
`Unresolved Questions`, `Unanswered Questions`, `Questions`, `Open Issues`,
`Action Items`, `Actions`, `TODO`, `To Do`, `To-Do`, `TODOs`, `Next Steps`,
`Follow Ups`, `Follow-Ups`, `Followups`, `Follow Up`, `Follow-Up`,
`Unresolved`, `Outstanding`, `Outstanding Questions`, `Tasks`, `Task List`,
`Work Items`, `Remaining Work`, `Decisions Needed`, `Blockers`, `Parking Lot`,
`Future Work`, `Deferred`.

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
  - A one-letter prefix is never a family - `Q3`, `x86`, `p99` - and nor are
    the prefixes of versions, pages, protocols and platforms, even in a
    repository that has a family of that name.
  - **Never a citation:** `ver 3`, `version 4`, `pp.12`, `Fig.3`, `Figure 4`,
    `Table 2`, `tbl 1`, `section 4`, `sect 2`, `sec 5`, `step 2`, `item 3`,
    `No.5`, `num 7`, `line 42`, `ln 12`, `col 3`, `port 8080`, `PR 45`,
    `issue 42`, `GH-123`, `UTF-8`, `ASCII 7`, `SHA-256`, `MD5`, `HTTP 2`,
    `HTTPS 2`, `IPv6`, `IPv4 32`, `IPv6 128`, `TLS 1.3`, `SSL 3`, `ES2015`,
    `ECMA-262`, `p99 250`, `base64`, `SQL-92`, `ARM64`, `x86-64`, `Win32`,
    `Node 22`, `Python 3`, `Java 21`, `Go 1.22`, `cpp20`.
- **Bare numbers are family-scoped.** `0007` inside an RFC means `RFC-0007`,
  never `ADR-0007`. A repository with both is ordinary, and guessing would be
  worse than silence. A document's family is the prefix of its identifier, or
  else the nearest directory that names one: `adr/`, `adrs/`, `decisions/`,
  `decision-records/` and `architecture-decisions/` hold ADRs; `rfc/` and
  `rfcs/` RFCs; `kep/`, `keps/` and `enhancements/` KEPs; and `proposal(s)/`,
  `design(s)/`, `prd(s)/` and `spec(s)/` a family each.
- **Two candidates is worse than none.** An ambiguous citation is reported, not
  bound to whichever document was indexed first.
- **Code never counts.** Links inside fences and inline spans are masked before
  anything is extracted, and link constructs are blanked before prose is scanned,
  so `[ADR-7](https://example.com/adr-7)` yields one reference rather than three.
- **Source links are not spec links.** `[rules.ts](../../src/rules.ts)` is not a
  broken reference. That is [spec-guard](#relationship-to-spec-guard)'s job.
  Nor is a link to:
  - any other file that is not a document: an image, a dotfile such as
    `../.nvmrc`, or a drawing such as `arch.excalidraw`, however long its
    extension. A dot followed by a digit, as in `ADR-0007.1`, is part of an
    identifier and is still resolved.
  - a directory, `../guides/` or `../guides` alike - without the slash the disk
    says which it is, and a name with no slash at all, `guides`, is an
    identifier.

A document is named by an explicit `id:` (or `adr:`, `adr-id:`, `rfc:`,
`rfc-id:`, `kep-number:`, `number:` or `slug:`), then by its file name, then by
its H1, and the H1 is read as a name only when neither of the others gave one.
A row of a register is named by its ID column instead: see
[Registers](#registers-many-specifications-in-one-file).

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
[ADR-0008](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0008-wiki-links-carry-no-path.md).

### A gap that is deliberate

Real filing histories have holes: an ADR number reserved and then withdrawn, a
document that was folded into another before it was ever committed. Something
still cites it, and the citation is not a mistake.

There are two mechanisms and the difference is what you are declaring.

**The target is never going to exist** — `ADR-0006` was withdrawn before filing.
That is a fact about the repository, so declare it once in
`.spec-graph.json`:

```json
{ "ignoreReferences": ["ADR-0006"] }
```

Every citation of it stays quiet, wherever it is written, forever. A glob is
available and rarely what you want here: `ADR-0006` names one target exactly.

**This particular citation is accepted for now** — it should resolve, one day it
will, and until then the build should not stop. That is debt, not a fact, and it
belongs in the baseline, keyed to the one document and the one target:

```json
{ "rule": "broken-reference", "document": "ADR-0004", "subject": "docs/plans/x.md", "count": 1 }
```

The same citation from a different document is still reported, and `--ratchet`
makes the entry disappear the day it is paid. Reach for the first when the
absence is permanent, the second when it is temporary — and if you cannot say
which, it is the second.

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

A front-matter key is read however it is punctuated or cased - `depends-on`,
`depends_on` and `dependsOn` are one key - and every relation is spelled in
both directions, so a repository writes whichever half its filing convention
keeps ([ADR-0014](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0014-a-relation-is-spelled-both-ways.md)).
Written in ADR-0001, `key: ADR-0002` means:

| Relation | ADR-0001 → ADR-0002 | ADR-0002 → ADR-0001 |
| --- | --- | --- |
| `supersedes` | `supersedes`, `supercedes`, `replaces`, `obsoletes`, `deprecates` | `superseded-by`, `superceded-by`, `replaced-by`, `obsoleted-by`, `deprecated-by`, `rolled-into` |
| `amends` | `amends`, `extends`, `refines`, `clarifies`, `revises` | `amended-by`, `extended-by`, `refined-by`, `clarified-by`, `revised-by` |
| `depends-on` | `depends-on`, `dependent-on`, `dependencies`, `requires`, `builds-on`, `relies-on` | `depended-on-by`, `required-by`, `dependents` |
| `assumes` | `assumes` | `assumed-by` |
| `blocked-by` | `blocked-by`, `blocked-on`, `waiting-on`, `waiting-for`, `gated-on`, `gated-by` | `blocks` |
| `delegates-to` | `delegates-to`, `delegated-to`, `deferred-to`, `tracked-in`, `tracked-by`, `continued-in` | `delegated-from` |
| `relates-to` | `related`, `relates-to`, `related-to`, `see-also` | |
| `references` | `references`, `reference`, `refs` | `referenced-by` |

```md
The chunking scheme is constrained by [ADR-0002](0002-rows.md).  → assumes
Which policy? Deferred to [ADR-0011](0011-policy.md).            → delegates-to
Blocked by [ADR-0009](0009-compliance.md).                       → blocked-by

## See also
- [ADR-0001](0001-intro.md)                                      → relates-to
```

A phrase governs a reference when it stands no more than 40 characters before
it, in the same statement: a sentence, a paragraph, a list item or a table cell.

- A negation between the two - `owned by nobody` - cancels it.
- A sentence written in Chinese ends at `。`, `？`, `！` or `；`, with a space
  after it or none, so `Deferred to later。另見 ADR-0002` hands nothing to
  ADR-0002. A stop only ends a statement sooner: it reads less, never more.
- Prose reads both directions too: `supersedes` and `superseded by`, `amends`
  and `amended by`, `blocked by` and `blocks` or `blocking`, `depends on` and
  `depended on by` - the second of each pair points back at the document that
  wrote it.
- A phrase that follows the reference makes the reference its subject -
  `[ADR-0009](0009.md) supersedes this` - except a `depends-on` or `assumes`
  phrase: `[ADR-0002](0002.md) requires a migration` says nothing about this
  document.

A link under a heading that files it as bookkeeping is `relates-to` unless a
phrase beside it says more. **Bookkeeping headings:** `See also`, `References`,
`Reference`, `Related`, `Related work`, `Related decisions`,
`Related documents`, `Links`, `Further reading`, `Prior art`, `History`,
`Changelog`, `Change log`, `Revision history`, `Bibliography`, `Sources`,
`Appendix`, `More information`, `Resources`, `Index`.

Two properties do the work:

- `loadBearing` relations (`assumes`, `depends-on`, `blocked-by`, `amends`) make
  the source's validity depend on the target — those are what turn stale.
- `transfersObligation` relations (`delegates-to`, `blocked-by`) move work —
  those are what become ghosts.

A "See also" link is neither, and is never reported, which is what keeps the
signal-to-noise ratio high enough to leave the tool switched on.

### Registers: many specifications in one file

One file per decision is the MADR, KEP and RFC layout, and it is what most
repositories do. Plenty keep a register instead — one document holding dozens of
decisions. **A specification is a region of a file, not a file**, so both work:

```md
## ADR-0007: Shard the write path

**Status:** Superseded by ADR-0012

Shard by tenant id.
```

Each section with an identifier *and* a status - a `**Status:**` line or a
`### Status` section under its heading - becomes a
specification in its own right, with its own lifecycle, its own obligations and
its own relations — resolvable from anywhere in the corpus as `ADR-0007`,
whether it lives in a register or in its own file. Moving it out later breaks
no citation.

A register kept as a table works the same way, with relations typed by the column
header you wrote:

```md
| ID       | Title          | Status     | Depends on | Superseded by |
| :------- | :------------- | :--------- | :--------- | :------------ |
| ADR-0001 | Use one writer | Superseded | -          | ADR-0003      |
| ADR-0002 | Cache eviction | Accepted   | ADR-0001   | -             |
```

Findings point at the declaring cell, not at the file. A cell that is empty or
holds only a placeholder — `-`, `—`, `n/a`, `none`, `nil`, `TBD` — says nothing.
A status cell is read as a status line under a heading is, so
`Superseded by ADR-0003` there names the row's successor.

A row is named by its ID column, and a title is only a title:

- A row whose ID cell names nothing — empty, a placeholder, or a `?` nobody has
  numbered yet — is not a specification.
- An identifier a title opens with belongs to the document the row is *about* —
  an issue reading `| OI-V-05 | ADR-040's enforcement point has no browser test |`
  is filed under `OI-V-05`, and citations of `ADR-040` still reach `ADR-040`.

The same holds for a whole file, whose H1 is a name only when nothing else gave
one: see [References](#references-resolved-forgivingly-and-validated-strictly).

The register itself stays in the graph as the thing that holds them, so
`spec-graph query 'document[id=register] -contains-> document'` lists what is
inside it.

Both forms need **two** signals, and that is deliberate: `## Q3 2026 Roadmap`
parses as family `Q`, number 3, and `## v1.2.0` in a changelog parses as family
`v`, number 1. Neither declares a status, so neither is a specification. A table
of identifiers and prose is a citation list, not a register. See
[ADR-0009](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0009-a-specification-is-a-region.md).

## Directives

Inference covers almost everything, but inference you cannot override is a trap.
Directives are ordinary HTML comments — invisible in every Markdown renderer:

```md
<!-- @spec-node id="ADR-0007" status="accepted" aliases="sharding, adr-7" -->
<!-- @spec-item id="shard-key" state="narrowed" -->
<!-- @spec-edge kind="delegates-to" to="ADR-0011#scope" -->
<!-- @spec-ignore -->
<!-- @spec-history -->
```

Each takes these attributes. Any other is a parse problem, listed by
`--verbose`, and the directive still applies:

| directive | attributes |
| --- | --- |
| `@spec-node` | `id`, `status`, `title`, `aliases`, `kind` |
| `@spec-item` | `id`, `state`, `title`, `owner`, `note` |
| `@spec-edge` | `kind`, `to`, `from`, `reason` |
| `@spec-ignore` | `reason` |
| `@spec-history` | none |

- `reason`, `note`, `owner` and a node's `kind` are for whoever reads the
  source; spec-graph reads nothing from them.
- An edge's `kind` is one of the relations a selector steps along. Any other
  word is a parse problem too, and the edge is read as `references`.
- `aliases` splits at commas, semicolons and spaces.
- A value is quoted with either quote mark, or bare when it holds no space or
  quote, and an attribute with no value is a flag.
- A directive is the first thing in its comment, so a comment that only
  mentions one is a comment.

A directive always wins, and the report says the state came from a directive, so
an override is visible rather than mysterious.

A `@spec-item` annotates one item: the one directly below it, with nothing but
blank lines or other comments between, or else the one it is written on or
indented under. An id that two items end up with is a parse problem, listed by
`--verbose`, and the first item keeps it.

## Journals, changelogs and minutes

A 2024 journal noting *"decision deferred to ADR-002"* is not delegating
anything. It is reporting that somebody once did. When ADR-002 retires in 2026,
the note does not become a defect — there is nothing in it for anyone to fix.

Declare those files and spec-graph stops holding them to a lifecycle they never
had:

```json
{ "historyPatterns": ["**/JOURNAL_*.md", "archive/**"] }
```

or, for one file, `<!-- @spec-history -->` at the top of it. A brief whose
status is `archived` is a record already, with nothing declared, though not a
log: the supersessions, cycles and self-references it declares are still
checked.

|  |  |
| --- | --- |
| its links resolve | **still checked** — a broken link is broken whoever wrote it |
| its checkboxes | not obligations, and not in the headline count |
| its delegations | reports of what was said |
| work handed **into** it | **still checked** — a log will never act on it |

That last row is the point. Excluding the file with `--ignore` would have
silenced the whole lot, including the links, and a journal full of 404s is
exactly what this tool is for. See
[ADR-0011](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0011-a-record-is-not-a-specification.md).

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
    ! npx --no-install @descent-vtt/spec-graph query 'document[path^=docs/prd] -depends-on-> document[phase=draft]'
```

That shell line is a rule wearing a disguise. Give it a name and a sentence and
it becomes one — see [your own rules](#your-own-rules) below.

**Grammar**

```text
document[phase=active] -delegates-to-> item[openness=open]
└──────┘└────────────┘ └─────────────┘ └─────────────────┘
  node    predicate       relation            node

Node types   document · item · *        (also documents docs doc items nodes node any)
Attributes   id kind title path file line phase status receptivity alias
             document state (or disposition) openness section text body
             evidence conflicted fm.<front-matter-key>
Operators    =  !=  ^=  $=  *=  ~=   and [attr] for "is present"
Relations    -kind->   <-kind-   =kind=>   <=kind=      (= forms are transitive)
             comma-separate kinds: -assumes,depends-on->
```

Items inherit their document's lifecycle - `phase`, `receptivity`, `status` - and
answer to its `path` and its `alias` spellings, so `item[phase=retired]` means
what you expect. A query evaluates to **paths**, not endpoints, which is why a
finding can name both ends and the line that connects them, and `query` prints
each one the way the selector reads, every document a transitive step passed
through included.

`~=` is a regular expression matched by an automaton that cannot backtrack, so a
predicate is linear in the subject whatever the pattern — `^([A-Za-z0-9_]+[ ]?)+$`
against a fifty-four-character title takes `RegExp` 103 seconds and this 13
microseconds. It reads the usual syntax minus backreferences and lookaround,
which are not regular; both are refused when the selector is read, with the
character pointed at. The automaton is spec-core's, the library the spec-* tools
share, copied into this package rather than installed, and so is the one
[globs](#patterns) are matched by. See
[ADR-0017](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0017-a-predicate-must-finish.md).

On a register, a region answers its file's front matter for every descriptive
key — `fm.owner` on a decision inside a register is the register's owner — while
the keys a region owns itself, its identifier and status and title, and any key
that declares a relation, stay on the file. See
[ADR-0009](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0009-a-specification-is-a-region.md).

## Your own rules

A convention spec-graph never anticipated is a selector plus a sentence. Write
both in the config file and it becomes a rule like any other:

```json
{
  "rules": {
    "no-draft-dependency": {
      "query": "document[phase=active] -depends-on-> document[phase=draft]",
      "message": "{0} depends on {1}, which is still a draft",
      "hint": "wait for {1} to be accepted, or drop it from {0.path}",
      "severity": "error"
    }
  }
}
```

```text
x docs/adr/0002-delivery.md:4:13  project:no-draft-dependency
    ADR-0002 depends on ADR-0001, which is still a draft
    > wait for ADR-0001 to be accepted, or drop it from docs/adr/0002-delivery.md
```

The finding points at the line that *declares* the relation, because that is
where a human goes to change the answer — the same discipline every built-in
follows.

| Field | |
|---|---|
| `query` | One selector, or a list of them read as a union. |
| `message` | The headline. `{0}` is the first node on the path, `{1}` the next; `{1.phase}` and `{0.fm.owner}` read any selector attribute. |
| `hint` | The next action. Optional, templated the same way. |
| `severity` | `error`, `warn`, `info` or `off`. Defaults to `warn`. |

It defaults to `warn` on purpose: a rule a team has just written has not yet
earned the right to fail their build, and the first run of a new convention is
when it is most likely to be wrong.

The id is the name with `project:` in front, which is why it can never collide
with a built-in — and why everything else already works. It is baselined by
`--record-baseline`, silenced by `--rule project:no-draft-dependency=off`,
escalated by `--strict`, listed by `spec-graph rules`, exempted on journals like
every other rule about obligations, and emitted as a first-class `ruleId` in
SARIF, where a project rule describes itself by the selector it is.

To see what a rule matches without copying its selector back out of the file:

```bash
spec-graph query project:no-draft-dependency --verbose
```

Mistakes are reported when the file is read, not discovered as a rule that
quietly finds nothing:

```text
spec-graph: .spec-graph.json: rules.no-drafts: mismatched arrow: use -kind-> for
  one hop or =kind=> for transitive (at character 10)
spec-graph: .spec-graph.json: rules.owner: "{1.phse}" asks for an attribute
  nothing has
```

See [ADR-0016](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0016-a-query-needs-a-sentence.md).

## Adopting this on a repository that predates it

Fifty findings on day one is not a report, it is a decision to be ignored. So
record what is already wrong, and check only what happens next:

```bash
spec-graph check --record-baseline .spec-graph-baseline.json
git add .spec-graph-baseline.json
```

```json
{
  "version": 1,
  "findings": [
    { "rule": "broken-reference", "document": "ADR-0004", "subject": "docs/plans/x.md", "count": 1 }
  ]
}
```

CI is green from the first commit, every specification written afterwards is
checked in full, and a new finding fails the build. When debt is paid, the run
says so:

```text
16ms · 2 accepted by .spec-graph-baseline.json
1 baseline entry no longer occurs - tighten it: spec-graph check --record-baseline ...
```

**It is keyed on the specification and the citation, never on a line number.**
A baseline that expires when somebody reformats a paragraph is worse than none,
so the entry survives edits, reordering, and the file being renamed — because
`ADR-0004` is the decision's name, not its location. Repeats are counted rather
than told apart, which is the deliberate cost of a key with no position in it.

By default that line is a note and the build stays green: failing because
somebody fixed something is a strange way to encourage them. But a note in CI
is a line that scrolls past, and an exemption nobody strikes outlives the defect
it was written for. A team that has decided its debt only moves one way turns on
the other side of the ratchet:

```bash
spec-graph check --baseline .spec-graph-baseline.json --ratchet
```

Now an undeclared finding fails **and** a declared one that no longer occurs
fails, each named, with `--record-baseline` as the fix — and the diff of that
file is the record of what was paid off.

**A `--baseline` you typed has to be there.** A path that reads nothing accepts
nothing, reports every accepted finding as new, and passes `--ratchet` with
nothing left to be stale about, so a typo in it looks exactly like a regression
nobody introduced: it exits `2` instead. A `"baseline"` in the configuration is
the other case and stays optional, because a repository declares the path before
the first run records the file — `--verbose` says when it read nothing. Either
may be absolute. See [ADR-0012](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0012-a-baseline-is-a-ratchet.md).

## Configuration

Anything you repeat on every run belongs to the repository rather than to the
command. spec-graph reads the first of `.spec-graph.json`,
`spec-graph.config.json`, or a `"spec-graph"` key in `package.json`:

```json
{
  "patterns": ["docs/**/*.md"],
  "ignoreReferences": ["trap *"],
  "ignoreFamilies": ["RFC"],
  "historyPatterns": ["**/JOURNAL_*.md"],
  "baseline": ".spec-graph-baseline.json",
  "ratchet": true,
  "severities": { "self-reference": "off" },
  "strict": true,
  "maxRelated": 3,
  "rules": {
    "no-draft-dependency": {
      "query": "document[phase=active] -depends-on-> document[phase=draft]",
      "message": "{0} depends on {1}, which is still a draft"
    }
  }
}
```

The file is looked for in the working directory and then upward, as far as the
repository — a directory holding `.git` — and **the directory holding it becomes
the root**. So a run from `packages/auth` reports what a run from the top
reports, byte for byte, because every path here is relative to the root.

- The nearest file wins.
- `--root` names the root yourself and turns discovery off.
- A path typed on the command line stays relative to where you typed it, brace
  alternative by brace alternative: `{/docs,x}` typed in `sub` is `/docs` or
  `sub/x`.

See [ADR-0018](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0018-the-configuration-file-is-the-root.md).

A flag always wins over the file, and list flags **add** to it rather than
replacing it — a `--ignore-ref` on the command line is one more exclusion, not a
decision to discard what the repository already declared. `--verbose` prints
which file was read, on stderr with everything else a run says about itself, so
it can be combined with any `--format` and leave the document on stdout intact.
`--no-config` skips the mechanism entirely.

`maxRelated` has no flag. It caps how many related locations one finding lists
— the lines under it in the terminal, `related` in JSON, `relatedLocations` in
SARIF — and is 8 unless set; `0` lists none.

A broken config stops the run with exit `2`, each problem named on stderr:
invalid JSON, a value of the wrong type, an unknown key, a rule that does not
compile. Why a mistake stops the run:

- A configuration that did not load checks a different repository than the one
  configured, and would report *that* one as consistent: a `{1.phse}` for
  `{1.phase}` in one rule's message is a green build over the files the
  correctly spelled rule fails.
- An unknown key counts, for the same reason it is reported at all — a silently
  ignored `ignoreReference` is a configuration that looks applied and is not.

`--no-config` checks on defaults instead, and the exit code then says which run
it was.

### Patterns

The patterns to check, `--ignore`, `--history` and `historyPatterns` are the
glob dialect every spec-* tool reads, so a scope means the same to spec-graph
as to the tool that wrote it. They are matched against the whole
repository-relative path, **case-sensitively on every host** — a baseline
recorded on a Windows checkout holds in Linux CI:

| pattern | matches |
| --- | --- |
| `docs/**/*.md` | Markdown anywhere under `docs`; `**` is whole directories, none or more |
| `docs/**.md` | refused: `**` is whole directories or nothing, so write `docs/**/*.md` or `docs/*.md` |
| `docs` | a file called `docs`, or everything under the directory |
| `docs/` | everything under `docs`, and not `docs` itself |
| `{docs,specs}` | two literals, so both directories and what they hold |
| `{docs/,specs}` | everything under `docs`, and `specs` as the literal it is: a `/` ends an alternative as it ends a pattern |
| `/docs`, `{/docs,specs}` | nothing under the root for `/docs`, which is rooted at the filesystem's root, and `specs` alone for the braces: a `/` starts an alternative as it starts a pattern |
| `adr/[0-9]*.md`, `adr/[!0-9]*.md` | a class, and a negated one; `[^0-9]` negates too |
| `!docs/drafts/**` | takes back what an earlier pattern matched; the last to match wins |
| `docs\adr\*.md` | the same as `docs/adr/*.md`: a `\` is a separator |

Three kinds of pattern stop the run with exit `2`, and the run names the
pattern, wherever it was written:

- a pattern that cannot mean a path under the root — an unclosed `[` or `{`,
  `..`, a lone `.` or `./`, an empty one, or braces that give one of them,
  `{./,docs}`;
- an extended glob, `+(a|b)`: write `{a,b}`;
- one too large to compile: braces that expand to more than 256 patterns, or a
  pattern past 65,536 automaton states.

Globs - the patterns to check, `--ignore`, `--ignore-ref`, `--history` - are
matched by an automaton rather than by `RegExp`, because a glob with three stars
in it is enough to keep `RegExp` busy for two minutes over a long reference
target. See
[ADR-0017](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0017-a-predicate-must-finish.md).

A class never matches a `/`. A parenthesis with no `|` in its group is itself,
so `C++(notes).md` names that file. A `..` typed below the root,
`spec-graph "../*.md"` from `docs/deep`, is resolved against where you typed it;
one that climbs past the root is refused, and so is a pattern typed in a
directory whose name a pattern would read as syntax, such as `notes[1]`.

A bare name and a path read differently as an `--ignore`:

- A bare `--ignore` name, `--ignore drafts`, still prunes that directory at any
  depth, even where a pattern starts inside it or names it.
- A `!` before one gives the name back, as a `.gitignore` line does:
  `--ignore drafts --ignore '!drafts'` reads every `drafts`, and the last bare
  name to name a directory decides.
- A path, `--ignore "docs/*"`, takes out what it matches wherever a pattern
  starts: `docs/drafts/**/*.md` finds nothing under it, as `docs/**/*.md` finds
  nothing in `docs/drafts`.

The walk never enters `.git`, `.hg`, `.svn`, `.cache`, `.next`, `.nuxt`,
`.turbo`, `.venv`, `node_modules`, `bower_components`, `vendor`, `dist`,
`build`, `out`, `target`, `coverage` or `__pycache__` on its way to what the
patterns name. Unlike an `--ignore`, these yield:

- to a pattern that starts inside one: `vendor/specs/*.md` is read from there,
  whatever the other patterns reach;
- to a plain name for one: `vendor` and `docs/vendor` read those directories
  as `vendor/` and `docs/vendor/` do, or the file, where one of them is a file;
- to a `!` before their name: `--ignore '!vendor'` reads every `vendor`, the
  rest of the list still skipped inside it. A `!` before a path takes back only
  what a path `--ignore` took out, so `!docs/vendor` gives back nothing the walk
  skips: name it among the patterns.

Nor does the walk follow a link, a pattern that starts beyond one included:
`docs/linked/*.md` reads nothing through the link `docs/linked`, as
`docs/**/*.md` reads nothing there. `followSymlinks` in the
[API](#programmatic-api) follows links, and:

- prunes a link to a directory as it prunes a directory of that name and path:
  a linked `node_modules` is skipped, and an `--ignore` takes a link out;
- never follows a link back into a directory the walk is inside, so a cycle is
  read once, and says nothing of it, as it says nothing of a link it does not
  follow.

`--ignore-ref` is matched against reference targets rather than paths:

- a bare pattern names one target exactly;
- case is ignored on every host;
- a `\` escapes the next character;
- `.` and `..` are the text of the link, in a brace alternative as anywhere
  else: `docs/{.,x}` names `docs/.` and `docs/x`, and `{./,docs}` the targets
  under `./`, and `docs`;
- a leading `/` is the text of the link too: `{/docs/a.md,x}` names the target
  `/docs/a.md`, as `/docs/a.md` does, and not `docs/a.md`.

See [ADR-0022](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0022-globs-are-the-family-path-dialect.md).

### Family rules

Every specification cites RFC 2119. In a repository that also keeps its own
`RFC-*` documents, that sentence reads as a dangling reference to a local RFC
2119 it does not have:

```json
{ "ignoreFamilies": ["RFC"] }
```

`families` is the stronger statement — *these* are the families this repository
has — and turns every other noun-number construct back into prose.

Both are consulted only after resolution has already failed, so `RFC 0001` still
resolves to your local RFC-0001 with `RFC` on the ignore list. No configuration
can delete an edge. See
[ADR-0010](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0010-configuration-belongs-to-the-repository.md).

`--verbose` lists everything they silenced, so one over-broad glob cannot quietly
turn the check off and look like a clean repository:

```text
i docs/adr/0001-traps.md:15:3   ignored reference: trap 55 (2 times)
i docs/rfcs/0002-transport.md:7:69  ignored family: RFC 2119
```

The JSON report carries the same rows under `suppressed`, without needing the
flag. What is deliberately *not* listed is a bare identifier spec-graph read as
prose on its own — `T-1000` was nobody's decision, and listing it would bury the
entries that were. See
[ADR-0008](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0008-wiki-links-carry-no-path.md).

Prose like `Phase 1`, `R69`, `Q-120`, `Table 2` and `Step 4` has never needed
this: an identifier found in prose is only read as a citation when its family
already exists in the corpus.

## CLI

```text
spec-graph [check] [patterns...]     Validate the graph. The default.
spec-graph query <selector>          Run a selector, print matching paths.
spec-graph query project:<rule>      Run a registered rule by its id.
spec-graph graph [patterns...]       Export for Graphviz, Mermaid or JSON.
spec-graph rules [rule-id]           List the diagnostics; --explain adds
                                     each selector and the ADR behind it.
spec-graph diff <before> <after>     Compare two JSON graph exports.

--root <dir>            Directory patterns resolve against, and the root of the
                        run. Without it the config file is discovered upward and
                        its directory is the root
--ignore <glob>         Skip paths (repeatable)
--ignore-ref <glob>     Do not report these reference targets (repeatable)
--family <name>         Families a bare identifier may name (repeatable)
--ignore-family <name>  Families that are never citations (repeatable)
--history <glob>        Files that log decisions rather than making them
--baseline <file>       Accept these findings; report only what is new
--record-baseline <f>   Write today's findings as accepted debt, exit 0
--ratchet               Also fail when a baseline entry no longer occurs
--no-config             Ignore .spec-graph.json and the package.json key
--format <fmt>          human | json | sarif (check) | github (check)
                        | gitlab (check) | markdown (check, diff)
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
never masquerades as a passing build, and neither does a pattern that matches
nothing, a configuration file that did not load, or a `--baseline` that is not
there.

**There is no `--watch`.** A full run on this repository takes 60 ms, so the
loop that would justify a resident process is one line of shell, and it belongs
to whatever the developer already uses rather than to this tool:

```bash
npx --no-install @descent-vtt/spec-graph --format json | jq -r '.summary'
```

## In CI

The exit code is the contract: `0` clean, `1` findings, `2` the tool could not
run. That is all most pipelines need.

Every job below installs the project first, with `npm ci`, and gives `npx` the
package's [full name](#names) behind `--no-install`: a job that lost its install
step then stops, where the command's name alone would fetch whatever package
has that name.

Beyond that, a format puts the findings where somebody will look:

| Format | Where the findings land |
| --- | --- |
| `--format sarif` | GitHub code scanning: comments on the changed lines |
| `--format github` | annotations on the diff, from the job's log, with no upload step |
| `--format gitlab` | the Code Quality report of a GitLab merge request |
| `--format markdown` | a table for the job summary, where reviewers look |
| `--format json` | a script or a bot of your own |

### Code scanning, with SARIF

For annotations on the diff rather than a line in a log, emit SARIF and hand it
to the uploader that already exists. The upload needs `security-events: write`,
and a job that declares its permissions has only those, so it names
`contents: read` for its checkout as well:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      persist-credentials: false
  - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
    with:
      node-version: '24'
  - run: npm ci
  - run: npx --no-install @descent-vtt/spec-graph --format sarif > spec-graph.sarif
    continue-on-error: true
  - uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
    with:
      sarif_file: spec-graph.sarif
```

The actions are pinned to commits, with the version beside each, because a tag
can be moved and a commit cannot; Dependabot's `github-actions` updates keep
pins like these current.

Findings land as comments on the changed lines, and they persist across commits
without drifting, because the `partialFingerprints` spec-graph writes are the
same identity a baseline is keyed on — the rule, the specification, and the
citation, with no line number in it (ADR-0012).

### Annotations, with `--format github`

Without code scanning, `--format github` writes one GitHub Actions workflow
command per finding, and the job's log turns each into an annotation on the
diff, with no upload step:

```yaml
- run: npx --no-install @descent-vtt/spec-graph --format github
```

```text
::error file=docs/adr/0003-event-log.md,line=13,title=ghost-handover::open obligation delegates to ADR-0002, which is retired. nothing will be read from ADR-0002 again - re-home this in a live document, or close it here
```

- An `error` finding is an `error`, a `warn` a `warning` and an `info` a
  `notice`, as spec-guard writes them, and one only `--strict` made an error is
  titled `ghost-handover (strict)`.
- The message carries the hint.
- `%` and line breaks are escaped everywhere, and `:` and `,` in the file and
  the title, as GitHub reads them.
- A clean run writes nothing.

### Code Quality, with `--format gitlab`

On GitLab, `--format gitlab` writes the Code Quality report a merge request
reads, and the merge request shows which findings it introduced and which it
resolved:

```yaml
spec-graph:
  script:
    - npm ci
    - npx --no-install @descent-vtt/spec-graph --format gitlab > gl-code-quality-report.json
  artifacts:
    when: always
    reports:
      codequality: gl-code-quality-report.json
```

Each finding is an issue:

- `check_name` is its rule, `description` its message and hint, and `location`
  its file and line.
- Severities map as `error` to `critical` - or `major` when only `--strict` made
  it an error - `warn` to `minor` and `info` to `info`.
- The `fingerprint` is a SHA-256 of the rule, the specification and what within
  it - a citation's target, or the document at the other end - which is what a
  baseline counts by. There is no line in it, so a finding a paragraph moved is
  not reported as new, and no message, so ticking one of three open boxes does
  not make an `orphaned-obligation` new either; the second of two findings
  identical in all three is told apart by its order.

`when: always` keeps the report when the job fails, which it does, with exit
`1`, whenever there is an error to report.

### A summary for reviewers, with `--format markdown`

`--format markdown` writes the same facts as a table, for the place reviewers
actually look:

```yaml
- name: Summarise the specification graph
  if: always()
  run: npx --no-install @descent-vtt/spec-graph --format markdown >> "$GITHUB_STEP_SUMMARY"
```

It leads with the verdict, counts the corpus, gives every finding its hint, and
*names* the baseline entries that no longer occur rather than counting them —
on a pull request a count is the one thing a reader cannot act on.

### JSON, for anything of your own

`--format json` is the machine-readable output to parse if you are building
something of your own: it carries the baseline note, the summary and the
per-file detail that SARIF and Code Quality have nowhere to put.

```yaml
- name: Check the specification graph
  run: npx --no-install @descent-vtt/spec-graph "docs/**/*.md" --format json > spec-graph.json
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

### What a pull request changed

A check says what is wrong. `spec-graph diff` says what a pull request changed:
documents added, removed, moved or accepted, relations added or removed, and
obligations resolved or reopened. It compares two exports made by the same
binary, so CI makes one from the base branch and one from the pull request:

```yaml
- run: git fetch --depth 1 origin "$GITHUB_BASE_REF" && git worktree add ../base FETCH_HEAD
- run: npx --no-install @descent-vtt/spec-graph graph --root ../base --graph-format json > base.json
- run: npx --no-install @descent-vtt/spec-graph graph --graph-format json > head.json
- run: npx --no-install @descent-vtt/spec-graph diff base.json head.json --format markdown >> "$GITHUB_STEP_SUMMARY"
```

It names only what it can tell apart:

- A document keeps its id through a rename, so a moved document reads as moved.
- An obligation's id is its position in its section, so inserting a question
  renumbers every question below it. An obligation is therefore paired only by
  an id its author declared, or by its document, section and title when nothing
  else shares them.
- Anything unpaired is reported as having appeared or disappeared, never as
  resolved or reopened.
- Findings are left to `--baseline`, which already reports what is new.

The exit code is `0` whether anything changed or not: a diff describes, and
`check` gates. See
[ADR-0020](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0020-a-diff-names-what-it-can-tell-apart.md).

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

Twenty-three ADRs, which `spec-graph` validates on every CI run:

- [ADR-0001 — A hand-written Markdown scanner](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0001-hand-written-markdown-scanner.md)
- [ADR-0002 — A four-phase lifecycle lattice](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0002-lifecycle-lattice.md)
- [ADR-0003 — Item state is resolved from competing signals](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0003-item-state-signals.md)
- [ADR-0004 — Reference resolution is deliberately asymmetric](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0004-reference-resolution.md)
- [ADR-0005 — The rules and the query language share one engine](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0005-rules-are-queries.md)
- [ADR-0006 — False positives cost more than misses](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0006-false-positives-cost-more.md)
- [ADR-0007 — Mutation testing, and what the score actually means](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0007-mutation-testing.md)
- [ADR-0008 — A wiki link carries a name, not a path](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0008-wiki-links-carry-no-path.md)
- [ADR-0009 — A specification is a region of a file, not a file](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0009-a-specification-is-a-region.md)
- [ADR-0010 — Configuration belongs to the repository](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0010-configuration-belongs-to-the-repository.md)
- [ADR-0011 — A historical record is not a specification](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0011-a-record-is-not-a-specification.md)
- [ADR-0012 — A baseline is a ratchet, keyed on identity](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0012-a-baseline-is-a-ratchet.md)
- [ADR-0013 — When the scanner is unsure, it hands back prose](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0013-the-scanner-hands-back-prose.md)
- [ADR-0014 — A relation is spelled in both directions](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0014-a-relation-is-spelled-both-ways.md)
- [ADR-0015 — Feedback goes where the tools already look](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0015-feedback-goes-where-the-tools-already-look.md)
- [ADR-0016 — A query needs a sentence before it is a rule](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0016-a-query-needs-a-sentence.md)
- [ADR-0017 — A predicate must finish](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0017-a-predicate-must-finish.md)
- [ADR-0018 — The configuration file is the root](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0018-the-configuration-file-is-the-root.md)
- [ADR-0019 — The sweep runs in shards](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0019-the-sweep-runs-in-shards.md)
- [ADR-0020 — A diff names only what it can tell apart](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0020-a-diff-names-what-it-can-tell-apart.md)
- [ADR-0021 — Releases are published by CI, with provenance](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0021-releases-are-published-by-ci.md)
- [ADR-0022 — Globs are the family's path dialect](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0022-globs-are-the-family-path-dialect.md)
- [ADR-0023 — The scanner is the family's](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0023-the-scanner-is-the-familys.md)

**Zero runtime dependencies.** Node 22+, native ESM, TypeScript strict with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The Markdown
scanner, the front-matter reader, the glob matcher, the query parser and the
regular-expression matcher behind `~=` are all written here or in
[spec-core](https://github.com/DescentVTT/spec-core), the library the spec-*
tools share, whose code is copied into `src/vendor/` and checked by hash rather
than installed. So the whole package is auditable in an afternoon — and nothing
in the pipeline can take longer than its input.

**Verified, not just covered.** 1,918 tests; 99.4% statement and 99.8% line
coverage. Coverage says a line ran, so the suite is also held to a mutation
score - 96.38% over 8,539 mutants, measured by CI's full sweep, and a build
fails under 93 - because a vocabulary entry or a boundary
condition can be weakened by an ordinary-looking refactor without a single test
going red. [ADR-0007](https://github.com/DescentVTT/spec-graph/blob/main/docs/adr/0007-mutation-testing.md) is straight about what
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

## Contributing

How to build, test and release spec-graph, and where a change usually goes, is
in [CONTRIBUTING.md](https://github.com/DescentVTT/spec-graph/blob/main/CONTRIBUTING.md).
Report a vulnerability privately, as
[SECURITY.md](https://github.com/DescentVTT/spec-graph/blob/main/SECURITY.md)
describes, and not in a public issue.

## Licence

MIT
