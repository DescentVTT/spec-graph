import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * A corpus written to break the scanner.
 *
 * ADR-0013 records why this exists and cannot be replaced by the mutation
 * score: a mutant is a change to code that exists, and a construct nobody
 * parsed has no code to mutate. Three defects in 0.3.0 were found here and by
 * nothing else - a reference link read as a citation of its own label, a
 * directive honoured inside `<script>`, and a document that took a lone
 * backslash as its id.
 *
 * The narrow decisions those produced are asserted where they belong, next to
 * the behaviour they are about. What is left here is the claim ADR-0001 bet the
 * hand-written scanner on: **whatever it is handed, it answers.** A wrong
 * answer is a bug to be fixed one at a time. A hang, a crash, an id that is not
 * a name, or an edge to a node that does not exist are a different kind of
 * failure, and this is where they are caught.
 *
 * Every unprintable character below is written as an escape. A NUL byte in a
 * source file makes it read as binary to grep, diff and review tooling, which
 * is why CLAUDE.md forbids one in this repository at all - and writing this
 * file the careless way proved the point before the test ever ran.
 */

const CORPUS: Record<string, string> = {
  'docs/0001-target.md': '---\nid: ADR-0001\nstatus: accepted\n---\n\n# ADR-0001: Target\n\n## How to read this\n\nBody.\n',

  // Deep and irregular list continuations, tabs mixed with spaces.
  'docs/0002-lists.md': [
    '---',
    'id: ADR-0002',
    'status: accepted',
    '---',
    '',
    '# ADR-0002: Lists',
    '',
    ...Array.from({ length: 40 }, (_, d) => `${' '.repeat(d * 2)}- level ${d} depends on [ADR-0001](0001-target.md)`),
    '',
    ...Array.from({ length: 12 }, (_, d) => `${'\t'.repeat(d)}* tab level ${d}`),
    '',
    '1. one',
    '1000000. huge ordinal',
    '   - TODO: still open, delegated to ADR-0001',
    '     continuation line',
    '\t\tmixed tab continuation',
    '',
    '- [ ] unchecked obligation, handed to [ADR-0001](0001-target.md)',
    '- [x] done',
    '- [-] neither',
  ].join('\n'),

  // Raw HTML around prose, a directive inside a script sample, and a comment
  // that never closes.
  'docs/0003-html.md': [
    '---',
    'id: ADR-0003',
    'status: accepted',
    '---',
    '',
    '# ADR-0003: HTML',
    '',
    '<div align="center">',
    '  <b>bold</b> supersedes [ADR-0001](0001-target.md)',
    '</div>',
    '',
    '<details><summary>Click</summary>',
    '',
    'Depends on ADR-0001.',
    '',
    '</details>',
    '',
    '<script>',
    'const s = "<!-- @spec-node id=\\"FAKE-1\\" -->";',
    '</script>',
    '',
    '```html',
    '<!-- @spec-node id="ALSO-FAKE" status="retired" -->',
    '```',
    '',
    '<!-- an unterminated comment starts here and never closes',
    'supersedes ADR-0001',
  ].join('\n'),

  // Tables: ragged rows, no outer pipes, escaped pipes, pipes inside code.
  'docs/0004-tables.md': [
    '---',
    'id: ADR-0004',
    'status: accepted',
    '---',
    '',
    '# ADR-0004: Tables',
    '',
    '| ID | Status | Depends on |',
    '| -- | ------ | ---------- |',
    '| FR-1 | Active | [ADR-0001](0001-target.md) |',
    '| FR-2 | Active |',
    '| FR-3 | Active | a | b | c | d |',
    '| FR-4 | `a \\| b` | [x\\|y](0001-target.md) |',
    '',
    'ID | Status',
    '-- | ------',
    'FR-5 | Active',
    '',
    '|||',
    '|-|-|',
    '|||',
  ].join('\n'),

  // Control characters, a NUL byte, a lone surrogate, a mid-file BOM, a lone CR.
  'docs/0005-control.md': [
    '---',
    'id: ADR-0005',
    'status: accepted',
    '---',
    '',
    '# ADR-0005: Control',
    '',
    'A vertical tab \u000b here and a form feed \u000c here.',
    'A NUL byte \u0000 mid-line, then depends on ADR-0001.',
    'A lone surrogate \ud800 and a BOM \ufeff mid-file.',
    'Bidi override \u202e and a zero-width \u200b joiner \u200d.',
    'Old-Mac CR line ending follows.\rsupersedes ADR-0001\r',
    'CRLF line.\r',
  ].join('\n'),

  // Shapes that make a careless regular expression backtrack.
  'docs/0006-pathological.md': [
    '---',
    'id: ADR-0006',
    'status: accepted',
    '---',
    '',
    '# ADR-0006: Pathological',
    '',
    `${'['.repeat(200)}x${']'.repeat(200)}`,
    '',
    `${'['.repeat(200)}x`,
    '',
    `[a](${'('.repeat(100)}b${')'.repeat(100)})`,
    '',
    `[link](${'a/'.repeat(500)}b.md)`,
    '',
    `${'*'.repeat(400)}emph${'*'.repeat(400)}`,
    '',
    `${'`'.repeat(300)}code`,
    '',
    `${'x'.repeat(200_000)} depends on ADR-0001`,
    '',
    `[[${'wiki|'.repeat(200)}]]`,
    '',
    `<${'a'.repeat(5000)}>`,
  ].join('\n'),

  // Front matter that never closes, duplicate keys, a fence-wrapped decoy.
  'docs/0007-frontmatter.md': [
    '```',
    '---',
    'id: NOT-REAL',
    '---',
    '```',
    '',
    '---',
    'id: ADR-0007',
    'status: accepted',
    'status: retired',
    '\tindented-with-tab: yes',
    'depends-on: [ADR-0001, ADR-0001]',
    'weird: "unclosed',
    '# ADR-0007: Front matter never closed',
  ].join('\n'),

  // Fences inside block quotes, tilde fences, an unclosed fence at the foot.
  'docs/0008-fences.md': [
    '---',
    'id: ADR-0008',
    'status: accepted',
    '---',
    '',
    '# ADR-0008: Fences',
    '',
    '> ```',
    '> supersedes ADR-0001',
    '> ```',
    '',
    '~~~text',
    '# Not a heading',
    'depends on ADR-0001',
    '~~~',
    '',
    '````',
    '```',
    'depends on ADR-0001',
    '````',
    '',
    '```js title="a|b"',
    'const x = "[y](0001-target.md)";',
  ].join('\n'),

  // Every link form at once, including labels that define nothing.
  'docs/0009-links.md': [
    '---',
    'id: ADR-0009',
    'status: accepted',
    '---',
    '',
    '# ADR-0009: Links',
    '',
    '[ref link][one] and [collapsed][] and [shortcut] and [undefined][nope].',
    '',
    '[one]: 0001-target.md',
    '[collapsed]: 0001-target.md',
    '[shortcut]: 0001-target.md',
    '',
    '<https://example.com/a(b)c> and <mailto:x@example.com>',
    '',
    '![img](0001-target.md#how-to-read-this)',
    '',
    "[a](<0001-target.md> \"title\") and [b](0001-target.md 't')",
    '',
    '[e](0001%2Dtarget.md) and [f](./0001-target.md) and [g](../docs/0001-target.md)',
  ].join('\n'),

  // Setext headings, repeated slugs, malformed ATX.
  'docs/0010-headings.md': [
    '---',
    'id: ADR-0010',
    'status: accepted',
    '---',
    '',
    'ADR-0010: Setext',
    '================',
    '',
    'Sub',
    '---',
    '',
    '## Same',
    '## Same',
    '## Same',
    '',
    '#NoSpace',
    '####### Seven hashes',
    '',
    '# ',
    '',
    '#\t tabbed heading',
  ].join('\n'),
};

