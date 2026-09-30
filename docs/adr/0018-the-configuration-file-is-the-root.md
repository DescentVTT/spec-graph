---
status: accepted
date: 2026-09-13
---

# ADR-0018: The configuration file is the root

## Context

[ADR-0010](0010-configuration-belongs-to-the-repository.md) put configuration in
the repository and left one question open:

> Should configuration be discovered upward from the working directory rather
> than read from `--root`? A monorepo with per-package specs would want that,
> and nothing has asked yet. Worth noting that upward discovery is the one
> change here that could make a run depend on where it was started from, which
> is the same property that makes byte-determinism hard to reason about.

The worry was the right shape and pointed the wrong way. Reading configuration
from the working directory is *already* a run that depends on where it started:

```text
$ spec-graph check                      # the repository's patterns, its rules,
                                        # its baseline, its verdict
$ cd packages/auth && spec-graph check  # none of the above, and no sign of it
```

Nothing announces it. The second run finds a `.spec-graph.json` that does not
exist, silently falls back to the default include patterns, silently runs no
project rules, and prints a verdict in exactly the same shape as the first one.
A team invoking the tool from a package directory — which is how pnpm
workspaces, Nx and Turborepo are used all day — gets a check that agrees with
nothing anybody else ran.

## Decision

**Configuration is discovered by walking up from the working directory, and the
directory holding it becomes the root of the run.**

Those are one decision, not two, and the second half is what answers ADR-0010's
worry. Every path in spec-graph is relative to the root: node identities,
baseline keys, SARIF locations, the paths in every report. So a run from
anywhere inside the repository produces **byte-identical output** to a run from
the top — which is more determinism than the previous behaviour had, not less.
The test that says so compares the two:

```ts
const top = await run('check', '--root', PROJECT, '--format', 'markdown');
const nested = await runIn(absolute(`${PROJECT}/docs`), 'check', '--format', 'markdown');
expect(nested.out).toBe(top.out);
```

### The walk stops at the repository

A directory holding `.git` is the boundary, and the walk does not read above it.
Above it is a parent checkout, or `$HOME`, or `/` — and a run that silently
picked up a configuration file nobody in the repository can see would be worse
than no discovery at all. A malformed configuration also stops the walk and is
reported, rather than being skipped in favour of a parent's: checking against
the wrong file because this one has a trailing comma in it is the worst
available answer.

The nearest configuration wins, so a package that keeps its own
`.spec-graph.json` is its own root. A `package.json` stops the walk only if it
carries the `spec-graph` key; one that does not is not a configuration file.

### `--root` turns discovery off

Naming the root is naming it. `--root` reads configuration from exactly that
directory, which is the behaviour every existing invocation has, and is why this
change broke no test that uses a fixture.

### What a flag says is relative to where it was typed

The root can now move up, and a path on the command line must not move with it.
`cd packages/auth && spec-graph check "docs/*.md"` means that package's
documents, so the pattern is re-anchored to `packages/auth/docs/*.md` before the
walker sees it. The same goes for `--baseline`, `--record-baseline`, `--history`
and any `--ignore` carrying a path or a glob — an ignore that is a bare
directory name prunes that name at any depth, the way a `.gitignore` line does,
and means the same thing wherever it was typed.

Leaving those alone was the alternative and it is a trap:
`--ignore "docs/drafts/**"` typed in a package would silently match nothing,
which is a check quietly getting weaker.

*Amended 2026-09-26.* A leading `..` is resolved while re-anchoring:
`"../*.md"` typed in `docs/deep` is `docs/*.md`. It used to be left in the
pattern for the matcher to normalise away, and a glob may no longer climb out
of its root ([ADR-0022](0022-globs-are-the-family-path-dialect.md)), so this
is the one place left that knows both halves of the arithmetic.

*Amended 2026-09-30.* A pattern is re-anchored brace alternative by brace
alternative, each as it would be read written alone, by spec-core's
`rebaseGlob` from 5666c96: `{/docs,x}` typed in `sub` is `{/docs,sub/x}`,
`!/docs` stays `!/docs`, and `{../a,b}` typed in `sub/deep` is
`{sub/a,sub/deep/b}`. It was joined to the directory whole, so a `/` leading
an alternative or following a `!` was read under `sub`, and a `..` inside
braces was refused. Four kinds of pattern now stop the run with exit `2`.
Three are refused as they are rebased, and named as they were typed:

