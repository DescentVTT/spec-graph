# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org):
a patch fixes behaviour without asking anything of a repository that upgrades.

## 0.4.0

Ten open questions across the ADR suite, answered. Five shipped, three declined
with a reason, one settled by measuring it, and one withdrawn because it turned
out not to be true.

### Added

**A repository can write its own rules.** `rules` in `.spec-graph.json` takes a
selector, a message, a hint and a severity, and runs it beside the built-ins:

```json
"rules": {
  "no-draft-dependency": {
    "query": "document[phase=active] -depends-on-> document[phase=draft]",
    "message": "{0} depends on {1}, which is still a draft",
    "hint": "wait for {1} to be accepted, or drop it from {0.path}",
    "severity": "error"
  }
}
```

[ADR-0005](docs/adr/0005-rules-are-queries.md) claimed for three releases that
the selector language was expressive enough for a team to write the equivalent
of a built-in rule. It was only true at a prompt: `spec-graph query` could find
the thing, and nothing could make finding it fail. Three ADRs recorded the same
gap and stopped at the same sentence - a query needs a severity and a message
before it is a rule.

The id is the name with `project:` in front, and a built-in id can never contain
a colon. That one fact is why `--rule`, `--strict`, `--record-baseline`, the
severity table, the record exemption, the sort order and the SARIF `ruleId` all
carry a user-defined rule without being taught what one is.

Messages interpolate over the path the query already numbers: `{0}` and `{1}`
for node ids, `{1.phase}` and `{0.fm.owner}` for anything a selector can read. A
selector that does not parse, a `{2}` no query can reach, or an attribute
nothing answers to is reported when the file is read - a rule that cannot work
has to say so, because silence from a linter is indistinguishable from health.
`query` also takes a list, read as a union.

See [ADR-0016](docs/adr/0016-a-query-needs-a-sentence.md).

**A broken reference suggests the document it was probably meant to name.**
`ARD-0015` gets `did you mean ADR-0015?`; `0002-cacheing.md` gets its sibling
one letter away. `ADR-0003` in a repository of two ADRs gets nothing, and that
restraint is the design rather than a limitation of it: a family name is a word
people misremember, a number *is* the identity, and every number sits one edit
from its neighbours. Each gate ends the same way - exactly one candidate, or
silence. See [ADR-0004](docs/adr/0004-reference-resolution.md).

**A stale baseline entry says `paid` or `gone`.** `paid` is the ratchet working.
`gone` means the document was not in this corpus at all, so nothing is known
about the defect - and the ordinary way to produce one is to narrow an include
pattern. Both still trip `--ratchet`, but the verdict now says how many entries
name documents the run did not see and asks a team to check their patterns,
rather than congratulating them for losing sight of a problem.

**Stale entries are named in the JSON report**, under `baseline.entries`, each
with its label. A count is enough to know the file has slack and never enough to
strike it.

**`--verbose` lists what configuration silenced.** Every reference
`ignoreReferences` or `ignoreFamilies` suppressed, grouped by target and naming
which of the two did it; the JSON report carries every site under `suppressed`
without the flag. A single over-broad glob looks exactly like a clean repository
from the outside, and nothing said otherwise. Not listed: a bare identifier
spec-graph read as prose on its own - that was nobody's decision.

**A NUL byte is reported as a parse problem.** Not a finding: nothing about the
graph is wrong and it never fails a build. It earns the line because spec-graph
is likely the only tool that read the file at all - grep, diff and every review
interface treat it as binary - and the message names the usual cause, which is
UTF-16 read as UTF-8 rather than anybody's keystroke.

### Fixed

Nothing that a corpus had hit. Two findings came out of probing rather than out
of the suite, which is the practice [CLAUDE.md](CLAUDE.md) asks for:

- A near-miss gate that suggested a file which had moved **never fired**.
  Resolution already binds a path by its basename, so the suggestion had nothing
  left to suggest. Removed before it shipped rather than after.
- Hand-mutating each remaining gate found two that no test could kill. One was
  genuinely equivalent code and is now one line shorter; the other was masked by
  a length floor, and the test now writes a number long enough to clear it.

### Not added

- **SARIF `fixes`.** Counted the findings with a fix that is an edit rather than
  a judgement, and there is one. Everything else has to be *inserted*, into front
  matter that may not exist, at a position only a human can choose. The new
  near-miss suggestions made the case weaker rather than stronger: they are
  deliberately a guess, and promoting a guess to a machine-applicable edit throws
  away the restraint that makes it worth printing.