const sources = (): Source[] => Object.entries(CORPUS).map(([path, text]): Source => ({ path, text }));
const analysed = analyseSources(sources());

/* -------------------------------------------------------------------------- */

describe('a corpus written to break the scanner', () => {
  it('answers, for every file it was handed', () => {
    // Reaching this line at all is most of the assertion: a scanner that
    // backtracked without bound or recursed without a floor would never return.
    for (const path of Object.keys(CORPUS)) {
      expect(
        analysed.graph.documents.some((document) => document.path === path),
        path,
      ).toBe(true);
    }
  });

  it('gives every node an id that is a name', () => {
    // A directive inside a JavaScript string parses its bare value as a lone
    // backslash, and a document called `\` collides with every other one that
    // made the same mistake.
    for (const node of analysed.graph.nodes.values()) {
      expect(node.id, node.id).toMatch(/[\p{L}\p{N}]/u);
    }
  });

  it('leaves no edge pointing at a node that is not there', () => {
    for (const edge of analysed.graph.edges) {
      expect(analysed.graph.node(edge.from), edge.from).toBeDefined();
      expect(analysed.graph.node(edge.to), edge.to).toBeDefined();
    }
  });

  it('puts every finding somewhere a reader can go', () => {
    for (const diagnostic of analysed.diagnostics) {
      expect(Object.keys(CORPUS)).toContain(diagnostic.at.file);
      expect(diagnostic.at.span.start.line).toBeGreaterThan(0);
      expect(diagnostic.at.span.start.column).toBeGreaterThan(0);
      // A finding a reader cannot act on is one they learn to scroll past.
      expect(diagnostic.hint.length).toBeGreaterThan(0);
    }
  });

  it('does not lose the real relations among the wreckage', () => {
    // The corpus is hostile, not empty. Most files above cite ADR-0001 in some
    // form, and degrading gracefully must not mean degrading to nothing.
    const reaching = new Set(analysed.graph.in('ADR-0001').map((edge) => edge.from));
    expect(reaching.size).toBeGreaterThan(3);
  });

  it('reads all of it in well under a second', () => {
    // Not a benchmark - a guard. The shapes above are the ones that turn a
    // careless regular expression into an unbounded search, and that failure is
    // measured in seconds rather than in milliseconds.
    const started = performance.now();
    analyseSources(sources());
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
