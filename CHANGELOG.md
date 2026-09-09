# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org):
a patch fixes behaviour without asking anything of a repository that upgrades.

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