- **Hybrid documents** - a specification with a changelog section. The premise
  turned out to be wrong: regions cannot express it, because `record` is decided
  once per file and inherited by everything in it. Making it work means a second
  source of truth for `record`, traded against a free workaround - put the
  changelog in its own file, which is where it belongs.
- **Cross-repository references.** Every way of doing it puts network or
  discovery underneath a pipeline whose test strategy rests on being a pure
  function of text.
- **A guard for `~=`.** Probing confirmed `[title~=(a+)+$]` never returns. The
  hang has been reachable from `query` since 0.1.0; what 0.4.0 changes is that it
  now lives in a file that runs on every build. Rejecting nested quantifiers
  catches `(a+)+` and misses `(a|a)+`, and a guard that is incomplete and says it
  is safe is worse than no guard. Documented instead, with the alternatives
  weighed in ADR-0016.

### Measured

**The near-miss gate for front-matter keys stays at one edit**, and this is the
first time anybody checked. Across 73 keys that Jekyll, Hugo, Docusaurus, Astro,
MADR, KEP, the IETF datatracker and Obsidian actually write, one edit reads
*none* of them as a near-miss and two edits reads exactly one: `rfc`, which it
would tell an author to spell `refs`. [ADR-0014](docs/adr/0014-a-relation-is-spelled-both-ways.md)
said two edits would catch `dependancies`; one edit already did, along with
every other typo anybody produced to argue the case. Two buys nothing and costs
a false positive on a key that carries citations in exactly the corpora this
tool is pointed at.

### Verified

| | |
|---|---|
| `npm run lint` | pass |
| `npm test` | 754 passing, 20 files |
| `npm run selfcheck` | pass, over 19 documents and 124 relations |
| `npm run test:mutation` | **79.41%** over 8,585 mutants, 64m30s |
| `break` | unchanged at 70 |

79.69% over 8,126 mutants at 0.3.0 against 79.41% over 8,585 here, on the same
machine. The new code carries itself: `project-rules.ts` at **99.50%** with one
survivor - a genuinely equivalent `<` against `<=` in a comparator whose inputs
are object keys and therefore never equal.

That 99.50% is what reading the survivor list bought. The first full run put the
module at 86.89%, a targeted re-measurement with `coverageAnalysis all` agreed at
86.41% - so the gap was real and not `perTest` mis-attribution - and sixteen of
those survivors turned out to be tests nobody had written. The whole-corpus
figure moved 0.38 points for it.

The hosted number - the one that actually governs, because it is where the build
fails - comes from CI on push, and 75.14% from 0.3.0 stands until it does.

### Withdrawn

[ADR-0013](docs/adr/0013-the-scanner-hands-back-prose.md) said a lone `\r` was
not treated as a line ending. It always was - `createLineIndex` has recognised
all three terminators since 0.1.0 and says so in its own doc comment. The claim
came from reading the scanner and not the table underneath it, and nobody had
executed it. One corpus through `\n`, `\r\n` and `\r` now produces identical
items, findings and line numbers, as a test.

### Changed

For anyone using the programmatic API: `Diagnostic.rule` is now `AnyRuleId`,
which is `RuleId` plus the `project:` namespace. An exhaustive `switch` over the
built-ins needs a default arm. `BaselineOutcome.stale` carries `reason`, and
`ResolvedCorpus` carries `suppressed`.

## 0.3.0

Found by writing a corpus designed to break the scanner and reading the edges it
produced, which is the practice [CLAUDE.md](CLAUDE.md) asks for and the reason
it is there. The mutation score could not have found any of it: a mutant is a
change to code that exists, and a construct nobody parsed has no code to mutate.

### Fixed

**A reference-style link was read as a citation of its own label.**

```md
This depends on [ADR-0001][one].

[one]: 0001-target.md
```

Every renderer reads that as a link to `0001-target.md`. spec-graph read it as a
citation of the word `one`, which resolved to nothing - so those two lines
produced a false `broken-reference` **and** no `depends-on` edge at all. The
missing half is the worse one: an absent edge is invisible in a report that says
everything is consistent.

Definitions are now the destination table the labelled forms are read through. A
label nothing defines is prose, because `[design][one]` renders verbatim when
nothing says what `one` is. A broken one is reported at the definition, which is
the line that fixes it, however many places use the label.

