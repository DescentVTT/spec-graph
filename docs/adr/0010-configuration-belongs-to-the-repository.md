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

**A broken configuration stops the run.** *Amended 2026-09-16.* Malformed JSON,
an unknown key, a misspelled rule, a value of the wrong type, a project rule
that does not compile: each is printed, and the run exits `2` having checked
nothing.

This reverses the paragraph that stood here, which had the run continue on
defaults because a config file with a typo in it should not stop a team seeing
the findings it was about to show them. That argument assumed the fallback run
is *less* informative than the real one. It is not. It is authoritative-looking
and wrong. Measured on an 885-document repository: a `{1.phse}` for `{1.phase}`
in one rule's message dropped that rule at load time, the files the correctly
spelled rule fails came back clean, and the run printed `the specification graph
is consistent`, exited `0`, and reported `"ok": true` in JSON, SARIF and
Markdown alike. Under `--strict` as well. Nothing in that output says it came
from a configuration the repository does not have.

It was also the one place the exit codes disagreed with themselves.
`--rule not-a-rule=off` on the command line has always exited `2`; the same
misspelling inside `"severities"` printed a line and passed the build. One
mistake, two verdicts, and the quiet one is the one CI reads.

The old paragraph's concern is answered rather than overruled: the findings are
still one flag away, and the message that stops the run names it. `--no-config`
checks on defaults, and the exit code then says which run it was. An unknown key
is still *reported* rather than ignored, for the reason it always was - a
silently dropped `ignoreReference` is a configuration that looks applied and is
not. Failing on it is that same argument carried to its end.

**An error nothing expected is exit `2` too.** *Amended 2026-10-08.* The exit
codes disagreed with themselves in one more place. `main()` is documented as
never throwing, and for an error no verb expected it rejected: a write the
stream refused, a defect in a reporter or in the parser. The launcher ends
on `process.exitCode = await cli.main()`, so the rejection was Node's uncaught
error, the stack and exit `1`, which CI reads as findings and the family
contract
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md))
as "it found something". Measured on 0.12.1 through the launcher, with a stdout
that throws: `--version`, `--help`, `check`, `query`, `graph` and `rules` each
exited `1`, and so did `graph --graph-format json` into a reader that closed
the pipe, an error no promise holds.

`main()` now resolves to `2` for every error it awaits that nothing expected:
`spec-graph: unexpected error:` and the stack on stderr, so that a report of it
says where, and nothing on stdout, where a script reads a document.
The launcher answers what nothing awaits the same way. It owns the process,
which `main()` does not: a caller of `main()` from the package gets `2` where it
got a rejection, and no handler it did not ask for. `analyse()` and the rest of
the API throw as they did, and an error `analyse()` throws inside a run is still
its message and exit `2`.

**A reader that closed the output is answered in a line.** *Amended again
2026-10-08.* The amendment above made a pipe its reader closed one more error
nothing expected. Measured on 0.13.0 through the launcher (Windows 11, Node
24.18.1): `spec-graph --help` into a reader that had already left printed
`spec-graph: unexpected error: Error: EPIPE: broken pipe, write` and eight
lines of stack, exit `2`, and so did `--version`, `check`, `query`, `graph`
and `rules`. A reader that stops reading is an everyday thing, and a stack
sends a person looking for a defect that is not there.

