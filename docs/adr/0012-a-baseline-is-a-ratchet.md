---
status: accepted
date: 2026-09-07
---

# ADR-0012: A baseline is a ratchet, keyed on identity

## Context

A linter introduced to a repository that predates it reports everything at once.
Fifty findings on day one is not a report - it is a decision to be ignored. The
team cannot stop feature work to clear them, so one of two things happens: the
tool comes out of CI, or the rules that fired get switched off globally and the
next specification rots unwatched.

Both outcomes are worse than never installing it. The failure is not in the
findings, which are real. It is that a tool with no memory can only ever ask for
all of it at once.

## Decision

**Record what was already wrong, and report only what happened since.**

```bash
spec-graph check --record-baseline .spec-graph-baseline.json
git add .spec-graph-baseline.json
```

From then on, `--baseline .spec-graph-baseline.json` (or `"baseline"` in
`.spec-graph.json`) suppresses those findings and exits `0`. A new one fails the
build. Debt can be paid whenever there is room, and in the meantime nothing new
gets in.

### What makes two findings the same finding

This is the whole design, and everything else follows from it.

**Not the line.** A baseline keyed on line numbers is invalidated by any edit
above it, which turns every unrelated pull request into a wall of findings
nobody introduced - and a tool that cries wolf gets switched off in an afternoon
([ADR-0006](0006-false-positives-cost-more.md)).

**Not the message.** Rewording a diagnostic would silently expire every baseline
in the world on a patch release.

What survives is the pair a finding is actually about: **which specification,
and what within it.**

```json
{
  "version": 1,
  "findings": [
    { "rule": "broken-reference", "document": "ADR-0004", "subject": "docs/plans/x.md", "count": 1 },
    { "rule": "stale-premise",    "document": "ADR-0003", "subject": "ADR-0002",        "count": 1 }
  ]
}
```

Both parts are identifiers, and identifiers were made stable for exactly this:
`ADR-0003` is the decision's name, not its location, so the entry survives the
file being renamed, the section being moved into its own file, and every
obligation above it being reordered ([ADR-0009](0009-a-specification-is-a-region.md)).
The `subject` is the citation target where a rule has one, and the document at
the other end of the relation where it does not.

**Repeats are counted, not discriminated.** Two broken links from one document
to the same target are one entry with a count of two. This is deliberate
coarseness, and it is what is being bought: a fingerprint fine enough to tell
those two apart would have to name a position, and a position is the thing that
does not survive an edit. Where a baseline allows two and three exist, one is
reported.

### The ratchet

An entry whose finding no longer occurs is reported, with the command that would
strike it:

```text
16ms - 2 accepted by .spec-graph-baseline.json
1 baseline entry no longer occurs - tighten it: spec-graph check --record-baseline ...
```

Reported, not failed. Failing a build because somebody fixed something is a
strange way to encourage them.

### The other side of it, for teams that asked

*Amended 2026-09-10.* The paragraph above is the right default and it is not the
whole answer, because it assumes somebody reads the line. In CI nobody does: a
note on a green build is a line that scrolls past, and the exemption outlives the
defect it was written for. A file that only ever gets shorter is the whole claim
this ADR makes, and nothing was enforcing the "shorter".

So the sharp edge exists, and it is opt-in:

```bash
spec-graph check --baseline .spec-graph-baseline.json --ratchet
```

With it, a declared finding that no longer occurs fails the build, named, with
`--record-baseline` as the fix. Off by default for the reason above; on for a
team that has decided its debt only moves one way. This is the same shape as
`--strict` ([ADR-0006](0006-false-positives-cost-more.md) sets the quiet
default, a flag lets a repository that wants sharpness have it), and it is why
the sharpness belongs behind a flag rather than in the rule.

Two things fall out of the decision and are worth stating:

**The verdict follows the exit code.** A ratcheted failure over an otherwise
clean graph reports `the baseline is looser than the repository`, and the JSON
`ok` is `false`. A report that prints "ok" above a failing build is worse than
no report at all.

**The stale entries are named in the human report and counted in JSON.** The
fix for either is `--record-baseline`, and the diff of that file is a better
list than anything the reporter could print - it is the record of what was paid
off, in review, next to the change that paid it.

### Details that are not details

**Recording is not checking.** `--record-baseline` writes down what is wrong
today so tomorrow can be compared against it. It says nothing about whether
today is acceptable, so it reports what it wrote and exits `0`.