**A `@spec-node` directive inside `<script>` or `<pre>` was honoured**, so a page
explaining how to annotate a document could annotate itself. The four elements
whose content is not Markdown are masked now, which is the CommonMark reading.
`<div>` and `<details>` keep their content: a decision written inside a collapsed
section is still a decision.

**A document could take an id that was not a name.** `id=\"ADR-9\"` inside a
JavaScript string parses its bare value as a lone backslash, and the document
then collided with itself, reported a duplicate id against its own file,
contained itself, and exported as invalid Mermaid. A declared id must carry a
letter or a digit.

**A percent-escaped destination resolved to nothing.**
`[Design](docs/my%20design.md)` is what a renderer, a documentation site and
GitHub's own copy-link all produce for a file with a space in its name. The
escapes are read as a fallback, so a filename that genuinely contains one keeps
resolving by the spelling it was written with, and a stray `100%` is left alone.

See [ADR-0013](docs/adr/0013-the-scanner-hands-back-prose.md).

**Front matter knew half of each relation.** `depends-on` was a key and
`depended-on-by` was not, so a repository whose filing convention records
dependents wrote the inverse spelling and got no edge, no warning, and a graph
that reported itself as consistent. Every directional kind is spelled both ways
now - twenty-five keys became fifty-six - and a test holds the invariant.
`relates-to` is symmetric and exempt.

Keys also fold on separators and case, so `depends-on`, `depends_on` and
`dependsOn` are one key rather than the two that happened to be written out.
See [ADR-0014](docs/adr/0014-a-relation-is-spelled-both-ways.md).

**`--verbose --format json` printed human lines onto stdout beside the JSON.**

### Added

- **`unknown-relation-key`** (warn). A front-matter key one edit from a relation,
  carrying something that could name a document, is reported rather than
  ignored. Both halves of that gate matter: `deprecated: true` is one edit from
  `deprecates` and a boolean is not a citation. It says what is true - *"the key
  declares no relation"* - and offers the near spellings rather than asserting
  one. See [ADR-0014](docs/adr/0014-a-relation-is-spelled-both-ways.md).
- **`--ratchet`**, and `"ratchet": true` in the configuration. The other side of
  a baseline: with it, a declared finding that no longer occurs fails the build,
  named, with `--record-baseline` as the fix. Off by default, because
  [ADR-0012](docs/adr/0012-a-baseline-is-a-ratchet.md) is right that failing a
  build because somebody fixed something is a strange way to encourage them -
  and on for a team that has decided its debt only moves one way, because a note
  on a green build is a line that scrolls past.
- **`--format sarif`**. SARIF 2.1.0, for `check`, so
  `github/codeql-action/upload-sarif` can turn findings into annotations on the
  diff with no integration on either side. The `partialFingerprints` are the
  same rule/specification/citation identity a baseline is keyed on, so an
  annotation survives a reformat. Deterministic and timestamp-free like every
  other output here. See
  [ADR-0015](docs/adr/0015-feedback-goes-where-the-tools-already-look.md).

### Not added

**`--watch`.** A full run is 60 ms, so the loop is one line of shell in whatever
the developer already uses. A resident process, a debounce timer and `fs.watch`
semantics that differ on all three platforms would be the one part of this
program that could not honour byte-determinism, inside a codebase whose whole
test strategy rests on everything between the edges being a pure function of
text. Reasoning in
[ADR-0015](docs/adr/0015-feedback-goes-where-the-tools-already-look.md).

### Measured

684 tests, and a mutation score of **75.14% on the hosted runner** - the figure
that governs, up from 73.32% at v0.2.0 - against 79.69% over 8,126 mutants on a
developer machine. The guard stays at `break: 70`. See
[ADR-0007](docs/adr/0007-mutation-testing.md), which 0.3.0 also amended: an
incremental run read 3.18 points *high* against a full rebuild of the same
commit, so the claim that incremental errs low was wrong.

## 0.2.3

### Fixed

**A path spelled without naming a file exactly could resolve to the wrong file.**
`docs/A` is two things at once - `docs/A.md` with its extension dropped, and
`docs/A/README.md` standing for its directory - and the index answering such
spellings held one id per key. A second claimant therefore did not make the link
ambiguous; it overwrote the first, and the link went to whichever file was
indexed last.

[ADR-0004](docs/adr/0004-reference-resolution.md) has always said two candidates
is worse than none, and a reference matching several documents is reported as
ambiguous rather than bound to whichever was indexed first. That now holds for
paths too.