It is now one line on stderr and no stack,
`spec-graph: stdout was closed before all of the output was written`, in the
words every tool of the family uses
([the family contract](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
The exit stays `2`: the answer did not arrive, and what a script was handed of
a document is not the document. Every time, it arrived as the stream's `error`
event, which nothing awaits, and never as an error thrown where `main()`
awaits: so the launcher answers it, and `main()` answers in the same words
where a write does throw it, as a caller's own stream may. It is told from
every other error by its code, `EPIPE`: stdout and stderr are the only pipes
spec-graph writes to. When stderr is the one that closed there is nowhere left
to say anything: nothing is written, to stdout either, and the exit is `2`. A
write that fails for another reason, a full disk under `> graph.json`, keeps
`unexpected error:` and its stack. An output smaller than the pipe is written
whole before its reader leaves, and that run ends as it would have:
`spec-graph graph | head -c 10` on this repository, 23 KB, exits `0`.

**An input that is set and names nothing is refused.** *Amended 2026-10-09.*
A configuration that did not load stops the run because the run would answer
for another repository. The command line had the same hole in smaller places:
a value that was set, named nothing, and was read as if it had not been
given. Measured on 0.13.1, built from 7d920ee, through the launcher (Windows
11, Node 24.18.1), over two documents of which one cites an `ADR-0099` nobody
wrote, so that the plain run exits `1`:

| Given | 0.13.1 | Now |
| --- | --- | --- |
| `--family ""`, `--family ADR,RFC` | exit `0`, "consistent" | exit `2`: `--family expects one family's name, such as ADR, got ""` |
| `"families": [""]` in the configuration | exit `0`, "consistent" | exit `2`, a problem in the configuration |
| `--ignore-family ""` | exit `1`, as without it | exit `2`, in the words `--family` gets |
| `rules --root nowhere` | exit `0`, the built-in rules | exit `2`: `--root "nowhere" is not there` |
| `check --root notes.txt`, a file | exit `2`: `no specifications matched` | exit `2`: `--root "notes.txt" is not a directory` |
| a directory called `.spec-graph.json` | a run on defaults | exit `2`: `.spec-graph.json cannot be read` |
| `--ignore " "` | exit `1`, as without it | exit `2`: `invalid glob " ": the pattern is empty` |
| `--record-baseline " "` | exit `0`, and a file named with a space | exit `2`: `--record-baseline expects a file, got " "` |
| `rules broken-reference extra` | exit `0`, the first rule | exit `2`: `rules takes one rule id, got 2: broken-reference, extra` |
| `graph --format json` | exit `0`, DOT | exit `2`: `--format json belongs to check, query or diff, not to graph` |

The first row is why this is not tidiness. `families` is an allowlist, and a
name no family has allows nothing: every family is then one the repository
"does not have", every citation is prose, and the run that failed on a
dangling one reports a consistent graph. `--family "$FAMILIES"` with the
variable unset is all it takes, or a list typed where one name goes. This is
the green build from a typo that the 2026-09-16 amendment stopped for the
configuration file, reached from the command line.

A family's name is whatever the reader of identifiers reads as one, so the
check asks that reader instead of holding a second pattern that could drift
from it: a name is a family's when an identifier written with it, `<name>-0`,
is read as that family. That is a letter and then at most fifteen letters,
digits or underscores. `--family`, `--ignore-family`, both configuration keys
and `createFamilyFilter()` from the package refuse anything else, spaces
around a name aside.

A blank counts as empty where the value is a name, a path or a pattern. For
`--ignore` that reverses 0.9.0, which read a pattern of spaces as a
directory's name because a directory can be called that: the patterns to
check, `--history` and `--ignore-ref` refuse one already, and a variable that
is unset beside a space is the likelier writer. A name with a space in it,
`--ignore "my drafts"`, is a name as before.

A `--root` is checked where it is read, by `check`, `query`, `graph` and
`rules`, and only when it was given: the directory a run starts in is not an
option somebody typed. A configuration file is unreadable when the read fails
for any reason but there being nothing by that name, and stops the walk
upward as one that does not parse does
([ADR-0018](0018-the-configuration-file-is-the-root.md)).

Each of these is input refused that was accepted, so they arrive together in
a minor release.

What is still taken, and why:

- `--family RFC` where the corpus has no such family. The allowlist says
  which families the repository has, and a name a family can have is taken
  at its word.
- An empty list in the configuration, `"families": []` or `"patterns": []`.
  A list of none is what leaving the key out says, and spec-harness reads
  `patterns` the same way when it asks whether the briefs are checked.
- A baseline that does not parse, which is reported and ignored: a baseline
  only suppresses, so the failure reports more and not less
  ([ADR-0012](0012-a-baseline-is-a-ratchet.md)).
- A comma in `--ignore`, `--ignore-ref` or `--history`. Each takes one
  pattern, and a path or a target may hold a comma.
- An option the command does not read, `check --graph-format json` or
  `graph --strict`. The run writes what the command writes, whatever the
  option. `--format json` on `graph` and `rules` is the exception, because
  `--format sarif` was already refused there for the reason that holds for
  JSON: the file handed to whatever waits for it is DOT.

**The environment is read leniently, and one way.** No variable stops a run:
the ones a report reads are conventions other programs set. `NO_COLOR` and
`FORCE_COLOR` count when they are not empty, `NO_COLOR` first, and
`FORCE_COLOR=0` turns colour off, as in spec-brief. `CI` is no longer read:
it turned colour off on a terminal, where spec-brief and spec-guard colour,
and it says who started the run, not what the stream draws. `TERM=dumb` still
turns colour off, which those two do not read: it is the terminal saying it
draws none, and Node's own `getColorDepth()` answers one bit for it.

`SPEC_GRAPH_ASCII` is spec-graph's own, and was read for being set, so `0`
and `false` turned ASCII on. It asks for ASCII unless it is empty, `0` or
`false`, in any case, and `--help` and the README name it beside `--ascii`,
where it was written down nowhere. Off is the same as unset: a legacy Windows
console still gets ASCII.

*Amended 2026-10-11.* Two readings above were not the family's. Measured on
main at ebdae4c, through the launcher into a pipe: `FORCE_COLOR=false`
coloured the report, where Node and `supports-color` read `false` as off, and
on Windows a console with `WT_SESSION=` was sent the Unicode glyphs, where
one that leaves the variable unset gets ASCII. `FORCE_COLOR` is off now for
exactly `0` or exactly `false`, on a terminal too, and on for any other value
that is not empty, as it was, `true`, `1` and `FALSE` among them
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
`WT_SESSION` and `TERM_PROGRAM` set to nothing are unset, as `NO_COLOR` and
`FORCE_COLOR` are and as spec-guard reads them: each was read for being set,
the fault `SPEC_GRAPH_ASCII` had. One of the two cleared beside one that names
a terminal is still a terminal named.

*Amended 2026-10-12.* The glyphs could be asked for one way. `--ascii` and
`SPEC_GRAPH_ASCII` ask for ASCII, and nothing asked for the Unicode ones.
Measured on main at 11e2895, through the launcher on Windows with neither
`WT_SESSION` nor `TERM_PROGRAM` set: the report is in ASCII, and
`--no-ascii` is `unknown option "--no-ascii"`, exit `2`. A person whose
terminal draws the glyphs and whose console does not say so had no option
to give.

`--no-ascii` draws the Unicode glyphs, on any platform. An option wins over
the environment both ways: `--no-ascii` over `SPEC_GRAPH_ASCII=1` and over a
console that names no terminal, `--ascii` over `SPEC_GRAPH_ASCII=0` and over
a terminal that names itself. The variable is as it was: it asks for ASCII
unless it is empty, `0` or `false`, and off is the same as unset, so there
is still no value of it that asks for Unicode.

Given together the two are refused, whichever comes first, exit `2`:

```text
spec-graph: --ascii is given beside --no-ascii, and the glyphs are drawn one way: give one of the two
```

The later of the two would decide and the earlier go unread, and two things
of which one would go unread are refused together
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
2026-10-11). `--color` beside `--no-color` is still taken, the later
deciding: that pair is not this amendment's, and is left as it is.
`--help` and `--version` are answered first, as they are beside an option of
another command.

`--no-ascii` is a check's option, and joins `--color` in the table below.
Only a check's report draws a glyph, and the family's rule is that an option
is refused where taking it would say what is not so, and taken where it asks
a command to leave out what it never does
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
2026-10-11). `--ascii` on a command that draws no glyph asks for what is
already so, as `--no-color` does there, and every command still takes it.
`--no-ascii` there would say the Unicode glyphs were drawn where none is, as
`--color` would of colour, and `query`, `graph`, `rules` and `diff` refuse
it in the words they have for any option they do not read: `--no-ascii
belongs to check, not to query`. The first draft of this amendment took it
on every command, reading the pair as saying how a glyph is drawn and not
that one is. The family's rule is the one above, and it is the one `--color`
already follows here. A format of a check that draws no glyph takes both,
as it takes `--no-color`: that pairs an option with an option.

