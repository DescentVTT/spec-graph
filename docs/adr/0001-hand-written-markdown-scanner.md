---
status: accepted
date: 2026-09-07
---

# ADR-0001: A hand-written Markdown scanner

## Context

spec-graph needs six things from a Markdown document: front matter, headings,
list items with their continuations, HTML comments, links, and a reliable map of
what is code.

The obvious choice is `remark` or `micromark`. Both are excellent and both are
wrong for this job:

- They produce an AST optimised for rendering. We want offsets, and recovering
  exact source offsets for a *link destination* through a rendering AST means a
  position-mapping layer on top of the parser anyway.
- They bring a dependency tree. The sibling project `spec-guard` ships with zero
  runtime dependencies, and a documentation linter that a security team has to
  audit is a documentation linter that never gets installed.
- CommonMark conformance is not the property we need. We never render anything.
  Nested emphasis, entity references and link title escaping are irrelevant; the
  only thing that must be exactly right is knowing what is code.

## Decision

We write our own structural scanner, in `src/markdown.ts`, and accept that it is
not a CommonMark implementation.

It guarantees three properties, which are the three that make regex-based spec
linters untrustworthy:

- **Code never counts.** Fenced blocks, indented blocks and inline spans are
  masked before a single link is extracted.
- **Items are blocks, not lines.** A list item owns its wrapped continuation
  lines and its nested content.
- **Everything carries absolute offsets.** No re-scanning, so a reported position
  cannot drift from the text that produced it.

*Amended 2026-09-26.* The scanner is spec-core's now, copied into
`src/vendor/spec-core/markdown/` and checked by hash
([ADR-0023](0023-the-scanner-is-the-familys.md)). It was built on this one and
the three guarantees came with it, and it follows CommonMark wherever CommonMark
decides what is code or a comment, which this one did not always. It is still
hand-written and still depends on nothing, which is what this ADR decided.
`src/markdown.ts` keeps what spec-graph decides about the scan.

## Consequences

Roughly 850 lines we own and must maintain, in exchange for zero runtime
dependencies and exact positions. That is the real price and it is worth stating
plainly: it is the largest single module in the project.

*Amended 2026-09-26.* 1,158 lines by the time it moved, and spec-core maintains
them now, for every tool in the family. The price is paid once instead of three
times, and it is paid in spec-core's review and spec-core's mutation sweep.

One deliberate imprecision: indented code blocks are recognised only outside list
containers. Inside a list, four-space indentation is a continuation far more
often than a code block, and masking a continuation would silently drop the links
and resolutions written there. Fenced blocks are recognised everywhere, and
fenced is what modern documents use.

## Open Questions

- [ ] Should the scanner learn MDX expression syntax? No user has asked, and
      guessing at JSX bracket nesting would risk the masking guarantee above.
- [x] Do we need reference-style link definitions? Yes - resolved, they are
      implemented and tested.

## See also

- [ADR-0004](0004-reference-resolution.md) depends on the masking guarantee.