Naming a file exactly is never ambiguous, whatever else is spelled the same way,
and a spelling only one file answers to still resolves in silence - so
`docs/adr/0007` addressing `docs/adr/0007/README.md` is unchanged.

**This can surface a new warning on upgrade**, in the one situation where it is
earned: a deliberate link written as a path that genuinely names two files. It
is a warning rather than an error, it lists both candidates, and prose that
happens to mention such a path stays silent, because an ambiguity nobody wrote
down is not a mistake anybody made.

## 0.2.2

### Fixed

**A link to a file holding a register resolved to one of its rows.** Both halves
of this needed no flag to trigger and no configuration to fix: a repository that
keeps no registers is unaffected, and one that does needs no change beyond the
upgrade.

Since 0.1.3 a register has yielded one specification per row or per section
([ADR-0009](docs/adr/0009-a-specification-is-a-region.md)), and every one of
those carried the file's path into the resolver's path index. That index keeps
whichever entry was written last, so the file's own entry was overwritten by its
final region, and:

- **A plain path link bound to the wrong node, silently.** `[A](docs/A.md)`
  pointing at a file whose last table row is `FR-2` produced an edge to `FR-2`.
  No diagnostic said so, and where the link carried a load-bearing relation -
  `depends on`, `assumes` - the graph asserted a dependency nobody wrote. This
  is the more serious half, because a wrong edge is invisible in a report that
  says everything is consistent.
- **An anchored link reported a broken reference that was not broken.**
  `[x](docs/A.md#how-to-read-this-document)` resolved to a row, and a row's
  anchor set holds only the headings inside its own span - none, for a table
  row - so a heading plainly present in the file was reported missing.

Both forms of register were affected, the table form and the heading form.

A region now stays out of the path index; only the file it lives in answers to
its path. The region keeps `path` on its node, so findings still name the file
it is written in and `document[path=docs/A.md]` still lists the file together
with its regions.

Found while adopting spec-graph in
[VirtualCortex](https://github.com/DescentVTT/VirtualCortex), where a
requirements table headed `Status` was enough to trigger it.

## 0.2.1

### Fixed

- One written citation is one reference. `Superseded by ADR-0009` in a status
  section was read twice - once by the status reader, which reports the whole
  line, and once by prose scanning, which reports the identifier inside it.
  Invisible while the target resolved, because two identical edges collapse into
  one; two findings on one line the moment it did not.

## 0.2.0

### Added

- **Historical records.** A journal, changelog or set of minutes is a log of
  what was decided, not a decision. `record` is a lifecycle phase, declared by
  `historyPatterns` in the configuration or by `<!-- @spec-history -->`, and
  never guessed from a filename. Its links are still checked and work handed
  *into* it is still a ghost handover; its own obligations and lifecycle are
  not. See [ADR-0011](docs/adr/0011-a-record-is-not-a-specification.md).
- **Baselines.** `--record-baseline` writes today's findings as accepted debt;
  `--baseline` reports only what is new since. Keyed on the specification and
  the citation rather than on a line number, so it survives edits, reordering
  and renames. Paid debt is reported, not failed. See
  [ADR-0012](docs/adr/0012-a-baseline-is-a-ratchet.md).

### Fixed

- The published tarball shipped source maps pointing at `../src/*.ts`, which was
  not in the package. They are self-contained now, and the declaration maps that
  could never resolve are gone.

## 0.1.3

### Added

- **A specification is a region of a file, not a file.** A register kept as
  headings or as a table yields one specification per decision, each with its
  own lifecycle, obligations and relations. See
  [ADR-0009](docs/adr/0009-a-specification-is-a-region.md).
- **Repository configuration.** `.spec-graph.json`, `spec-graph.config.json`, or
  a `"spec-graph"` key in `package.json`, with family allow and deny rules. See
  [ADR-0010](docs/adr/0010-configuration-belongs-to-the-repository.md).

## 0.1.2

### Added

- `--ignore-ref`, for repositories where `[[...]]` tags a concept rather than
  naming a file. See
  [ADR-0008](docs/adr/0008-wiki-links-carry-no-path.md).

## 0.1.1

### Added

- `--strict`, raising every warning to an error. An explicit `--rule` still
  wins, so `--strict --rule x=warn` exempts one rule rather than forcing a
  choice between all of it and none.

## 0.1.0

First release.