**An option beside its own opposite is refused.** *Amended again
2026-10-12.* The amendment above refused `--ascii` beside `--no-ascii` and
left `--color` beside `--no-color` as it was. The rule it cites makes no
such difference: two things of which one would go unread are refused
together. Measured on main at 70bdd90, 0.15.0, through the launcher into a
pipe (Windows 11, Node 24.18.1), over two ADRs of which one cites an
`ADR-0099` nobody wrote, with `NO_COLOR`, `FORCE_COLOR`, `TERM`,
`SPEC_GRAPH_ASCII`, `WT_SESSION` and `TERM_PROGRAM` cleared and then set as
a row says:

| Given | 0.15.0 | Now |
| --- | --- | --- |
| `check --color --no-color` | exit `1`, the report without colour | exit `2`, the line below |
| `check --no-color --color` | exit `1`, the report in colour | exit `2`, the same line |
| The same two under `FORCE_COLOR=1`, `NO_COLOR=1` or `TERM=dumb` | the later of the two decided | exit `2` |
| The same two beside `--format json`, `sarif`, `github`, `gitlab` or `markdown` | exit `1`, the document | exit `2` |
| `check --ascii --no-ascii`, either order, in each format | exit `2` | the same |
| `--color --color`, `--no-color --no-color`, `--ascii --ascii`, `--no-ascii --no-ascii` | taken as the option once | the same |
| `--color --no-ascii`, `--no-color --ascii` | taken | the same |
| Either pair beside `--help`, `-h`, `--version` or `-v`, on every command | the help, the version | the same |
| `query`, `graph`, `rules` or `diff` with `--color --no-color`, either order | exit `2`: `--color belongs to check, not to query` | the same |
| `check --no-color` under `FORCE_COLOR=1`; `check --color` under `NO_COLOR=1` or `TERM=dumb` | the option decides | the same |
| `check --no-ascii` under `SPEC_GRAPH_ASCII=1`; `check --ascii` under `WT_SESSION=1` | the option decides | the same |

Those are the two pairs the command line has. Each of its other twenty-one
options was given with `--no-` put before its name, and `--no-config` with
it taken off: every one is `unknown option`, `--no-strict`, `--no-ratchet`
and `--config` among them. So every option given beside its own opposite is
refused now, exit `2`, whichever of the two comes first:

```text
spec-graph: --color is given beside --no-color, and a report is coloured or it is not: give one of the two
```

The line names the option that turns the thing on first, in either order,
as the line for the glyphs does. Where both pairs are on one line the first
such option on it decides which pair is named, and the run that follows
names the other. An option of another command is still named before the
pair it is half of, since that is the line to act on first: `query --color
--no-color` is told that `--color` is a check's. A format that prints no
colour refuses the pair all the same, as it refuses the glyphs' pair: one
of the two is unread there too, and what a script meant by the line is as
unknown.

An opposite is for overriding, and still does. Here it overrides the
environment alone: the configuration file has no key for colour or for the
glyphs, and `"color"` or `"ascii"` in it is an unknown key, exit `2`. What
the file can turn on, `strict` and `ratchet`, no option turns off - a
`--rule` exempts one rule, and `--no-config` leaves the whole file out - so
there is no opposite of either to be given beside it.

The same option twice is as it was, the ones that take no value and the
ones that do: `--root a --root b` reads `b`, and `--max 1 --max 0` shows
every finding. `tests/cli-options.test.ts` reads the options off `--help`
and holds each that has an opposite to the refusal, so a third pair cannot
be added without it.

**An option that takes one value takes one.** *Amended 2026-10-14.* The
paragraph above left the same option twice as it was, and for an option
that takes a value that was the later of two values read and the earlier
unread, which is what the rule it cites refuses. Measured on main at
b9da6ab, 0.16.0, through the launcher (Windows 11, Node 24.18.1): 211 runs
over two ADRs and an RFC, where one ADR cites an ADR and an RFC nobody
wrote, so the plain check exits `1` on two findings, one of each family.

| Given | 0.16.0 | Now |
| --- | --- | --- |
| `check --root nowhere --root .` | exit `1`, the check of `.`, and no word of `nowhere` | exit `2`, the line below |
| `check --root . --root nowhere` | exit `2`: `--root "nowhere" is not there` | exit `2`, the line below |
| `rules --root nowhere --root .` | exit `0`, the rules | exit `2` |
| `check --baseline nowhere.json --baseline base.json` | exit `0`, the findings accepted | exit `2` |
| `check --record-baseline one.json --record-baseline two.json` | exit `0`, `two.json` written | exit `2`, nothing written |
| `query --format sarif --format json` | exit `0`, JSON | exit `2` |
| `query --format json --format sarif` | exit `2`: `--format sarif` is a check's | the same |
| `diff --format json --format markdown`, `graph --graph-format dot --graph-format json` | the later format | exit `2` |
| `check --max 1 --max 0`, `--max-warnings 0 --max-warnings 5` | the later number | exit `2` |
| `check --rule broken-reference=off --rule broken-reference=error` | exit `1`, the later severity | exit `2` |
| Each of those with one value given twice | as the option once | the same |
| `--ignore`, `--ignore-ref`, `--history`, `--family`, `--ignore-family`, and `--rule` for two rules, each given twice | every value read | the same |
| `check --baseline nowhere.json --record-baseline out.json` | exit `0`, two findings recorded | exit `2`, nothing written |
| `--baseline` beside `--record-baseline`, either order, whatever the files | every finding recorded, the baseline never opened | exit `2` |
| `"baseline"` in the configuration, and `--record-baseline` | recorded | the same |
| `check --family ADR --ignore-family ADR`, either order | exit `0`, consistent | exit `2` |
| `check --family ADR --family RFC --ignore-family RFC` | exit `1`, as `--family ADR` alone | exit `2` |
| `check --family ADR --ignore-family RFC`, or `--ignore-family KEP` | as `--family ADR` alone | the same |
| Any row beside `--help`, `-h`, `--version` or `-v` | the help, the version | the same |

