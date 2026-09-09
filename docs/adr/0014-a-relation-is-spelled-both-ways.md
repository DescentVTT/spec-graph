---
status: accepted
date: 2026-09-10
---

# ADR-0014: A relation is spelled in both directions

## Context

Front matter has carried relations since the first release, and it carried them
asymmetrically without anybody noticing:

| Kind | Forward | Inverse |
| --- | --- | --- |
| `supersedes` | `supersedes`, `replaces`, … | `superseded-by`, `replaced-by`, … |
| `amends` | `amends`, `extends` | `amended-by` |
| `depends-on` | `depends-on`, `requires`, `dependencies` | **nothing** |
| `assumes` | `assumes` | **nothing** |
| `references` | `references`, `refs` | **nothing** |

A repository whose filing convention is to record dependents rather than
dependencies - which is a perfectly ordinary convention, and the one an index
document naturally uses - wrote `depended-on-by: ADR-0001` and got nothing. Not
a warning, not a partial edge. The key meant nothing, so the edge the author
declared was absent from a graph that then reported itself as consistent. This
is the same failure the reference-link defect had in
[ADR-0013](0013-the-scanner-hands-back-prose.md), reached from the other side.

Nor was the key space consistent. `depends-on` and `depends_on` both worked
because the lookup tried both spellings by hand; `dependsOn` did not, because
nobody had written that line.

Behind both sits a harder question. Front matter is an **open** vocabulary -
`title`, `date`, `tags`, `sidebar_position`, whatever the site generator wants -
so an unrecognised key is normally none of spec-graph's business. But a typo in a
relation key is indistinguishable, from the outside, from a key that means
something to another tool.

## Decision

**Every directional kind is spelled in both directions**, and a test holds the
invariant so it cannot rot again. `relates-to` is the one exception and it is not
one: the relation is symmetric, so there is no other direction to spell.
`contains` is structural and never written by hand.

Which half of a pair a repository writes is a filing convention, and a filing
convention is not something a linter gets to have an opinion about.

**A key folds on separators and case.** Every non-alphanumeric character is
dropped and the result lower-cased, so `depends-on`, `depends_on`, `dependsOn`
and `DEPENDS_ON` are one key. The folded forms are required to stay distinct,
which is also a test.

**A key one edit from a relation, carrying something that could name a document,
is reported as `unknown-relation-key`.** Both halves of that gate are load-bearing:

- *One edit*, counting a transposition as one, because a transposition is the
  commonest typo there is. `supercedes-by` for `superceded-by` is a slip;
  `categories` for `dependencies` is a different word.
- *Something that could name a document*: a prefixed identifier, or a path with a
  document extension. Without this half the rule fires on `deprecated: true`,
  which is one edit from `deprecates` and is a boolean, and on
  `sidebar_position: 4`, and it becomes an irritation rather than a catch.

The finding is a warning, and it says what is true rather than guessing what was
meant: *"supercedes-by" declares no relation*, with the near spellings as the
hint. Where a near-miss is genuinely ambiguous between the two directions -
`deprecated` is one edit from `deprecates` and two from `deprecated-by` - naming
the candidates and letting the author choose is the honest answer, and asserting
one would be worse than saying nothing.

## Alternatives considered

**Report every unrecognised front-matter key.** This is what the directive parser
does, and it is right there because a directive's attribute set is *closed*. Front
matter is not. The same rule applied here would fire on `layout`, `permalink`,
`nav_order` and a hundred other keys that are somebody else's business, which is
the definition of the failure [ADR-0006](0006-false-positives-cost-more.md)
exists to prevent.

**Report it as a parse problem, seen only under `--verbose`.** Where unknown
directive attributes go, and too quiet for this. An unknown attribute sits on a
directive that still worked; a misread relation key means an edge is missing from
the graph, and the graph is the entire product.

**Accept every near-miss as if it were the key it resembles.** Tempting and
wrong. `deprecated: ADR-0009` would become a supersession in whichever direction
the edit distance happened to favour, and a tool that silently corrects the
author's spelling into the *opposite* relation is worse than one that reads
nothing.

**Add every prose phrase as a front-matter key.** The prose scanner knows
`blocking`, `moved to`, `as decided in` and thirty more. Most make poor keys and
one is actively dangerous: `blocking: true` is a plausible flag in somebody's
front matter, and reading it as a relation would produce a broken reference to
"true". The keys added are the ones unambiguous as keys.

## Consequences

A repository that has been writing an inverse spelling gets edges it never had,
and those edges can produce findings - a `depended-on-by` that was doing nothing
now creates a real dependency that a retired document may now be seen to break.
That is the tool finally reading what was written.

`unknown-relation-key` is a new warning and can fire on upgrade. It fires only
where the key is a hair from a relation *and* the value looks like a citation,
which is a narrow enough gate that a repository seeing it almost certainly has
the defect it names. `--rule unknown-relation-key=off` for the ones that do not.

The vocabulary grew from twenty-five keys to fifty-six. That is the shape this
project prefers - [CLAUDE.md](../../CLAUDE.md) asks for a table entry rather than
a code change - and the cost is that every added key is a word a repository can
no longer use in front matter for something else.

## Open Questions

- [ ] `assumed-by` and `referenced-by` were added for symmetry and have no prose
      counterpart, because no phrase reads naturally as either. If a corpus turns
      one up, the prose table is where it goes.
- [ ] The near-miss gate uses one edit on the folded key. Two would catch
      `dependancies` and would also start catching words; unmeasured either way,
      and left at one until a corpus argues otherwise.

## See also

- [ADR-0006](0006-false-positives-cost-more.md) - the rule that shaped the gate.
- [ADR-0013](0013-the-scanner-hands-back-prose.md) - the same defect, reached
  from the scanner rather than from the vocabulary.
