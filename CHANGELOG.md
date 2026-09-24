# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org):
a patch fixes behaviour without asking anything of a repository that upgrades.

## Unreleased

Versions are published by CI from a `v*` tag, through npm's trusted
publishing, and no longer from a workstation
([ADR-0021](docs/adr/0021-releases-are-published-by-ci.md)). There is no
publish token anywhere, and every version from here on carries a provenance
attestation naming the repository, the commit and the run that built the
tarball. `npm audit signatures` checks it without taking anyone's word for
anything. 0.2.0 to 0.8.0 have none and never will.

## 0.8.0

A register row took its identifier from the first thing its *title* said, not
from its ID column. Found on the same 885-document repository as 0.7.0: 27 of
232 rows of one issues register were filed under the wrong entity.

A minor rather than a patch, and the baseline is the reason. A baseline is
fingerprinted on document ids, and the whole of this fix is that those ids move.
Measured on an unchanged corpus against a baseline recorded by 0.7.0: the
accepted finding came back as new, its entry was reported as no longer
occurring, and `check --baseline` went from exit `0` to exit `1`. One
`--record-baseline` settles it, and the entries it writes are the ones that were
meant all along. The rule at the top of this file says a patch asks nothing of a
repository that upgrades, and this asks for that run.

### Fixed

**A title names nothing.** `| OI-V-05 | ADR-040's enforcement point has no
browser test |` was read as `ADR-040`. Eighteen rows collided with the ADR they
cite that way, and the collision does not merely mislabel a row: run against a
corpus holding both, the ADR keeps the id and the issue has no node in the graph
at all. Nine more opened with a noun phrase, inventing a `STAGE-1`, a
`GUARDRAIL-5` and a `CLOSED-2026` that nobody had written, each of them open -
which is what drew the false `ghost-handover` findings the register was reported
for; two rows collapsed onto one `STAGE-1`.

The identifier a title opens with almost always belongs to the document the
title is *about*, so a title is read as a name only where nothing else has given
one - and where it is not the name it registers no alias either, because an
alias sends every citation of the real document to whatever quoted it.
`# ADR-0040 considered harmful` at the top of `0007-sharding.md` was registering
`adr0040` against `ADR-0007`.

Two things count as having given one: a number, from a declaration or a file
name, and for a register row its id column, whatever shape the id is in. A whole
file keeps the looser reading and its H1 can still name it, because there
nothing separates a title about another document from a title about this one:
`slug:` holds a URL segment rather than an id, so `slug: sharding` in
`sharding.md` under `# ADR-0007: Sharding` has to stay `ADR-0007`. A declaration
and the file name are still weighed together rather than ranked, so
`slug: sharding-the-write-path` in `0007-sharding.md` is `ADR-0007` as before.

**A region no longer reads a number out of the file it sits in.** Every row of
a register kept in `0042-open-issues.md` answered to `ADR-0042`, and so did the
file. ADR-0009 already said a region does not claim the file's *path*, for the
reason that two nodes answering to one name make every link to it ambiguous; the
file's name is that same claim spelled differently, and the rule was written
down as two.

**A file's own title heading is matched by its number, not its spelling.**
`# ADR-040` at the top of `0040-enforce.md` was read as a region *inside* the
file it names: one decision, two nodes, a split lifecycle, and a citation
arriving at whichever padding it happened to use. Padding is not part of an
identity anywhere else - `ADR-40`, `ADR-040` and `ADR-0040` all resolve to one
document - and now it is not part of this comparison either.

### Verified

`npm run lint`, 950 tests and `npm run selfcheck`. Thirteen of the fifteen new
tests fail against the unfixed source; the other two are the guards on the
layouts that must not move, which have to pass both ways. `identity.ts` and
`sections.ts` were measured on their own before and after: 72.77% and 66.89%
became 75.18% and 71.93%, and no mutant on the new lines survived, so nothing
was masked. ADR-0004 carries the rule as a
fifth asymmetry, with the hyphenated-prefix question declined under it, and
ADR-0009 is amended in place.

## 0.7.0

Three ways a run handed back something other than what it said it was: a
configuration that did not load reporting a clean graph, a `--baseline` that
read nothing accepting nothing, and `--verbose` breaking the document it was
printed above. The first two were found on an 885-document repository, and the
third while fixing them.

A minor rather than a patch. Two of the three turn a build that was passing
into one that fails, which is the whole point of them and exactly what the rule
at the top of this file says a patch may not do.