Seven options take one value: `--root`, `--baseline`, `--record-baseline`,
`--format`, `--graph-format`, `--max` and `--max-warnings`. Given two, each
is exit `2` and one line with both, in the order they were given:

```text
spec-graph: --root is given "nowhere" and ".", and takes one value: give one of the two
```

The same value twice is that value once, as an option that takes none is.
Values are compared as they were typed, so `--root . --root ./` is refused:
whether two spellings name one directory is a question for the disk, and
the line is what tells whoever wrote them. An option that is a list stays
one, each value read. `--rule` is a list of rules and gives each rule one
severity: the same rule twice with one severity is that rule once, and with
two it is refused, `--rule is given "broken-reference=off" and
"broken-reference=error", and a rule has one severity: give one of the two`.
`tests/cli-options.test.ts` reads the options off `--help` and holds each
one that takes a value to this, by whether its entry says "Repeatable".

**A baseline to read beside one to record.** A recording writes every
finding of the run and returns before any baseline is opened, so beside
`--record-baseline` the file `--baseline` names went unread, and one that
was not there, which alone is exit `2`, went unnoticed. The two are refused
together, whichever comes first:

```text
spec-graph: --baseline is given beside --record-baseline, and a check holds its findings against a baseline or records them as one: give one of the two
```

A `"baseline"` in the configuration is no option. `--record-baseline` over
it is how that file is made, and is taken as before.

**A family asked for and ignored.** The list that ignores is asked first,
so a family on both lists is passed over, and its name on the other says
nothing: `--family ADR --family RFC --ignore-family RFC` read as `--family
ADR` does. Where it is the only name on `--family`, every citation in prose
is passed over: `--family ADR --ignore-family ADR` printed `the
specification graph is consistent`, exit `0`, over a tree where either
option alone exits `1`. It is the run the first row of the 2026-10-09 table
describes, reached by two names that are each right. Given to both options,
a family is refused, in any case of its name:

```text
spec-graph: --family ADR is given beside --ignore-family ADR, and a family's citations are read or they are passed over: give one of the two
```

One family asked for and another ignored are both read, and are taken:
`--ignore-family RFC` beside `--family ADR` asks for what the list already
does, and beside a list that names a family not started yet it says which
family is left out on purpose, as the next section has it.

Each of the three refusals is made after an option of another command is
named, as the pairs above are, and `--help` and `--version` are answered
first. A value no option can take, `--format xml`, and a value that was
forgotten are said where they are met, as before.

What was measured and is as it was:

- Every other option beside `--record-baseline`. `--ratchet`, `--strict`,
  `--max`, `--max-warnings`, `--verbose` and `--format` are not read by a
  recording, which `--help` says of all of them at once, "exit 0 without
  judging them": that pairs an option with an option, as `--format json
  --max 3` does. A `--rule` is read: a rule turned off records nothing.
- A family on both lists where the configuration holds one of them.
  `--ignore-family RFC` over `"families": ["ADR", "RFC"]` is an option over
  the file. `--family RFC` over `"ignoreFamilies": ["RFC"]` still passes
  over every RFC, and so does a file that names RFC under both keys.
  Neither is two options, and neither is decided here.

**A list of families is held against the documents.** *Amended again
2026-10-09.* The amendment above refused a name no family can have and kept
`--family RFC` where the corpus has no such family: "a name a family can have
is taken at its word". Measured on main at dac6031, over the same two
ADRs: `check --family RFC`, `--family RFC --strict` and `--family ADRS` each
print `the specification graph is consistent` and exit `0`, where the plain
run exits `1`, and `--record-baseline` records no finding. It is the run the
table's first row describes, reached by a name that is one. A page of no
family that links to an ADR and an RFC nobody wrote goes the same way under
`--family KEP`: the list passes over every identifier of a family that is not
on it, written in brackets or in prose.

The family contract has a line for this: nothing measured is not clean
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
So where a list is in force, `--family` or `families`, and no document of the
corpus belongs to a family on it, a check ends with exit `2` before it reports
or records anything:

```text
spec-graph: no document here belongs to a family named by --family (RFC); the documents here belong to ADR
  name a family the documents belong to, or leave the list out
