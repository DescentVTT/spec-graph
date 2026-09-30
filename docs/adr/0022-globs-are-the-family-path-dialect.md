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
  `../../notes/gone.md` is a link somebody may want left alone. The rows of
  the table below about syntax - `**`, an extended glob, `[`, a trailing `/`,
  classes, the empty pattern - apply to it as well, and a pattern of spaces is
  empty once trimmed. `a//b` reads as `a/b`, and two more things are refused: a
  `\` before a letter or digit or at the end, and a leading `!`, which were
  literals here and are malformed in every dialect.

### What a user sees change

Each of these is a difference between the reading before and after, found by
running both over a generated corpus (`tests/glob.test.ts`), and nothing else
differs:

| pattern | before | now |
| --- | --- | --- |
| `Docs/**` against `docs/a.md` | matched on Windows | never matches |
| `README.md` against `readme.md` | matched on every host | never matches |
| `docs/**.md`, `**.ts`, `a**b` | `**` crossed directories wherever it was written | refused: `**` is a whole segment - for `docs/**.md`, `docs/**/*.md` for any depth or `docs/*.md` for one level |
| `docs/+(a\|b).md` | the literal text `+(a\|b)` | refused: an extended glob - `{a,b}` for alternatives, `[(]` for a parenthesis |
| `docs/[draft.md` | a literal `[` | refused: `a "[" is never closed` |
| `docs/draft*/` | `docs/drafts` itself | what is in `docs/drafts` |
| `docs/` | `docs` and what is in it | what is in `docs` |
| `{docs,specs}` | a file named `docs` or `specs` | those two directories and what they hold |
| `a[!b]c` against `a/c` | matched: the class took the `/` | a class never matches a separator |
| `[^a]` | `^` or `a` | anything but `a`, as `[!a]` is |
| `.`, `./`, `docs/../specs`, `../other/**` | read as nothing, resolved, or walked outside the root | refused: a pattern names a path under the root |
| `""`, in any list | read as nothing, or dropped | refused: `the pattern is empty` |

*Amended 2026-09-28.* A trailing `/` on a brace alternative means what it
means on the whole pattern, as spec-core reads it from f9ce375:
`{docs/,specs}` is what is in `docs`, or `specs`, and
`docs/{adr/,rfcs/*.md}` what is in `docs/adr`, or `docs/rfcs/*.md`. The
slash was read only at the end of the whole pattern, so inside braces it was
dropped, and `docs/` there was the literal `docs`: a file of that name, or
the directory and what it holds. Three things change, in the patterns to
check, `--ignore`, `--history` and the configuration alike. A file with the
alternative's name is no longer matched: `{notes/,docs/*.md}` reads no file
called `notes`. The walk starts inside the directory, as it does for
`docs/vendor/`, so `docs/{vendor/,adr/}` reads `docs/vendor`, which a walk
started at `docs` pruned. And `--ignore-ref "{docs/,x}"` passes over the
targets under `docs/`, as `--ignore-ref docs/` does, where it passed over the
target `docs` alone.

A pattern that does not compile is refused the way a malformed `{` already
was: the run stops with exit `2` and the pattern named, whether it came from
the command line or the configuration file.

*Amended 2026-09-28.* One refusal did not name its pattern: a pattern too
large to compile, past the 65,536 states spec-core's automaton holds.
spec-core threw it as an `AutomatonTooLarge` rather than giving it as a
reason, so the run stopped with exit `2` on `spec-graph: the pattern compiles
to more than 65536 states`, whichever pattern it was, and a program calling
`analyse`, `walkFiles`, `createGlobMatcher`, `compileGlob`,
`createReferenceFilter` or `globBase` caught an `AutomatonTooLarge` where
every other refusal is an `invalid glob` error. From spec-core f9ce375 it is
refused as the rest are: `invalid glob "<pattern>": the pattern compiles to
more than 65536 states`. Braces that expand to more than 256 patterns were
refused that way already.

*Amended 2026-09-29.* A brace alternative that names no path is refused, as
the same text written alone is, from spec-core 56c7e54. `./` alone was
refused, but inside braces its slash was read first, as the contents of `.`,
so `{./,docs}`, `{docs,./}`, `{.//,docs}` and `.{/,docs}` matched every path:
as patterns to check they read every Markdown file in the repository, as an
`--ignore` they took every one out, as a `--history` pattern they made every
document a record, and as an `--ignore-ref` they passed over every reference
target - `--ignore-ref` reads a `.` segment as text only outside braces.
Each is now `invalid glob "{./,docs}": the braces expand to "./", which
names no path`, and the refusals that already happened name the alternative
too: `{/,docs}`, `{//,docs}` and `{.,docs}` say `the braces expand to "/",
which names no path` and the like, where they said `the pattern names no
path` of a pattern that names `docs`, and `{,docs}`, `{docs,}` and `{}` say
`the braces expand to an empty pattern`. Outside braces, `/./` and `/.//`
are refused as `/.` is: they matched every rooted path, which no path the
walk finds is. A `./` beside a name still counts for nothing: `docs/{./,adr}`
is `docs/` or `docs/adr`, and `{./docs,specs}` is `docs` or `specs`. Such a
pattern is refused as the list is compiled, before the walk compiles each
positive pattern again to be told the literals it names, and before any
directory is read.

*Amended 2026-09-29.* **`--ignore-ref` reads a `.` or `..` in a brace
alternative as text, as it reads one anywhere else.** It escaped them
segment by segment before the dialect expanded the braces, so a dot inside
braces was never a segment it saw: `docs/{.,x}` passed over the target
`docs` where `docs/.` passes over `docs/.`, `{./docs,x}` over `docs` where
`./docs` passes over `./docs`, and `docs/{x,..}`, `{../notes/*.md,x}`,
`{.,docs}`, `{./,docs}` and `.{/,docs}` were refused, as climbing out of the
root or naming no path, where each alternative written alone is text. A dot
is now escaped wherever an alternative may make it a segment - beside a
brace or a comma as well as between separators - so each alternative reads
as it does written alone: `docs/{.,x}` passes over `docs/.` and `docs/x`,
and `{./,docs}` over the targets under `./` and the target `docs`, as `./`
and `docs` do; never every target, as it did before 56c7e54 refused it. A
dot the braces leave inside a name, as in `.{/,docs}`'s `.docs`, is the
same character escaped or not, and a dot that cannot be a segment is not
escaped, so the advice for a `**` inside a name still reads as typed. A `\`
escapes inside braces as outside, as it did. The path patterns are
unchanged: `{./,docs}` is refused there.

*Amended 2026-09-29.* **A refused `--ignore-ref` pattern is advised as it
was typed.** The dialect writes its advice for a `**` inside a name from the
text it is given, and the filter gave it the pattern with its dots escaped:
`../notes/**.md` was told `\.\./notes/**/*.md` or `\.\./notes/*.md`, and
`{../notes/**.md,x}` was told `{\.\./notes/**/*.md,x}`, advice that typed
back is another pattern. A refusal is now worded again from the pattern as
typed, with a character it does not hold standing in for each escaped dot
and read back as the dot: `../notes/**/*.md` or `../notes/*.md`, inside
braces as outside. A `\` the writer typed stays in the advice, as it did,
and so does the pattern named in the first clause. With the advice worded
from what was typed, the filter escapes each dot that may begin a segment
rather than each whole `.` or `..` segment: an escaped dot is the character
a dot in a name is, and the two readings agree on 43,069 generated patterns,
on what each matches and on every refusal. What a pattern matches, and which
patterns are refused, is as it was.

*Amended 2026-09-29.* **A leading `/` on a brace alternative means what it
means on the pattern written alone**, from spec-core 7e41240: braces expand
before a leading slash is read. The pattern's own slash was read before the
braces expanded and an alternative's after, as an empty segment, which names
nothing, so `{/docs,x}` read `docs`. As a pattern to check it read `docs`,
and a directory the walk skips when the alternative named it, since the walk
was told of the literal: `{/dist,docs}` read `dist`. As an `--ignore` or a
`--history` pattern it took out, or made records of, what is in `docs`. And
`--ignore-ref "{/docs/a.md,x}"` passed over the target `docs/a.md` and not
`/docs/a.md`. An alternative with a leading slash is now rooted at the
filesystem's root, as `/docs` is, so as a path pattern it names nothing the
walk finds: its starting point is not walked, and the walk is told of
`/dist`, which is no directory it meets. As an `--ignore-ref` it names the
target `/docs/a.md`, the text a link wrote, as `/docs/a.md` does.
`globBase("{/docs/*.md}")` is `/docs`, as `globBase("/docs/*.md")` is. A `/`
before the braces roots every alternative, as it did; one after a segment
starts no text the braces give, `docs/{/adr,x}` being `docs//adr`, which is
`docs/adr`; and `{/,docs}` is refused as it was.

Typed in a directory below the root, a pattern is still re-anchored whole
([ADR-0018](0018-the-configuration-file-is-the-root.md)), and re-anchoring
does not read braces: `{/docs,x}` typed in `sub` is `sub/{/docs,x}`, which
reads `sub/docs` or `sub/x`, as it did, where `/docs` typed there is an
absolute path and left alone.

*Amended 2026-09-30.* **A leading `./` takes the slashes after it along**, as
POSIX reads `.//docs` as `./docs`, from spec-core 5666c96. `.//docs`,
`././/docs`, `{.//docs,x}` and `./{/docs,x}` read `docs`, where the slashes
left behind rooted what followed at the filesystem's root and the pattern
named nothing the walk finds: as a pattern to check it read nothing, and as an
`--ignore` or a `--history` pattern it took out, or made records of, nothing.
`{.//,docs}` is still refused, as `{./,docs}` is. `--ignore-ref` is
unchanged: its leading dot is text, escaped before the dialect reads it.

Two refusals are narrower than they could be, on purpose. `**` inside a name
is refused rather than read as `*`: the tools the dialect replaced read
`docs/**.md` three ways, and the quiet reading turned a scope that reached every
nested file into one that stops at the first level. And a group is an extended
glob only when it holds a `|`: `C++(notes).md` and `books/*(2017).md` are names
with parentheses in them, as they were before and as ripgrep reads them.

*Amended 2026-09-27.* The refusal of `**` inside a name writes its advice
from the pattern, as spec-core's does from 119345e: `docs/**.md` is told
`docs/**/*.md` or `docs/*.md`, `**.ts` `**/*.ts` or `*.ts`, and `src/a**`
`src/a*/**` or `src/a*`. Every such pattern was told `docs/**/*.md` or
`*.md`, which named a directory `**.ts` never mentioned and dropped the one
`docs/**.md` did. The first clause of the message, and the exit `2`, are as
they were.

**The walk finds a directory only as it is spelled on disk.** It starts at
each pattern's literal prefix, and on a filesystem that ignores case,
`readdir('Docs')` lists `docs`: every file under it came back spelled
`Docs/...` - a node id, a baseline key - and matched. Each directory of a
prefix is now looked up by name in its parent. A prefix rooted at `/` names
something outside the repository and is not walked; it used to be read as the
root's own directory and reported as `/docs/...`, a path no node can have.

*Amended 2026-09-27.* **Every pattern's starting point is walked**, even one
inside another's. A starting point inside another used to be dropped as
already covered - but the outer walk prunes `vendor` and the rest of the
default list on its way down, so `docs/vendor/specs/*.md` found its files on
its own and none of them beside `docs/**/*.md`: adding a pattern took files
away. The default list now gives way to a pattern that starts inside one of
its directories, since naming it is the reason to read it. A bare `--ignore`
name does not give way: it is the user's, and prunes at any depth, a
pattern's own starting point included, so `--ignore adr` still takes out the
`adr/` the default `adr/**/*.md` starts in. A negated pattern starts no walk:
it takes files back, and starting at its prefix would enter what the walk
skips.

*Amended 2026-09-29.* The default list gives way to a directory a pattern
names outright as well. A plain name may be a file, so its walk starts in the
directory above, and that walk pruned `vendor` on its way in:
`spec-graph check docs/vendor` and `spec-graph check vendor` found nothing
where `docs/vendor/` read the directory, though a literal is read as a file,
or a directory and everything beneath it. The walk now enters the
directory a positive pattern names as a literal - `docs/vendor`, or a literal
a brace expands to, `docs/{vendor,drafts}` - and reads its documents as
`docs/vendor/` does, the rest of the default list still pruned inside it; a
name nested in another, `vendor/dist`, is read the same way. Nothing else
changes. A file of that name is read as the file. Every other directory on the
list is still skipped: another `vendor` elsewhere, and every one for a
negated name, which names nothing to read. An `--ignore` still takes the
directory out, a bare name at any depth and a path such as `docs/*` as it does
from the walk passing through `docs`.

*Amended 2026-09-29.* **A path `--ignore` takes out a pattern's starting
point** as it takes out a directory the walk passes through. A walk that
starts inside the repository never passed through the directories above its
starting point, and only a bare name was asked of them, so the answer
depended on where a pattern's walk began: under `--ignore "docs/*"`,
`docs/**/*.md` pruned `docs/drafts` and read nothing there, while
`docs/drafts/**/*.md`, `docs/drafts/deep/*.md`, `docs/drafts/d.md` and
`docs/vendor/` were read. Each directory from the root to a starting point,
the starting point included, is now matched against the path ignores as the
walk from the root matches it on its way down, and each of those patterns
finds nothing under `--ignore "docs/*"`. A later `!docs/drafts` gives the
directory back to all of them alike. The root itself is matched against no
ignore, from the walk or a starting point: `*` matches the empty path, and
`**/*.md` under `--ignore "*" --ignore "!{docs,specs}"` reads those two. The
default list still gives way to a starting point inside one of its
directories.

*Amended 2026-09-29.* **A starting point beyond a link is not walked unless
links are followed.** The walk passes over a link it meets, a file's or a
directory's, and says nothing of it: following links is `followSymlinks` in
the API, off by default, because a link can lead back up the tree. A pattern
that starts beyond one was read through it all the same, since reading a
directory by its path follows every link in the path: `docs/linked/*.md`,
`docs/linked/` and `docs/linked/c.md` read what the link `docs/linked` leads
to, where `docs/**/*.md` passed over it. Each directory on the way to a
starting point is now looked up in its parent, as its spelling already was,
and one that is a link ends that walk before it starts, as silently as the
walk passes over the link. With `followSymlinks` on, the starting point is
walked through the link, as the walk from the root walks into it.

*Amended 2026-09-29.* **A followed link to a directory is pruned as a
directory is.** With `followSymlinks` on, the walk entered a link to a
directory whatever its name or path: a link called `node_modules`, which
pnpm writes, a link a bare `--ignore` name names, and one a path `--ignore`
matches, such as `docs/private` under `--ignore "docs/p*"`. What was inside
was pruned as usual, but the link itself was never asked. It is now asked
what a directory of its name and path is asked: the default list, a bare
name and the path ignores take it out, and the default list gives way to a
link a pattern names or starts inside, as it does to a directory -
`docs/node_modules` and `docs/node_modules/*.md` read through the link,
unless `--ignore node_modules` says otherwise. A link to a file is read as
it was, matched and ignored by its own path.

*Amended 2026-09-29.* **A `!` before a bare `--ignore` name gives the name
back.** A bare name prunes a directory of that name at any depth, and a
leading `!` takes a path back out of the list, but the two never met: `!docs`
has no slash, so it was read as a bare name, a directory called `!docs`.
`--ignore docs --ignore "!docs"` pruned every `docs` and said nothing, and
`--ignore "!vendor"` read no `vendor`. The bare names are now a list of their
own, read as a `.gitignore` reads one: in order, the last to name a directory
deciding. `--ignore drafts --ignore "!drafts"` reads every `drafts`, on the
walk's way down and where a pattern starts inside one, and
`--ignore "!drafts" --ignore drafts` reads none. The default list is a list of
names as well, and gives way to a `!` before one as it gives way to a pattern
that names it: `--ignore "!vendor"` reads every `vendor`, the rest of the
default list still pruned inside it, until a later `--ignore vendor` takes
them out again. A `!` before a path is unchanged. It takes back what a path
took out, and nothing a name or the default list prunes, since a path such as
`!{docs,specs}` takes back everything beneath it, `docs/node_modules`
included; a name, in turn, gives back nothing a path took out. A `!` alone,
or before another `!`, names no directory, and is refused as the path list
refuses it, `the pattern is empty` and `a negated pattern is a list entry`,
where it pruned a directory of that name. A directory whose name begins with
`!` is named in braces: `**/{!drafts}`.

*Amended 2026-09-29.* **A followed link back into a directory the walk is
inside is not followed.** With `followSymlinks` on, a link to a directory
above it, such as `docs/sub/up` to `docs`, was entered each time the walk
met it, and each time round read the same files again under a longer path,
`docs/sub/up/sub/up/a.md` and on, until the host refused the path: on
Windows, 64 copies of each file, and with two such links in one tree, twice
as many at every turn. The walk now keeps the real path of each directory
from the root to the one it reads, and passes over a link whose real path
is among them, as silently as it passes over every link when links are not
followed: a cycle is a link the walk does not follow, not a fault in the
repository. Each file is read once, under the path that does not go round.
A starting point beyond such a link is not walked, as the walk from the
root does not reach it: `docs/sub/up/*.md` finds nothing. Only a directory
on the way to a link makes it a cycle. A link to a sibling, or to a
directory another link or the walk has already read, is followed as
before, and what it holds is read under its own path as well. With links
not followed, the default, nothing changes and no real path is asked for.

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
spec-core's differential pieces, plus case, `[^`, a backslash, negation and
parentheses with and without a `|` - against every path of a small alphabet.
Every difference must fall into one of the rows above, and every row must
occur, so the table is neither shorter nor longer than what happens. The first row is the host's and not the pattern's,
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