### Changed

**A configuration that did not load stops the run, with exit `2`.** Invalid
JSON, an unknown key, a value of the wrong type, a project rule that does not
compile: each was printed to stderr, and the run then went on with defaults -
reporting `the specification graph is consistent`, exiting `0`, and writing
`"ok": true` into JSON, SARIF and Markdown. Under `--strict` as well. A
`{1.phse}` for `{1.phase}` in one rule's message was a green build over exactly
the files that rule fails.

It was the one place the exit codes disagreed with themselves, too:
`--rule not-a-rule=off` on the command line has always exited `2`, and the same
misspelling inside `"severities"` printed a line and passed. `--no-config`
checks on defaults, and the exit code then says which run it was. The old
behaviour was the decision in ADR-0010, and that ADR now carries why it moved.

**A `--baseline` that cannot be read stops the run.** Read as an empty baseline,
a typo in the path reports every accepted finding as new, passes `--ratchet`
with nothing left to be stale about, and looks like a regression nobody
introduced. A `"baseline"` named in configuration is unchanged and still
optional, because a repository declares the path before the first run records
the file - `--verbose` now says when it read nothing. Unreadable, as opposed to
absent, is an error wherever the path was written. A baseline that cannot be
*parsed* is still reported and ignored: it only ever suppresses, so a row that
is dropped is a finding reported. See
[ADR-0012](docs/adr/0012-a-baseline-is-a-ratchet.md).

### Fixed

**`--verbose` no longer breaks the format it was combined with.** The line
naming which configuration file was read, and the one naming a project rule's
selector under `query`, went to stdout above the report. With `--format json`
that made the output unparseable; with `--format sarif` it made a file the
code-scanning uploader rejects over a schema rather than over the command that
was run. Both now go to stderr, with everything else a run says about itself.
[ADR-0015](docs/adr/0015-feedback-goes-where-the-tools-already-look.md) already
had the rule - rows "cannot go on stdout beside a JSON document without
breaking the parse" - and these two lines were the places that did not follow
it.

**An absolute baseline path is no longer resolved under the root.**
`--baseline /tmp/b.json` read `<root>/tmp/b.json` and `--record-baseline`
wrote there: the recording landed inside the corpus, or failed naming a
directory nobody had typed, and the read found nothing and said nothing. Both
platforms' spellings are absolute on either platform, since one repository is
read on a Windows checkout and in Linux CI from the same file.

- **A `package.json` configuration problem names `package.json`.** It reported
  `"spec-graph" must be an object` with no file in it, and a problem that names
  no file sends the reader to a `.spec-graph.json` that is not there.

### Verified

| | |
| --- | --- |
| `npm run lint` | pass |
| `npm test` | 935 passing, 23 files |
| `npm run selfcheck` | pass, over 23 documents and 184 relations |
| focused sweep, every changed region | 100% |
| `src/cli.ts` alone, before and after | 80.43% over 797 mutants, then 81.11% over 826 |
| `break` | unchanged at 70 |

Each behaviour was also run against the built binary rather than only through
`main()`, including the absolute paths, which is where a Windows drive letter
either survives `toPosix` or does not.

Moving two lines from stdout to stderr cost two mutants that a JSON parse used
to kill for free, and both were replaced with an assertion: a flag that is only
ever asserted when it is passed stops meaning anything. Both `cli.ts` figures
above are single-file runs on one machine with `--coverageAnalysis all`, which
is the comparison ADR-0007 asks for and not the hosted sweep that governs.

## 0.6.0

A diff of two graph exports that names only the changes it can tell apart,
every glob moved onto the automaton `~=` already ran on, and a directive that
annotates one item where it used to annotate every item in reach. The mutation
figure is lower than 0.5.0's, and it is the first a release has carried from
tests that no longer race each other on disk.

### Fixed

**A glob can no longer keep a run busy for minutes.** 0.5.0 moved `~=` onto an
automaton that cannot backtrack and left globs on `RegExp`, on the argument
that a glob has no nested quantifiers. Nobody had timed it. Stars that are not
nested still divide a failing subject between them every possible way:

| glob | subject | `RegExp` | now |
| --- | --- | ---: | ---: |
| `**/*-*-*-*.md` | a 643-character hyphenated file name | 2.3s | 0.2ms |
| `*-*-*-x` | a 10,000-character reference target | 120s | 0.9ms |

