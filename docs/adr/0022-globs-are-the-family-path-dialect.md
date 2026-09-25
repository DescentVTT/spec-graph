---
status: accepted
date: 2026-09-26
---

# ADR-0022: Globs are the family's path dialect

## Context

spec-graph wrote its own glob matcher, and so did spec-brief and spec-guard.
By 2026-09-24 the three disagreed in ways a user of more than one could see:
`src/**` matched `SRC/A.ts` in spec-graph on Windows and nowhere else, `**`
inside a segment crossed directories in two of them, and an unclosed `[` was a
literal in one and an error in another. The tools are used together, often on
one repository in one pipeline, so each disagreement is a scope that means one
thing to the tool that writes a brief and another to the tool that checks it.

spec-core now holds one engine for all of them: three named dialects over one
automaton that cannot backtrack
([spec-core's ADR-0003](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0003-glob-dialects.md)),
copied into each tool byte for byte and checked by hash
([spec-core's ADR-0001](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0001-one-core-copied-by-hash.md)).
The family contract says a path is compared case-sensitively on every host,
because a result must not depend on the machine it ran on
([spec-core's ADR-0005](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0005-the-family-contract.md)).
spec-graph broke that twice, in a function whose own comment said it must not:
a glob folded case where the filesystem did, and a pattern with no glob syntax
in it was compared lower-cased on every host, Linux included.

## Decision

**Every path pattern spec-graph reads is spec-core's `path` dialect,
case-sensitive on every host.** The patterns to check, `--ignore`, `--history`
and `historyPatterns` are compiled by `src/vendor/spec-core/pattern/`, with a
literal read as a file or a directory and everything beneath it, and a `\` read
as a separator, which is what both have always meant here.

What stays spec-graph's is what was never a question of syntax:

- **The list.** Patterns are read in order, the last to match decides, and a
  leading `!` takes a path back out, as a `.gitignore` does.
- **The walk.** Which directories are never entered (`node_modules`, `dist`
  and fifteen others), how big a file may be, and that a bare `--ignore` name
  prunes that directory at any depth.
- **Reference targets.** `--ignore-ref` is matched against what a document
  wrote, not against a path, so it keeps its own reading on the same engine: a
  bare pattern matches the target exactly, case is ignored on every host by
  simple case mapping, a `\` escapes, and `.` and `..` are text -
  `../../notes/gone.md` is a link somebody may want left alone.

### What a user sees change

Each of these is a difference between the reading before and after, found by
running both over a generated corpus (`tests/glob.test.ts`), and nothing else
differs:

| pattern | before | now |
| --- | --- | --- |
| `Docs/**` against `docs/a.md` | matched on Windows | never matches |
| `README.md` against `readme.md` | matched on every host | never matches |
| `docs/**.md` against `docs/adr/a.md` | matched: `**` crossed directories anywhere | `**` inside a segment is `*` |
| `docs/[draft.md` | a literal `[` | refused: `a "[" is never closed` |
| `docs/draft*/` | `docs/drafts` itself | what is in `docs/drafts` |
| `docs/` | `docs` and what is in it | what is in `docs` |
| `{docs,specs}` | a file named `docs` or `specs` | those two directories and what they hold |
| `a[!b]c` against `a/c` | matched: the class took the `/` | a class never matches a separator |
| `[^a]` | `^` or `a` | anything but `a`, as `[!a]` is |
| `.`, `./`, `docs/..`, `../other/**` | read, and matched nothing or climbed out | refused: a pattern names a path under the root |

A pattern that does not compile is refused the way a malformed `{` already
was: the run stops with exit `2` and the pattern named, whether it came from
the command line or the configuration file.

**The walk finds a directory only as it is spelled on disk.** It starts at
each pattern's literal prefix, and on a filesystem that ignores case,
`readdir('Docs')` lists `docs`: every file under it came back spelled
`Docs/...` - a node id, a baseline key - and matched. Each directory of a
prefix is now looked up by name in its parent. A prefix rooted at `/` names
something outside the repository and is not walked; it used to be read as the
root's own directory and reported as `/docs/...`, a path no node can have.

**A `..` typed below the root is resolved where it was typed.** A pattern may
no longer climb out of its root, and `cd docs/deep && spec-graph "../*.md"` is
not doing that: it names the root's `docs/*.md`, and re-anchoring it
([ADR-0018](0018-the-configuration-file-is-the-root.md)) is the one place that
knows both halves. A `..` that climbs past the root is still refused.

`globToRegExp` stays exported, deprecated, as the record of the old reading
that the differential test compares against. It no longer folds case on
Windows either. `compileGlob` keeps its signature and its `ignoreCase` option,
which is now off unless asked for on every host.

## Alternatives

| Option | Why not |
| --- | --- |
| Keep spec-graph's matcher and fix its case rule | The other differences stay, and the next tool to adopt a scope would inherit a fourth reading. |
| Adopt the dialect but keep folding case on Windows | The contract is the point: a baseline recorded on a Windows checkout would not hold in Linux CI. |
| Read `--ignore-ref` in the path dialect too | It refuses `..`, and a relative link is where `..` is most often written. |
| Read `\` in a path pattern as an escape, the dialect's default | spec-graph has always read a pattern typed on a Windows shell as a path, and an escape was never part of its syntax. |

## Consequences

A repository that relied on any row of the table above sees it in its first
run: a file that was checked and is not, which `--verbose` lists as the files
read, or a pattern refused with exit `2` and named. The case rows are the
likeliest, and they are exactly the ones that made the same repository give
two answers.

A change to the dialect is made in spec-core, reviewed there against all three
tools, and arrives here as a diff to the copy. spec-core's sweep measures the
engine; this repository's measures the list, the walk and the reference filter
around it.

## Verification

`tests/glob.test.ts` rebuilds the 0.8.0 matcher on the deprecated
`globToRegExp` and runs it beside the new one over 400 patterns - generated from
spec-core's differential pieces, plus case, `[^`, a backslash and negation -
against every path of a small alphabet. Every difference must fall into one of
the rows above, and every row must occur, so the table is neither shorter nor
longer than what happens. The first row is the host's and not the pattern's,
so it cannot occur in one process; it and each of the others has a test of its
own by name.

## Open Questions

- [ ] Should `paths.ts` give way to spec-core's `path` module, which the copy
      already carries because `pattern` may import it? The two agree on what
      spec-graph asks of them, and nothing has needed the difference.
- [ ] Should the check that tells a broken link from one outside the corpus
      stop folding case? It is not a glob, it is host-independent already, and
      it decides only which of two findings a link that exists nowhere gets.

## See also

- [ADR-0017](0017-a-predicate-must-finish.md) - why a pattern is matched by an
  automaton at all, and where the matcher behind `~=` went.
- [ADR-0018](0018-the-configuration-file-is-the-root.md) - re-anchoring a
  pattern typed below the root.
- [ADR-0011](0011-a-record-is-not-a-specification.md) - `historyPatterns`, which
  read the new dialect like every other path pattern.