```

A document belongs to a family when its identifier is written with it, which
is the witness [ADR-0004](0004-reference-resolution.md) asks for before it
reads a citation in prose. Where one name on the list has documents and
another has none, the run says so on stderr and fails nothing:

```text
spec-graph: no document here belongs to RFC, named by --family; the documents here belong to ADR
```

That is a family the repository means to start, or a typo in half the list,
and the line is what tells the two apart for whoever reads it. A list whose
every name has a document sees no new line, which is the half
[ADR-0006](0006-false-positives-cost-more.md) cares about. A repository with
a list and no numbered document yet is refused with the rest: the list passes
over what it passes over there too, and it is left out until the first such
document is written.

*Amended 2026-10-12.* One name with no document, beside names that have
them, was a line on stderr whatever else the list did, and nobody had
measured whether what cites such a family is reported. Measured on main at
11e2895, through the launcher, over two or three ADRs and an RFC written for
it, where an ADR cites an RFC in prose:

| The corpus | The list | The citation | The run |
| --- | --- | --- | --- |
| ADRs, no RFC | none | `RFC-0001` | exit `0`, consistent |
| ADRs, no RFC | `ADR`, `RFC` | `RFC-0001` | exit `0`, consistent, and the line |
| ADRs and RFC-0001 | none, or `ADR`, `RFC` | `RFC-0099` | exit `1`, `broken-reference` |
| ADRs and RFC-0001 | `ADR`, `RFCS` | `RFC-0099` | exit `0`, consistent, and the line |
| The same, the RFCs ignored, outside the patterns, or moved away | `ADR`, `RFC` | `RFC-0099` | exit `0`, consistent, and the line |
| The same, the RFCs ignored | none | `RFC-0099` | exit `0`, consistent, no line |

`--strict` changes none of those rows, the JSON report of each passing one
has `"ok": true` and nothing of the line, and `--record-baseline` records no
finding. Under the mistyped list `--verbose` and the report's `suppressed`
show the citation as one of an ignored family; in the other passing rows
nothing names it. A reference made on purpose fares better, except under the
mistyped list. A path, a wiki link and a front-matter field that name RFCs
nobody wrote are each `broken-reference` where the list is `ADR`, `RFC`,
with the RFCs read or ignored; under `ADR`, `RFCS` only the path is, since a
list passes over every identifier of a family that is not on it, in brackets
and in front matter as in prose. Of four such references, one of them in
prose, the mistyped list reports one.

So a citation in prose of a family no document here belongs to is not
reported, and row against row the list is the cause of that once. With the
RFCs absent, ignored, outside the patterns or moved away, `ADR`, `RFC` and no
list at all give the same answer: the family is not one the corpus has, its
citations are prose either way, and the name costs the run nothing. The
fourth row is the one the list costs a finding: exit `1` without it, exit `0`
with it. What differs there is not that a name has no document. It is that
a family the documents do belong to has been left off the list, by a name
that stands where its own should.

So the check stops, exit `2` before anything is reported or recorded, where
the list names a family no document here belongs to and leaves out a family
the documents do belong to. The line names both, since one is most likely
meant for the other:

```text
spec-graph: no document here belongs to RFCS, named by --family; the documents here belong to ADR and RFC, and the list leaves out RFC
  name each family as its documents do, or leave it off the list until its first document is written