The second is the one that matters: `--ignore-ref` and `ignoreReferences` are
matched against targets read out of documents, which nothing limits the length
of. Every glob - the patterns to check, `--ignore`, `--ignore-ref`, `--history` -
now runs on the same automaton as `~=`, verified against the `RegExp` it
replaces on every glob and path in a differential corpus. See
[ADR-0017](docs/adr/0017-a-predicate-must-finish.md).

- **An invalid glob names itself.** `docs/{a` used to report
  `Invalid regular expression: /^docs\/(?:a$/i: Unterminated group`, about a
  parenthesis nobody typed. It now reports `invalid glob "docs/{a": unclosed "{"`.
- **`--ignore-ref` reads case the same way on every platform.** It lower-cased
  both sides, and on Windows alone also folded case the way the `i` flag does,
  which made a handful of distinct characters - the micro sign and the Greek
  mu - one target there and two everywhere else.
- **A `@spec-item` directive annotates one item.** Each item used to look for
  its own, so a directive was found by every item within 200 characters below
  it and by every item enclosing it. The question after a declared one took the
  same id and vanished from the graph without a word, and a parent could take
  its child's directive in place of its own. A directive now binds to the item
  directly below it, with nothing but blank lines and comments between, or else
  to the innermost item it is written on or indented under. An id two items
  still claim, by declaring it twice or by declaring another item's number, is
  a parse problem, and the first item keeps it. `bindItemDirectives` is
  exported; `directiveFor` is unchanged and still exported.

### Added

**`spec-graph diff <before.json> <after.json>` says what a change did to the
decisions:** documents added, removed, moved or accepted, relations added or
removed, and obligations resolved or reopened. It names only what it can tell
apart. An obligation's id is its position in its section, so one inserted
question renumbers every question below it, and a diff keyed on those ids would
report a closed question as reopened when nobody touched it. An obligation is
paired only by a declared id, or by its document, section and title when nothing
else shares them; anything unpaired is reported as having appeared or
disappeared. Human, `--format json` or `--format markdown`, and exit 0 either
way. See [ADR-0020](docs/adr/0020-a-diff-names-what-it-can-tell-apart.md).

- The JSON graph export names its `generator`, so a diff can warn when two
  exports came from different versions, and each item says whether its id was
  `declared`. Both are additions; the export is still version 1.
- `compileGlob(pattern, { ignoreCase })`, the matcher the walk uses, and an
  `ignoreCase` option on `compilePattern` for a pattern that must respect case.
  `globToRegExp` is unchanged and still exported.

### Changed

One behaviour moves, and it can turn a run that passed into one that fails.

- **A `@spec-item` directive with prose, a heading or code between it and the
  item below binds to nothing.** It used to reach any item starting within 200
  characters. Its id, state and title no longer apply: the item takes its
  numbered id, a `state="moot"` stops closing it, and a link to the declared id
  is a `broken-reference`. Move the directive down to the line above the item.

### Verified

| | |
|---|---|
| `npm run lint` | pass |
| `npm test` | 921 passing, 23 files |
| `npm run selfcheck` | pass, over 23 documents and 184 relations |
| hosted full sweep, which governs | **75.25%** over 10,519 mutants, four shards of 22 to 33 minutes |
| `break` | unchanged at 70 |

0.5.0's 76.83% is not the figure to compare with. About three points of it were
kills no assertion made: tests writing to fixed paths deleted each other's files
under Stryker's parallel workers. Race-free, the sweep read 73.42% before
`spec-graph diff` and 75.25% with this release: `diff.ts` at 98.35%, and
`directives.ts` from 66.88% to 78.01%. Lose every timeout and it reads 71.89%.
See [ADR-0007](docs/adr/0007-mutation-testing.md) and
[ADR-0019](docs/adr/0019-the-sweep-runs-in-shards.md).

The sweep after the directive fix moved `extract.ts` down 0.18 points, among the
usual movement in files nobody touched, and this one was real. Four mutants
that hand an item to every specification in a register had gone from killed to
surviving: resolution now drops the duplicates they create, and the test that
caught them only counted items. It now also asserts that no problem is
reported.

## 0.5.0

One shipped feature turned out to have shipped a false positive, and the
predicate that was documented as dangerous is now an automaton that cannot
backtrack. Four of the ADR suite's open questions answered by building the
thing, seven directions declined with a reason, one deferred with its design
settled so it is not re-litigated.

