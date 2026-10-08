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
