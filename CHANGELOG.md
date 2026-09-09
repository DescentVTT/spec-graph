# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org):
a patch fixes behaviour without asking anything of a repository that upgrades.

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

684 tests, and a mutation score of **79.69% over 8,126 mutants** - up from
77.16% over 7,720. The guard stays at `break: 70`, because the same source
measured twice on the same machine, with only test cases added between the runs,
moved nine untouched files by more than a point each in both directions. See
[ADR-0007](docs/adr/0007-mutation-testing.md).

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