### Fixed

**A register's decisions answer for the front matter above them.** This was a
false positive in the feature 0.4.0 led with, and the worst kind: confident and
unanswerable. A region answered *nothing* for `fm.owner`, `!=` against an absent
value is a mismatch, so a repository writing

```json
"rules": { "owned": { "query": "document[fm.owner!=platform]" } }
```

was told twice that a register saying `owner: platform` is not owned by
platform — with the message rendering `{0.fm.owner}` as the literal placeholder,
because there was nothing to put there.

A region now carries its file's front matter minus two kinds of key. A
**relation** key stays behind: `supersedes:` at the top of a register supersedes
on behalf of the register, not of each decision in it. So does a key the region
**answers for itself** — its identifier, status, title and aliases, which are
precisely the things a register exists to vary row by row.
[ADR-0009](docs/adr/0009-a-specification-is-a-region.md) carried this as a
narrowed open question and called it a gap. It was a defect, and it was found by
pointing the binary at a register rather than by reading the code.

Read from the other side, this can *add* findings: a rule phrased positively,
`document[fm.deprecated]`, now matches a register's decisions as well as the
register. That is the same correction - the decisions really are described by
the front matter above them - and worth knowing before upgrading a repository
that keeps registers and writes rules about front matter.

### Added

**`~=` is matched by an automaton that cannot backtrack.**
[ADR-0016](docs/adr/0016-a-query-needs-a-sentence.md) documented this hazard
with `(a+)+$`, which nobody writes, and priced the fix at "worth it only if a
real repository hangs". Both were wrong. `^([A-Za-z0-9_]+[ ]?)+$` is what
somebody writes to check that a title is words separated by single spaces:

| subject | `RegExp` | now |
| --- | ---: | ---: |
| `the quick brown fox jumps over the lazy dog!` | 0.9s | 11us |
| `... over the lazy dog and!` | 5.4s | 12us |
| `... over the lazy dog and keeps!` | 103s | 13us |

A word of k letters can be cut into pieces 2^(k-1) ways and a backtracking
engine tries the product, so a sixty-character title does not finish this year —
unattended, on every build, against a corpus whose titles the author of the rule
has not read. The work is now exactly O(pattern x subject), and **no stage of
this pipeline can take longer than its input.**

It costs a dialect. Backreferences and lookaround are not regular, so they are
refused while the selector is read, with the character pointed at — as are three
things `RegExp` accepts and should not: an unknown letter escape, which `RegExp`
reads as the letter, so a pattern meant as an anchor silently matches a capital
A; a Unicode property escape, which needs a table this package will not carry;
and octal escapes. Everything else works, and a pattern that does not parse is
now a usage error rather than a pattern that silently matches nothing.

Verified against the engine it replaces: **1.33 million pattern-subject pairs,
zero disagreements**, 19,000 of them committed as a gate. It earned that twice
over, on one clause of the language specification read backwards in two
different places - the word characters `\b` recognises, and whether a character
whose upper case is ASCII may match `[A-Z]`. The second was found by the
mutation score pointing at a corpus with a blind spot in it rather than at a
test. See [ADR-0017](docs/adr/0017-a-predicate-must-finish.md) and
[ADR-0007](docs/adr/0007-mutation-testing.md).

**Configuration is discovered upward, and the file holding it is the root.**

```bash
cd packages/auth && spec-graph check     # the repository's rules, the
                                         # repository's patterns, the
                                         # repository's paths
```

[ADR-0010](docs/adr/0010-configuration-belongs-to-the-repository.md) worried
that discovery would make a run depend on where it started. Reading the working
directory already did, and silently: a check from a package directory found no
configuration, ran no project rules, used the default include patterns, and
printed a verdict in the same shape as the real one. Because the directory
holding the file becomes the root, and every path here is relative to the root,
a run from anywhere inside the repository now produces **byte-identical** output
to a run from the top. The walk stops at the repository — a directory holding
`.git` — so a stray file in a home directory cannot reach it. `--root` names the
root yourself and turns discovery off, and a path typed on the command line
stays relative to where you typed it. See
[ADR-0018](docs/adr/0018-the-configuration-file-is-the-root.md).

