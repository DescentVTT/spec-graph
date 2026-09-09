---
status: accepted
date: 2026-09-10
---

# ADR-0013: When the scanner is unsure, it hands back prose

## Context

[ADR-0001](0001-hand-written-markdown-scanner.md) chose a hand-written scanner
over a CommonMark library, and the bill for that choice comes due one construct
at a time. A library gets the awkward cases right because thousands of people
have already been wrong about them. Here, each one has to be found.

[ADR-0006](0006-false-positives-cost-more.md) says what to do when the evidence
is ambiguous: stay quiet. What it does not say is where the scanner's own
ambiguity lives, and three defects found by running the binary against a corpus
written to break it turned out to share one shape - **the scanner read structure
into something that was not structure, and the graph carried the consequence**.

```md
This depends on [ADR-0001][one].

[one]: 0001-target.md
```

Read by every renderer as a link to `0001-target.md`. Read by spec-graph as a
citation of the literal word `one`, which resolved to nothing. Two lines, one
false `broken-reference`, and the real `depends-on` edge missing entirely. The
missing half is the worse one: an absent edge is invisible in a report that says
everything is consistent.

```md
<script>
const s = "<!-- @spec-node id=\"ADR-9\" -->";
</script>
```

A page explaining how to annotate a document, annotating itself. The bare value
after `id=` parsed as a lone backslash, so the document's id became `\`. It then
collided with itself, reported a duplicate id against its own file, contained
itself, exported as invalid Mermaid, and named `\` in a finding as the document a
reader should go and edit.

None of the three was found by the test suite, and none of them could have been:
mutation testing measures what the tests assert, and no test asserted anything
about a construct nobody had thought of.

## Decision

**Structure the scanner is not sure about is prose.** Concretely, four rules,
each of which is the CommonMark reading and none of which is a heuristic:

**A reference label is read through its definition, and a label with no
definition is not a link.** Definitions are a destination table, not citations of
their own. `[design][one]` with nothing defining `one` renders verbatim
everywhere, so reading it as a citation invents a reference the author never
made and then reports it broken. The finding for a definition that does not
resolve is reported at the definition, because that is the line that fixes it -
one defect, one finding, however many places use the label.

**The four elements whose content is not Markdown are masked.** `<script>`,
`<style>`, `<pre>` and `<textarea>`, which the spec names for exactly this
reason. `<div>` and `<details>` are deliberately not on the list: their content
*is* Markdown, and a decision written inside a collapsed section is still a
decision.

**A declared id must contain a letter or a digit.** An id is a name a human could
type into a link. A value that is punctuation alone is not a name, it is what a
bad parse left behind, and honouring it does damage no diagnostic can undo.

**A percent-escaped destination is tried second, never first.** `docs/my%20design.md`
is what a renderer, a documentation site and GitHub's own copy-link all produce
for a file with a space in its name, and it names a real file. Decoding it as a
*fallback* means a repository whose filename genuinely contains an escape keeps
resolving by the spelling it wrote, and `100%` in a path is left alone rather
than thrown on.

### The corpus is the method, and it belongs in the repository

The three defects above were found by writing a file designed to be hostile -
forty levels of list nesting, a table row with twice the columns of its header,
raw HTML wrapped around a citation, two hundred nested brackets, a 200 KB line, a
NUL byte, an unterminated comment, an unclosed fence, a lone CR - and then
reading the edges the binary produced.

That practice is already in `CLAUDE.md`, and it earned its place there: three
earlier bugs in the register work were found the same way. This ADR records why
it cannot be replaced by the mutation score. A mutant is a change to code that
exists. A construct nobody parsed has no code to mutate.

What the corpus also established, and what is worth having written down:
**nothing crashed, hung, or ran long.** Two hundred nested brackets, a link
destination five hundred segments deep, four hundred asterisks, an unterminated
backtick run and a 200 KB single line were all read in 81 ms with no
backtracking blow-up and no unbounded recursion. The degradations were wrong
answers, not failures to answer, which is the behaviour ADR-0001 was betting on.

## Alternatives considered

**Adopt a CommonMark library.** It would have prevented all three, and it costs
the invariant the project is built on - a documentation linter a security team
has to audit is one that never gets installed. The bill above is the price of
`deps: none` and it is still cheaper than the alternative. Revisit this only if
the defect rate stops falling.

**Report the malformed constructs rather than ignoring them.** "This looks like a
reference link but nothing defines the label" is a true statement, and a warning
about it would fire on every square-bracketed aside anybody ever wrote. ADR-0006
settles it.

**Mask all raw HTML.** Simpler to state and wrong. `<details>` around a decision
is common, `<div align="center">` around a diagram more so, and masking either
would silently drop the citations written inside them - trading a rare false
positive for a routine missing edge.

## Consequences

A repository using reference-style links gets edges it never had and loses
findings it should never have seen. That is a behaviour change on upgrade in both
directions, and the direction that matters is that a `depends-on` written as
`[ADR-0001][one]` now exists in the graph, so the rules that traverse it can
finally fire.

Masking `<script>` and `<pre>` means a citation written inside one is no longer
read. This is correct and it is a loss: a repository that kept a link inside a
`<pre>` block had an edge and now does not. Nothing observed does that, and the
alternative is a directive inside a worked example renaming the document that
contains it.

## Open Questions

- [ ] A lone `\r` is not treated as a line ending, so a classic-Mac file reports
      every position on one line. Correct per CommonMark to fix, and no corpus
      has ever produced one; left open rather than guessed at.
- [ ] A NUL byte in a scanned file is read through in silence. `CLAUDE.md`
      forbids them in *this* repository because they make a file read as binary
      to grep and diff, but whether spec-graph should say so about somebody
      else's file is a question about scope, not about parsing.

## See also

- [ADR-0001](0001-hand-written-markdown-scanner.md) - the choice this ADR pays
  for, and the reasoning that still holds.
- [ADR-0006](0006-false-positives-cost-more.md) - the rule that decides every
  case above.