- a `..` that climbs past the root, `invalid glob "../../x/*.md": a pattern
  cannot climb out of its root with ".."`, where the refusal named the
  half-anchored `../x/*.md`;
- an empty pattern, `""` or `!`, refused at the root already; joined to `sub`,
  it was everything in `sub`, so an unset variable checked the whole directory;
- any pattern that has to name a directory whose name a pattern would read as
  syntax - a `*`, `?`, `[`, `{` or `\` in it, or a `!` or a space it starts
  with: `notes[1]/*.md` is a class, and read `notes1`.

The fourth is `{/,x}`, which read everything in `sub` and becomes
`{/,sub/x}`, refused as `{/,x}` is at the root: `the braces expand to "/",
which names no path`. A pattern the dialect refuses is named as it was
rebased, as it always was.

`--baseline` and `--record-baseline` name files, not patterns, and are joined
as paths: a brace or a `!` in a baseline's name is a character, where a
leading `!` was moved in front of the directory, and a `..` past the root is a
path outside the repository, as an absolute one may be. A bare `--ignore`
name is left alone, as before. A bare `--history` name was left alone too,
though only the walk prunes a name at any depth and a history pattern is
matched as a whole path: `--history 0002.md` typed in `docs` named the root's
`0002.md`. It is rebased as the patterns to check are, to `docs/0002.md`.

`--ignore-ref`, `--family` and `--ignore-family` are not paths and are left
alone. So is an absolute path: it was never relative to anywhere, so moving the
root cannot change what it means.

### `--verbose` names the file the way the reader would have to type it

```text
configuration: ../../.spec-graph.json
```

Not an absolute path, which would make the output machine-specific, and not a
bare file name, which is what it printed before and is a lie when the file is
two directories up.

*Amended 2026-09-30.* The command a run prints to strike a baseline's stale
entries, `tighten it: spec-graph check --record-baseline <file>`, names the
file the same way. It named it from the root, so typed where the run was
started below the root it wrote another file: from `pkg`, a configured
`pkg/b.json` was `pkg/pkg/b.json`. It is now `../pkg/b.json`, a baseline
typed on the command line is named as it was typed, and an absolute path as
it is. The rest of the report still names the baseline from the root, as it
names every other file.

## Consequences

**A subdirectory run now reports repository-relative paths.** That is the point
— it is what makes a baseline recorded from a package directory interchangeable
with one recorded from the top — and it is a visible change for anybody who was
reading paths out of a nested run.

**Discovery is one `readFileSync` per directory between the working directory
and the repository root**, on a path that already reads a configuration file.
Nothing measurable.

**A repository with no `.git` and no configuration behaves exactly as before**:
the walk terminates at the top of the path and the working directory stays the
root.

## Open Questions

- [x] Should the walk look inside `.git/..` for a worktree's real root? A
      linked worktree has a `.git` *file* rather than a directory, which
      `existsSync` already stops at, so the boundary holds. Following it to the
      main checkout would be a different and worse answer.
      **Resolved (2026-09-13): no - and the boundary is tested now, not only
      stated.** Run against a real linked worktree nested inside its main
      checkout, discovery stopped at the worktree's `.git` file and found no
      configuration. With that file moved aside, the same run printed
      `configuration: ../../../.spec-graph.json`: the main checkout's file,
      describing another branch. So the file is load-bearing, and the claim
      above rested on nothing a test would notice losing - the injected tree
      the other discovery tests use cannot tell a file from a directory. The
      test for this one writes both to disk. A submodule has the same kind of
      `.git` file and gets the same answer, which is right: it is a repository
      of its own.
- [ ] Should a monorepo be able to declare several roots in one run? Several
      roots is several runs today, and the one thing that would make it worth
      changing - a shared graph across packages - is the cross-repository
      question [ADR-0004](0004-reference-resolution.md) declined for the same
      reason.

## See also

- [ADR-0010](0010-configuration-belongs-to-the-repository.md) carried this open
  question and is the file this discovers.
- [ADR-0012](0012-a-baseline-is-a-ratchet.md) is why the root moving matters
  more than it looks: a baseline is keyed on repository-relative identifiers,
  and two roots would be two baselines.