**`spec-graph query project:<rule>` runs a registered rule by name.** The rule
is already compiled by the time the command runs, and the alternative was
copying its selector back out of the configuration file by hand. Several
selectors are deduped the way the check dedupes them, so this prints the set the
check reports on; `--verbose` names them, which is the question a team
calibrating a convention is actually asking. Built-in rules are deliberately not
addressable this way: a project rule *is* its selector, while a built-in is a
selector plus judgement, and printing a set that differs from the findings would
invite the wrong conclusion.

**`spec-graph rules <rule-id> --explain` names the ADR that decided it.** A rule
that fires is a claim about somebody's repository, and the reasoning behind the
claim was in a document nobody could find from the message. The table holds a
pointer rather than a paraphrase, because a second copy of the reasoning would
drift from the first — and a test holds every pointer to a file this corpus
checks, so a renamed ADR breaks the link in the same run that breaks the
reference.

**`--format markdown`** writes the same facts as a GitHub-flavoured table, for
`$GITHUB_STEP_SUMMARY` or a pull-request comment:

```yaml
- run: npx spec-graph --format markdown >> "$GITHUB_STEP_SUMMARY"
```

SARIF puts a finding on the line that caused it, which is where somebody fixing
one wants it, and says nothing at all to the person deciding whether to merge.
This leads with the verdict, counts the corpus, gives every finding its hint,
and *names* the stale baseline entries rather than counting them — on a pull
request a count is the one thing a reader cannot act on. No environment
detection: a format that changed because a variable was set would be a format
nobody controls.

### Changed

Four behaviours move, none of them a rule. Three can turn a run that passed
into a usage error, which is the point in each case; the fourth changes what a
run from a subdirectory reports.

- **A `~=` pattern that does not parse is a usage error**, with the character
  pointed at, rather than a pattern that matches nothing. The old silence was
  indistinguishable from a rule that ran and found none.
- **A `~=` pattern using a backreference, lookaround, `\p{...}`, an octal
  escape or an unknown letter escape is refused**, for the reasons above. If
  you have one, the message says which construct and why; `^=`, `$=` and `*=`
  cover the fixed-prefix, suffix and substring cases without a pattern at all.
- **A run from a subdirectory now finds the repository's configuration**, and
  reports repository-relative paths because the configuration's directory is
  the root. A script that read paths out of a nested run will see them change.
  `--root` keeps the old behaviour exactly.
- **`spec-graph rules <word>` reads the word as a rule id** and reports one
  that names nothing. It used to be collected as an include pattern, which the
  command has no use for.

### Declined

Each with its reasoning in the ADR that owns the question, rather than in a
roadmap nobody reads:

- **An MCP server.** The capability is already here — `analyseSources()` takes
  text, `--format json` is the answer — so what is left is a protocol
  implementation, hand-written to keep the dependency count at zero, tracking a
  specification that is still moving, to expose three tools that are three shell
  commands an agent can already run.
- **A language server.** The right shape for editor feedback and a second
  package's worth of work, and SARIF already reaches the problems pane. Two of
  the three hard parts are done — `analyseSources()` needs no file on disk, and
  every finding carries a span — so it should start when somebody wants hover
  and go-to-definition, not as a way of delivering diagnostics that already
  arrive.
- **A `--watch` daemon.** Declined again, with a better reason than last time:
  the incremental half of it cannot work. Whether a bare `ADR-0099` in prose is
  a citation depends on which families exist elsewhere, and a near-miss
  suggestion is computed against every sibling — touch one file and the honest
  set to recompute is all of them. Which is fine, because the pipeline is a pure
  function and 60 ms long. And then the resident index buys nothing, and the
  feature is a loop.
- **Code frames in the terminal.** The report already prints
  `file:line:column`, which every terminal in use turns into a click, and
  `renderMatch` already prints the shape of a multi-hop path.
- **Provenance and attestation metadata.** A timestamp in the output means no
  two reports of one corpus are ever byte-identical, which is the property every
  format here is built to have. The commit is something CI already knows.
- **An interactive SVG.** A layout engine or a vendored library is a runtime
  dependency wherever it sits in the tarball, and its bytes depend on a layout
  pass. `dot` and `mermaid` hand layout to tools built for it, and both are
  text. The other half of that ask - phase styling and typed edges in the
  Mermaid export - has been there since the first release. What is left is a
  `subgraph` per directory, which changes the shape of an export somebody's
  documentation build is parsing, to group a corpus that is one directory in
  most repositories.