```

Where every family the corpus has is on the list, a further name with no
document is said as it was, and fails nothing: the run reads what it would
read without the list.

```text
spec-graph: no document here belongs to RFC, named by --family; the documents here belong to ADR
```

The wider rule, every name with no document refused, was built first and
not taken. It stops a repository that lists a family before its first
document, and a run over part of a repository whose configuration lists the
families of all of it. Neither loses a finding to the list, and a check that
stops a correct run is the one
[ADR-0006](0006-false-positives-cost-more.md) is about. A list no document
belongs to at all is refused as it was: there nothing is read.

The rule was held against two neighbours. A family on `--ignore-family` or
`ignoreFamilies` was taken out on purpose and is not one the list leaves
out: `--ignore-family RFC` beside `ADR`, `RFCS` passes over what it passes
over with no list, exit `0` both ways and the same report, and is said and
not refused. A list that is narrower on purpose, `--family ADR` over ADRs
and RFCs, has no name without a document, so there is nothing to refuse and
no line. Where such a list also names a family not started yet, `ADR`, `RFC`
and `PRD` over ADRs, RFCs and KEPs, the run cannot tell `PRD` from a name
meant for `KEP` and stops; `--ignore-family KEP` says the KEPs are out on
purpose, and the name is then said and fails nothing.

`--ignore-family` gets no such rule. A name on it passes over citations of
that one family, so a mistyped name passes over nothing and the run reports
more: `--ignore-family RCF` over those two ADRs exits `1`, as the plain run
does. A name that is right, and covers every family the corpus has, is what
was asked for by name.

**An option belongs to the commands that read it.** *Amended again
2026-10-09.* The same amendment kept "an option the command does not read",
since "the run writes what the command writes, whatever the option". Measured
on main at dac6031, twenty-three options against the five commands: of 115
pairings 2 were refused, and 64 pair a command with an option it never reads,
each of which ran exactly as without the option. `query --strict` was no
stricter, `graph --record-baseline new.json` wrote no file and said nothing,
and with the command forgotten, `spec-graph --graph-format mermaid` wrote the
check's report into whatever was to hold the graph. spec-guard refuses such an
option for the reason that holds here: taking the flag and doing nothing with
it tells someone their query was strict. Those 64 are refused now, by the
command, naming the option and the commands that do read it: `--graph-format
belongs to graph, not to check`.

| Option | Read by |
| --- | --- |
| `--root`, `--verbose` | `check`, `query`, `graph`, `rules` |
| `--ignore`, `--history` | `check`, `query`, `graph` |
| `--format` | `check`, `query`, `diff` |
| `--graph-format`, `--documents-only` | `graph` |
| `--explain` | `rules` |
| `--ignore-ref`, `--family`, `--ignore-family`, `--baseline`, `--record-baseline`, `--ratchet`, `--rule`, `--strict`, `--max`, `--max-warnings`, `--color` | `check` |
| `--no-config`, `--no-color`, `--ascii` | every command |

The last row is not leniency. Each of the three is true already of a command
with nothing to read it for - only a check's report has colour or glyphs, and
`diff` reads no configuration - and a script passes them to every command it
runs. `--color` is not among them: it would promise colour. The three options
about citations are a check's alone, because they pass over findings and never
an edge ([ADR-0008](0008-wiki-links-carry-no-path.md)): a graph and a query
are the same with them as without. The tests that held that by exporting a
graph under `--ignore-ref "*"` hold it now through the configuration file,
which is no option, and which every command reads as it did.

What a *format* does not read is still taken: `check --format json --max 3`,
or `--no-color` beside `--format sarif`. That pairs an option with an option,
and a caller that asks for JSON passes `--no-color` beside it, as spec-harness
does of spec-brief.

**A value that begins with `--` is the next option.** *Amended again
2026-10-09.* `--ignore --strict` ignored a directory called `--strict` and
left the check unstrict, `--history --verbose` took a file of that name for a
journal, and `--record-baseline --verbose` wrote one. The amendment above
caught this for `--family` and `--root` by what each checks; every option that
takes a value now refuses it in the same words, `--ignore needs a value, and
--strict reads as an option`, and so for `-h` and `-v`. No option needs such a
value: a name that does begin with two dashes is written `./--name` for a
file, `[-]-name` in a pattern and `\--name` for a reference target, each
measured to name what it should. One dash is left alone: `--max -1` has its
own line, and `-drafts` is a name.

An empty name given to `diff` resolved to the directory the run was started
in, and the refusal was the read's, `cannot read : EISDIR`. It is `diff
expects a graph export on each side, got "" for the first`.

**A value is compared as it is read, and a wrong line is wrong beside
`--help`.** *Amended 2026-10-18.* The amendment of 2026-10-14 compared two
values as they were typed, and answered `--help` and `--version` before
every refusal made once the line was read. The family's contract was
amended the other way on both, and on a third thing
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
2026-10-18). Measured on main at 4574727, 0.17.0, through the launcher
(Windows 11, Node 24.18.1), over an ADR that cites an ADR and an RFC nobody
wrote, beside an RFC, so the plain check exits `1`:

| Given | 0.17.0 | Now |
| --- | --- | --- |
| `check --root . --root ./`; `docs` beside `docs/`, `./docs`, `docs/adr/..` or its absolute path | exit `2`: `--root is given "." and "./"` | exit `1`, the check of the one directory |
| `--baseline held.json --baseline ./held.json`, and the same of `--record-baseline` | exit `2` | the run with the one file |
| `--max 1 --max " 1"`, `--max-warnings 0 --max-warnings " 0"` | exit `2` | the run with the one number |
| `--root docs --root DOCS`, `--root nowhere --root .` | exit `2` | the same |
| `--format json --format JSON`, `--rule broken-reference=OFF` | exit `2`, a value no option takes | the same |
| A pair, two values, the baseline pair or a family asked for and ignored, beside `--help`, `-h`, `--version` or `-v` | the help, the version | exit `2`, the line each has without them |
| An option of another command, `--format sarif` or `markdown` of a query, `--format json` of `graph`, `rules a b`, `diff` given three exports or an empty one, beside the same | the help, the version | exit `2`, the same |
| `--help --version`, `--version --help`, `-h -v`, `-v -h` | the help | exit `2`, the line below |
| `--help -h`, `--version -v` | the help, the version | the same |
| `check --help --bogus`, `--format xml --help`, `--root "" --help` | exit `2` | the same |
| `query --help`, `diff --help`, `diff a.json --help` | the help | the same |
| `check --root nowhere --help`, `rules no-such-rule --help` | the help | the same |

Two values are compared as the run reads each. A path is resolved with
Node's `path.resolve` from the directory the line was typed in, which is
where a relative `--root` is read from. A baseline typed on the line is
resolved from the root a `--root` names, wherever on the line that stands,
and from where it was typed otherwise, which is where the run opens it
([ADR-0018](0018-the-configuration-file-is-the-root.md)). The two resolved
paths are compared as text, and the disk is not asked, so a directory and
a link to it are two values. No case is folded: measured on Node 24.18.1,
`path.resolve` keeps a drive letter as it was typed, `c:\x` as `c:\x`, so
`docs` beside `DOCS`, and a drive letter in two cases, are refused on a
disk that would read them as one. A count is the number it reads as, past
the spaces a shell variable brings.
`--format`, `--graph-format` and the severity of a `--rule` are read as
they are written, so for them reading is typing. Where two values differ the
line names both as they were typed, as before; where one value is spelled
two ways the run is the one either spelling asks for.

A refusal the command line makes of itself is made with `--help` or
`--version` on the line, as one of an option nobody knows always was:
answered first, the help told a script nothing of the line it wrote, and
the version answered as if the line were right. The contract's amendment
has spec-graph answering the help first for the refusals 0.15.0 to 0.17.0
added, and only for those; measured, it did so for every refusal made once
the line was read, the older ones in the table's seventh row among them,
and those are refused beside it as well. Two things are still answered.
What a command lacks, a selector or a second export, is what the help is
asked for, and a person types `diff --help` before knowing that it takes
two. And what only the run reads, a `--root` that is not there or a word
after `rules` that names no rule, is no fault of the line until the disk or
the configuration is read, and the help reads neither.

`--help` beside `--version` asks for two answers of which one would go
unread, and is refused, whichever comes first and however either is
spelled:

```text
spec-graph: --help is given beside --version, and a run prints the help or the version: give one of the two
```

The line names the help first, as the line for a pair names the option
that turns a thing on. It is said after an option of another command and
before a pair, and either of the two given twice is that one once.

Those are input refused that was accepted, beside input taken that was
refused, and arrive in a minor release.

**A flag and a file that disagree, and what a recording reads.** *Amended
again 2026-10-18.* The amendment of 2026-10-14 left two things measured
and undecided: a family on both lists where the configuration holds one of
them, and every option a recording does not read, which it took as an
option beside an option. Measured on main at 4574727, 0.17.0, through the
launcher (Windows 11, Node 24.18.1), over an ADR that cites an ADR and an
RFC nobody wrote, beside an RFC, so the plain check exits `1` on two
findings, and over a live ADR beside a retired one under `docs/archive`
that holds an open question and a link to nothing:

| Given | 0.17.0 | Now |
| --- | --- | --- |
| `--family RFC` (or `rfc`) over `"ignoreFamilies": ["RFC"]` | exit `0`, consistent: the RFC asked for passed over | exit `1`, the RFC nobody wrote |
| `--family ADR` over the same | exit `1`, the RFCs passed over | the same |
| `--ignore-family ADR` over `"families": ["ADR"]` | exit `0`, consistent | the same |
| `--ignore-family RFC` or `ADR` over `"families": ["ADR", "RFC"]` | exit `1` | the same |
| `"families": ["RFC"]` beside `"ignoreFamilies": ["rfc"]` | exit `0`, consistent | exit `2`, a problem in the configuration, for every command |
| `"families": ["ADR", "RFC"]` beside `"ignoreFamilies": ["RFC"]` | exit `1`, the RFCs passed over | exit `2`, the same |
| `--record-baseline` beside `--format json` | exit `0`, the line `recorded 2 findings as 2 entries in b.json` | exit `0`, a JSON document |
| The same beside `--format sarif`, `github` or `gitlab` | exit `0`, the line | exit `2`, nothing written |
| The same beside `--format human` or `markdown` | exit `0`, the line | the same |
| The same beside `--ratchet`, `--strict`, `--max 1`, `--max 0`, `--max-warnings 0`, `--color` or `--no-ascii` | exit `0`, recorded as without it | exit `2`, nothing written |
| The same beside `--verbose` | exit `0`, and `configuration: .spec-graph.json` on stderr where a file was read | the same |
| The same beside `--no-color`, `--ascii`, `--rule broken-reference=off`, `--family ADR` or `--ignore-ref RFC-0099` | exit `0`, recorded as the option reads | the same |
| `--ignore archive --history "docs/archive/**"`; `--ignore "docs/archive/**"` or `"**/JOURNAL.md"` beside the same journals | exit `0`, consistent, and no journal read | exit `2`, the line below |
| `--history "docs/archive/**"` over `"ignore": ["archive"]` | exit `0`, consistent | exit `2` |
| `"historyPatterns": ["docs/archive/**"]` under `--ignore archive` | exit `0` | the same |
| `--history "docs/nothing/**"`, which matches no file | as without it | the same |
| `check --format json --max 1`, `check --format sarif --color` | exit `1`, the document | the same |

**A flag says what the run does where the file says otherwise**, for the
two family keys as for every other. The list that ignores is asked first,
so `--family RFC` over `"ignoreFamilies": ["RFC"]` passed over every RFC it
asked for, and reported a consistent graph where the file alone fails the
check: a family a flag asks for is now taken off the file's list of those
to pass over, in any case of its name. The other way round the flag already
decided. `--ignore-family ADR` over `"families": ["ADR"]` passes over the
ADRs and leaves the list nothing it allows, which is what the flag asks:
a name on `--ignore-family` that covers every family the corpus has is
asked for by name (the amendment of 2026-10-12).

**One file that names a family under both keys is a broken configuration.**
The list that ignores decided there too, and the name under `"families"`
read as applied and did nothing, as `--family ADR --ignore-family ADR` did
on the command line. It is a problem of the file, exit `2` before anything
is read, for every command, in the words the command line has:

```text
spec-graph: .spec-graph.json: "RFC" is in both "families" and "ignoreFamilies", and a family's citations are read or they are passed over: take it off one of the two
```

**A recording reads what chooses the findings, and refuses what would judge
or show them.** It writes every finding of the run down and judges none,
shows none and colours nothing. `--ratchet`, `--strict`, `--max`,
`--max-warnings`, `--color` and `--no-ascii` beside `--record-baseline` are
refused, whichever comes first, as `--baseline` is:

```text
spec-graph: --strict is given beside --record-baseline, and a recording writes the findings down and reports none: give one of the two
```

`--max 0`, no limit, is refused with the rest: it says how many findings
are shown, and a recording shows none. `--format sarif`, `github` and
`gitlab` are refused the same way, naming the format: each is a report of
findings, and what a recording wrote in its place was the line, which is
none of the three. A document asked for is a document: `--format json`
writes what was recorded,

```json
{ "version": 1, "recorded": { "file": "b.json", "findings": 2, "entries": 2 } }
```

with no `ok`, since a recording judges nothing; `--format markdown` writes
the line, which is Markdown already, and `human` the line as before.
`--verbose` is read, since a recording names the configuration it read
under it as every command does; `--no-color` and `--ascii` ask for what is
already so; and `--rule`, the families and the ignores choose what is
recorded. The rule for a format of a check stays as it was: `--format json
--max 3` pairs an option with an option, and the report is written.

**A journal an ignore leaves out is refused.** A `--history` pattern marks
the files a run reads, so one whose files an ignore leaves out marked
nothing and said nothing: the archive's open question was not checked as
an obligation, which is what `--history` is for, nor was its link checked,
which is what `--history` keeps. Beside `--ignore` one of the two goes
unread, and over the file's `"ignore"` the flag cannot say what the run
does, which is asked for and not delivered (spec-core's ADR-0005,
2026-10-09). A pattern typed on the line that matches no file the run
reads, and matches one the patterns reach once every ignore is set aside,
stops the run with exit `2`, for each command that reads `--history`:

```text
spec-graph: --history "docs/archive/**" names only files --ignore leaves out, and a journal is read or it is left out: give one of the two
```

The line names the ignores there are, `--ignore`, `"ignore" in
.spec-graph.json`, or both joined by `or`, and not which of them left the
files out: telling them apart is one more walk for each. The walk that
finds it is made once, only for a pattern that matched nothing read. A
pattern that matches no file at all, a typo or a journal not written yet,
is read as before, which is the question the family contract left open for
a pattern of several (2026-10-11), and a pattern some of whose files are
read is read for those. `"historyPatterns"` in the file under an `--ignore`
is the flag deciding, and the files are left out.

The recording's refusals are ones the command line makes of itself, so
each is made with `--help` or `--version` on the line too, as the
amendment above has it: `--record-baseline debt.json --strict --help` is
refused, and `--record-baseline debt.json --format json --help`, which
asks for nothing a recording leaves unread, prints the help. A journal an
ignore leaves out is the run's to find, once the walk is made, and the
help reads no disk: `--ignore archive --history "docs/archive/**" --help`
prints the help, as `--root nowhere --help` does.

Those are input refused that was accepted, and a check that passed that
can fail, so they arrive in a minor release.

**A path is read from where the line was typed, a drive letter names its
volume in either case, and a `\` is a separator wherever the run starts.**
*Amended 2026-10-19.* The amendment of 2026-10-18 compared two values of
`--root`, `--baseline` and `--record-baseline` as Node's `path.resolve`
reads each from the directory the line was typed in, folding no case, and
three readings of a path were left as they were. Measured on main at
29c7b8a, 0.18.0, through the launcher on Windows 11 (Node 24.18.1) and in
a `node:24-slim` container (Node 24.21.0), and through `main` with a `cwd`
of its own, over an ADR that cites one nobody wrote, so the plain check
exits `1`:

| Given | 0.18.0 | Now |
| --- | --- | --- |
| `main({ cwd })`, Node in another directory that has a clean `docs`: `check --root docs` | exit `0`, the other `docs` checked | exit `1`, the caller's |
| The same, where Node's directory has no `docs` | exit `2`, `--root "docs" is not there` | exit `1` |
| The same, `--root docs --record-baseline rec.json` | written into the other `docs` | written into the caller's |
| The same, `rules --root .` | no project rule: the other directory's configuration | the caller's project rules |
| The same, `--root <the caller's docs, absolute> --root docs` | taken as one, and the other `docs` checked | taken as one, the caller's checked |
| `main({ cwd: 'docs' })`, Node in the repository, no `--root` | no configuration: the walk stopped at `docs` | the repository's |
| Windows: `--root C:\x --root c:\x`, in either order; the same of `--baseline` and `--record-baseline`; `C:docs` beside `c:docs` | exit `2`, two values | taken as one |
| Windows: `--root C:\x --root c:\x --help` | exit `2` | the help |
| Windows: `--root C:\x --root C:\X` | exit `2` | the same |
| Linux: `--baseline 'sub\held.json'` typed at the root | the file `sub\held.json`, and exit `2` where there is none | `sub/held.json` |
| Linux: `--baseline '../sub\held.json'` or `'..\sub\held.json'` typed one directory down | `sub/held.json` | the same |
| Linux: `--baseline 'sub\held.json' --baseline sub/held.json` | exit `2`, two values | taken as one |
| Linux: `--record-baseline 'out\b.json'` at the root | the file `out\b.json` written | `out/b.json`, and exit `2` where `out` is not there |
| Linux: `"baseline": "sub\\held.json"` in the configuration | the file `sub\held.json` | `sub/held.json` |
| Linux: `--root '.\docs'` beside a directory of that name | asked of the disk as `.\docs`, walked as `./docs` | `./docs` for both |
| The launcher, and `main` with no `cwd` | from the working directory | the same |

