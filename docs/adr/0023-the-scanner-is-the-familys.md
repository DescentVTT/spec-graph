---
status: accepted
date: 2026-09-26
---

# ADR-0023: The scanner is the family's

## Context

[ADR-0001](0001-hand-written-markdown-scanner.md) chose a hand-written scanner,
and [ADR-0013](0013-the-scanner-hands-back-prose.md) records what that costs:
every construct nobody had thought of, found one at a time by running the
binary against a corpus written to break it. spec-brief and spec-guard paid the
same bill for scanners of their own, and by 2026-09-26 the three disagreed about
fences, comments and code spans in ways that were each a defect somewhere.

spec-core now holds one scanner for all of them, built on this one as its model
([spec-core's ADR-0004](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0004-markdown-structure.md)),
copied into each tool byte for byte and checked by hash
([spec-core's ADR-0001](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0001-one-core-copied-by-hash.md)).
It follows CommonMark wherever CommonMark decides what is code or a comment,
and stays a scanner everywhere else: one pass, offsets throughout, and three
masks for the three questions a tool asks. Its tests run this repository's old
scanner beside it and name every difference as a fix or a dialect.

ADR-0013 left one question open in three parts: a fence inside a comment still
opened, a list marker inside one still decided whether an indented block after
it was code, and headings and items inside `<pre>` and `<script>` were still
read. All three came from finding code blocks before comments. The shared scan
finds comments while it finds blocks.

## Decision

**spec-graph reads every document through spec-core's scan.** It lives in
`src/vendor/spec-core/markdown/`, with the `text` module whose line table is the
one `src/source.ts` wrote. `src/markdown.ts` keeps what spec-graph decides about
what the scan reports, which no other tool has to agree with:

- **An image is not a reference, and a wiki embed is.** The scan reports images,
  for the tools that rewrite their paths. A picture of a decision is not a
  dependency on it, and a missing picture is a broken page rather than a broken
  relation, so images stay out of the graph, as they always were. The embed
  `![[note]]` is the exception: it transcludes the note, which is the strongest
  citation a wiki can write, and spec-graph read it as one before the scan knew
  what an image was.
- **A heading answers to its slug and to GitHub's anchor.** The slug is the one
  spec-graph always computed; spec-core kept it. GitHub renders the second
  `## Notes` of a page as `#notes-1`, and a link copied from the rendered page
  says so: it resolves now, where it was reported broken. The slug still names
  the first, so a link written by hand resolves as it did, and `#notes-2`
  beside two headings is broken, as it is on GitHub.
- **A line of raw-text HTML is read as a line of code is.** It is not the first
  line of a status section, not a labelled `Status:`, and not one of the blank
  lines and comments a `@spec-item` reaches an item across.
- **A comment that never closes carries no directive, and is a parse problem.**
  One that opens a line runs to the end of the document, as CommonMark reads it
  and as a renderer shows it. Read as a directive, a stray `<!-- @spec-ignore`
  would drop the file. The graph loses everything after it, so `--verbose` says
  where it opened.

Everywhere else the shared scan reads a document differently, spec-graph
follows it.

### What a user sees change

Each row is a difference between the scan before and after, named by
spec-core's differential test, and each has a test here: in
`tests/markdown.test.ts`, and for anchors in `tests/resolve.test.ts`.

| Written | Before | Now |
| --- | --- | --- |
| a lone backtick, then a citation paragraphs later | code up to the next run of its length, citation included | a code span ends with its paragraph |
| a comment on a heading's line | part of the heading's text, its slug and the ids of the items under it | not the text, as a renderer shows it |
| `# C#` | a heading called `C` | `C#`: a closing run of `#` needs a space before it |
| a link to `#notes-1` beside two `## Notes` | a broken reference | the second heading |
| a heading, an item or a table in `<pre>` or `<script>` | read, and an open obligation | text |
| `Title`, `===`, `---` on three lines | two headings, the second called `===` | one heading and a rule |
| `> quoted` over `---` | a heading called `quoted` | a quote and a rule |
| `* * *` | a list item | a rule |
| a fence or a quote at an item's own indentation | the item ran through it and on past it | the item ends |
| an indented item after a heading that closed its list | depth 1 | depth 0, an obligation under an obligation heading |
| `[a](b c)` | a link to `b` | text |
| `[foo](not a link)` with `[foo]` defined | a link to `not` | the shortcut `[foo]` |
| a footnote `[^1]:` or a line `[Note]: prose` | a definition, its first word a destination | not a definition |
| a link inside brackets that are not one | not read | read |
| `[Two  Words][]` over `[TWO WORDS]: x` | no link | a link: labels fold case and whitespace |
| `[a](<b c.md>)` | a finding one column early, on the `<` | inside the brackets |
| a delimiter row with fewer cells than its header | a table, and a register | text |
| a fence opened in a block quote and never closed | code to the end of the document | the fence ends with its quote |
| an indented fence after a blank line, outside a list | a fence, often to the end | indented code |
| `----` as a file's first line | front matter | a rule |
| a comment that opens a line and never closes | text | a comment to the end, and a parse problem |
| a fence inside a comment | code from there on | text in a comment |
| a list marker inside a comment, then an indented block | the block continued a list | indented code |

## Alternatives

| Option | Why not |
| --- | --- |
| Keep spec-graph's scanner and fix the three open parts of ADR-0013 | Three scanners stay three, and the next defect is found three times, or not everywhere. |
| Read images as references | A diagram of a decision becomes a relation to it, and a moved PNG a broken reference. |
| Resolve the slug alone, as before | A link copied from the rendered page to a repeated heading is reported broken, and it works. |
| Resolve GitHub's anchor alone | The same for every heading but a repeat, and a region's anchors would depend on the headings of the regions before it. |

## Consequences

A repository sees the rows above in its first run. The likeliest are a heading
with a comment on its line and a footnote written `[^1]:`, and the first of
those moves ids: an item under `## Notes <!-- x -->` was `ADR-0001#notes----x---.1`
and is `ADR-0001#notes.1`. A baseline that accepted a finding on it reports the
entry as no longer occurring, and the finding as new; one `--record-baseline`
settles it.

`ScannedDocument` is spec-core's `MarkdownScan`, still exported under the old
name, and its shape changed where spec-core's did: the masked copy is
`masks.structure`, front-matter lines are in `lines`, and links, headings,
items and comments carry more than they did. The changelog lists each.

The scanner and the line table were 1,278 lines here, and spec-graph's
reading of what the scan reports is 136, most of them comments. The scanner's
mutants are spec-core's sweep now; this repository's measures the reading
([ADR-0007](0007-mutation-testing.md)). The shard that held `markdown.ts` holds
less than [ADR-0019](0019-the-sweep-runs-in-shards.md) measured until the next
sweep re-measures it.

The shared scan is slower. Over this repository's documents, its fixtures and
spec-core's documents, 325 KB, one pass took 17 ms before and 44 ms now, and
extraction 56 ms and 94 ms. It is linear, which is the invariant, and the
difference is spec-core's to take up.

## Open Questions

- [ ] Slugs drop `_`, which GitHub keeps, because spec-core kept spec-graph's
      slug. Matching GitHub would move anchors and item ids, and waits for a
      release that can say so.
      [spec-core's ADR-0004](https://github.com/DescentVTT/spec-core/blob/main/docs/adr/0004-markdown-structure.md)
      holds the same question.

## See also

- [ADR-0001](0001-hand-written-markdown-scanner.md) - the choice this makes
  shared rather than undoes.
- [ADR-0013](0013-the-scanner-hands-back-prose.md) - the open question this
  answers.
- [ADR-0008](0008-wiki-links-carry-no-path.md) - what a wiki link, embedded or
  not, names.
- [ADR-0022](0022-globs-are-the-family-path-dialect.md) - the same move, made for
  globs.