- **Definition lists as a register form.** Two unrelated syntaxes behind one
  name: raw `<dl>`, which the scanner leaves as prose deliberately because
  ADR-0001's masking guarantee is what keeps a code fence quiet, and the
  PHP-Markdown-Extra form, which is not CommonMark and which no corpus here
  contains. Either would need a new parser for a convention nobody has written
  down.

One is deferred rather than declined, with half its design recorded so it is not
re-litigated: a **relational diff** between two states of the graph, taken
between two `--graph-format json` exports rather than between two git revisions,
because revisions mean spawning a binary underneath a pipeline that is a pure
function of text. See
[ADR-0015](docs/adr/0015-feedback-goes-where-the-tools-already-look.md).

### Verified

| | |
|---|---|
| `npm run lint` | pass |
| `npm test` | 833 passing, 21 files |
| `npm run selfcheck` | pass, over 21 documents and 159 relations |
| `npm run test:mutation` | 80.54% over 9,697 mutants, 74m27s |
| hosted full run, which governs | **76.83%**, 168m06s |
| hosted incremental run, same commit | 76.43%, 64m27s |
| `break` | unchanged at 70 |

79.41% over 8,585 mutants at 0.4.0 against 80.54% over 9,697 here, on the same
machine: 1,112 more mutants and a point higher. The new code carries itself -
`regex.ts` at **90.61%**, `config.ts` at 92.37%, `project-rules.ts` still at
99.50% - and lose all 343 timeouts and the figure reads 77.00%.

The first full run of this release read 80.35%, and its survivor list is where
the last defect came from. A mutant on the line stepping past `^` in a negated
class survived 1.33 million differential comparisons, because the corpus only
ever tested classes against two-character subjects; one-character subjects
killed it and then caught `[A-Z]` matching U+017F. `report.ts` went from 66.30%
to 70.84% on the same pass, once the Markdown tests asserted the table's
structure - rectangular rows, a blank line before every block, every summary
number present - rather than fragments of its text. What remains there is
mostly the older formatters.

Between those two runs `rules.ts` moved from 79.42% to 76.02% and
`directives.ts` from 77.92% to 74.03%, with neither file touched: the tests added
in between changed which tests `perTest` believes cover which mutants.
[ADR-0007](docs/adr/0007-mutation-testing.md) has recorded that shape for two
releases, and it is why a per-file drop is a question and not an answer.

The hosted number is the one that governs, because it is where the build fails:
**76.83%**, up from 75.40% at 0.4.0. Lose every timeout and it reads 73.31%, the
first time the pessimistic figure has cleared the guard by more than three
points.

The incremental run on the same commit read 0.40 points low - the third
observation after 3.18 high at 0.3.0 and 1.29 low at 0.4.0, and the reason
[ADR-0007](docs/adr/0007-mutation-testing.md) calls it a signal rather than a
figure. The tag's run also logged a cache save, which this entry first read as
the cache-key fix from 0.4.0 doing its job. *Corrected 2026-09-13:* it saved a
copy of the stale report it had restored, because the full step never wrote one,
and an entry saved under a tag cannot be restored on `main` in any case. See
[ADR-0007](docs/adr/0007-mutation-testing.md).

**The rebuild took 168 of its 180 minutes.** 13% more mutants than 0.4.0, and 63%
longer on the hosted runner against 15% longer locally. At 0.4.0's old cap of
120 it would have been cancelled with nothing reported. The cause is not yet
attributed - runner variance and the new differential test are both candidates -
and the choice between raising the cap again and cutting per-mutant cost is left
open in ADR-0007 until it is.

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
| `npm run test:mutation` | 79.41% over 8,585 mutants, 64m30s |
| hosted full run, which governs | **75.40%**, 102m48s |
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

The hosted number is the one that actually governs, because it is where the build
fails: **75.40%**, up from 75.14% at 0.3.0. Lose every timeout on a loaded runner
and it reads 71.76%, which is the most margin `break: 70` has ever had.

That run also caught the other half of a claim
[ADR-0007](docs/adr/0007-mutation-testing.md) narrowed at 0.3.0. The `main` push
and the `v0.4.0` tag were the same commit on the same runner, and the incremental
read **1.29 points low** against the rebuild - having read 3.18 points *high* at
0.3.0. Two observations, opposite signs. The direction is not a property, and the
incremental run took 110 minutes to the rebuild's 103, because a change this wide
leaves it nothing to reuse.

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