**`cwd` is where the line was typed.** `main` takes the directory a line
was typed in as `cwd`, and the launcher gives the process's own. The
comparison of two values read from there, and the run did not: `stat`,
the configuration and the walk were handed the root as it was typed, which
Node reads from its own directory. So a caller's `--root docs` checked
another tree's `docs`, recorded a baseline into it, and was not there where
that directory had none. The root is resolved from `cwd` now, once, before
anything is read, and so is the directory the walk for a configuration
starts from. A `cwd` that is itself relative is read from Node's
directory, as every relative path is, so that walk goes up to the
repository as it would from that directory, where it stopped at the top
of the relative path and read no configuration above it. A root that was
named is still named as it was typed in what the run says of it.

**A drive letter names its volume in either case**, on Windows, as the
family's contract has it
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md),
2026-10-19). `path.resolve` keeps the case a drive letter was typed in, so
the comparison folds the letter, at the start of the resolved path or after
`\\?\` or `\\.\`, before it compares two values. Past the letter it
compares as before, `C:\x` beside `C:\X` refused: the contract leaves it to
the disk whether two names are one directory. Node resolves a path on any
other host to one that starts with `/`, so nothing is folded there, and
`C:x` beside `c:x` on Linux are two relative names, refused as two.

**A `\` in a root or a baseline is a separator, wherever the run starts.**
A baseline typed below the root was joined to it with each `\` read as a
`/`, one typed at the root was read as typed, and the configuration's was
read as typed too, so on Linux `sub\held.json` at the root named a file of
that name and `..\sub\held.json` one directory down named `sub/held.json`.
The comparison kept the `\` in both, so two values it refused as two were,
below the root, one file. A root was asked of the disk as typed and walked
with each `\` a `/`, so `--root '.\docs'` passed the check that it is a
directory on one directory and checked another. A `\` is a separator now
in every root and baseline the run reads, typed or configured, as it was
in an absolute baseline and is in a pattern
([ADR-0022](0022-globs-are-the-family-path-dialect.md)), and the comparison
reads each so. Windows reads a `\` as a separator itself, so nothing it
reads changes; on Linux a file or directory whose name holds one cannot be
a root or a baseline, as it cannot be named by a pattern.

Those are input taken that was refused, and runs that read another
directory or file than they did, so they arrive in a minor release.

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

- [x] Should configuration be discovered upward from the working directory
  rather than read from `--root`? **Resolved (2026-09-13):** yes, and the
  worry recorded here pointed the wrong way.
  [ADR-0018](0018-the-configuration-file-is-the-root.md) has it: reading
  configuration from the working directory is *already* a run that depends
  on where it started, and silently so - `cd packages/auth && spec-graph
  check` found no configuration, ran no project rules, used the default
  include patterns and printed a verdict in the same shape as the real one.

  What makes discovery the more deterministic answer rather than the less is
  that the directory holding the file becomes the **root**. Every path here
  is relative to the root, so a run from anywhere inside the repository
  produces byte-identical output to a run from the top. It is a flag in the
  sense this question asked for, inverted: `--root` is how a caller turns
  discovery off.
- [x] Named queries from ADR-0005 still have no home.
      **Resolved (2026-09-12):** they live here, under `rules`. The larger
      design is [ADR-0016](0016-a-query-needs-a-sentence.md); what this file
      contributes is the one thing it was always going to - a place a repository
      can write down what is true of itself.

## See also

- [ADR-0004](0004-reference-resolution.md) - the corpus-family witness these
  rules refine rather than replace.
- [ADR-0008](0008-wiki-links-carry-no-path.md) - the same
  suppresses-findings-never-edges guarantee.
- [ADR-0018](0018-the-configuration-file-is-the-root.md) - how this file is
  found, and why finding it decides where the repository starts.