**A missing file accepts nothing.** `--baseline` against a repository that has
not recorded one yet reports everything, which is what an empty baseline does.
Requiring the file to exist would only mean a worse error message for the same
situation.

**A baseline that cannot be read is reported and ignored.** It suppresses
findings; one nobody can parse would suppress findings the reader cannot account
for. Malformed JSON, a version this build does not know, a misspelled rule in
one row: each is printed, and the run continues on what is left - the same
contract as [ADR-0010](0010-configuration-belongs-to-the-repository.md).

**The file is deterministic.** Sorted by rule, then document, then subject; two
spaces; no timestamp. It lands in a repository and is read in diffs, and a
generated date would make every re-record a change even when nothing changed.

**No configuration deletes an edge.** A baseline suppresses findings. The graph,
the corpus, and every count that describes them are identical with and without
it - only the tallies of findings and the verdict move. This is the same
guarantee `--ignore-ref` has carried since ADR-0008.

## Alternatives considered

**Per-file counts, as PHPStan and ESLint suppressions do.** Immune to line
shifts, which is the hard part, and rejected for being keyed on the wrong noun.
A file is where a specification happens to live today; the whole of ADR-0009 was
about not confusing the two. Keying on the specification costs nothing extra and
survives a move.

**A hash of the finding.** Stable only if nothing in the message, position or
wording ever changes, which is a promise no reporter can keep. And unreadable in
a diff, which matters for a file a team is expected to shrink deliberately.

**Suppression comments in the source.** `<!-- spec-graph-ignore -->` next to each
finding. Rejected: it puts fifty markers into fifty documents to solve a problem
that belongs to the repository's adoption date, and there is no way to see the
whole debt at once or to watch it shrink.

**Failing when the baseline is stale, by default.** A true ratchet, and too
sharp to impose. The build would break for the person who fixed something, on a
commit that improved the repository, and they would learn to stop. Available as
`--ratchet` since 0.3.0 for teams that want it; still not the default, and for
the same reason.

## Consequences

A legacy repository can adopt spec-graph in one commit with CI green, and every
specification written afterwards is checked in full. The debt is one file, in
review, that only ever gets shorter - and under `--ratchet`, provably so.

`--ratchet` has a cost worth knowing before turning it on: it fails on anything
that makes an entry stop firing, and deleting a document is one of those. That
is the point rather than a flaw, but it means the flag belongs to a repository
that checks its whole corpus on every run, not to one whose patterns vary
between invocations.

The cost is that a finding suppressed by fingerprint can hide a genuinely
different instance of the same rule between the same two documents. That is the
price of a key with no position in it, it is bounded by the count, and the
alternative was a baseline that expires whenever somebody adds a paragraph.

## Open Questions

- [x] Should `--baseline` warn when an entry names a document that no longer
      exists at all? **Resolved (2026-09-12):** yes - a stale entry now carries
      `paid` or `gone`, and the difference is the whole value of the label.
      `paid` is the ratchet working. `gone` is not an achievement at all: the
      document was not in this corpus, so nothing whatever is known about the
      defect, and the ordinary way to produce one is to narrow an include
      pattern. Both still make the file stale and both still trip `--ratchet`,
      because the file needs re-recording either way - but the verdict now says
      "N of them name documents this run did not see - check the include
      patterns before re-recording" rather than congratulating a team for losing
      sight of a problem.

      Asked of the graph rather than of the filesystem, deliberately. A document
      that still exists on disk and fell outside the patterns is gone for the
      purposes of the answer, and that is precisely the case worth catching.
- [x] Named queries from [ADR-0005](0005-rules-are-queries.md) still have no
      home, and a baseline of user-defined rules would need one first.
      **Resolved (2026-09-12):** they have one
      ([ADR-0016](0016-a-query-needs-a-sentence.md)), and the baseline needed no
      change to hold them. A project rule id is a rule id. The one deliberate
      decision is that an entry naming a rule the configuration no longer
      defines is accepted and then reported as stale, rather than rejected: the
      file is read before the configuration has any say, and rejecting it would
      un-accept debt somebody signed off.

## See also

- [ADR-0009](0009-a-specification-is-a-region.md) - the stable identifiers this
  keys on, and why they outlive a file.
- [ADR-0010](0010-configuration-belongs-to-the-repository.md) - where the
  baseline path is declared, and the report-and-continue contract for a broken
  file.
