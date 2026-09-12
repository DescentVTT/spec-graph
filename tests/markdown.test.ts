import { describe, expect, it } from 'vitest';

import { scanMarkdown, slugify } from '../src/markdown.js';
import { analyseSources } from '../src/runner.js';
import { compareRefs, createLineIndex } from '../src/source.js';

/** Convenience: the targets of every extracted link, in document order. */
const targets = (md: string): string[] => scanMarkdown(md).links.map((l) => l.target);

describe('createLineIndex', () => {
  it('numbers lines from one and columns from one', () => {
    const index = createLineIndex('alpha\nbeta\ngamma');
    expect(index.lineCount).toBe(3);
    expect(index.positionAt(0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(index.positionAt(6)).toEqual({ offset: 6, line: 2, column: 1 });
    expect(index.positionAt(9)).toEqual({ offset: 9, line: 2, column: 4 });
  });

  it('treats CRLF as one terminator so Windows and POSIX agree', () => {
    const posix = createLineIndex('a\nb\nc');
    const win = createLineIndex('a\r\nb\r\nc');
    expect(win.lineCount).toBe(posix.lineCount);
    expect(win.lineText(2)).toBe('b');
    expect(win.positionAt(win.lineStart(3)).line).toBe(3);
  });

  it('does not invent a trailing line for a trailing newline', () => {
    expect(createLineIndex('a\nb\n').lineCount).toBe(2);
    expect(createLineIndex('').lineCount).toBe(1);
  });

  it('clamps out-of-range offsets instead of throwing', () => {
    const index = createLineIndex('one\ntwo');
    expect(index.positionAt(-5).offset).toBe(0);
    expect(index.positionAt(9999).offset).toBe(7);
  });
});

describe('compareRefs', () => {
  const ref = (file: string, line: number, column = 1, end = 0) => ({
    file,
    span: { start: { offset: 0, line, column }, end: { offset: end, line, column } },
  });

  it('orders by file, then line, then column, then extent', () => {
    expect(compareRefs(ref('a.md', 1), ref('b.md', 1))).toBeLessThan(0);
    expect(compareRefs(ref('b.md', 1), ref('a.md', 1))).toBeGreaterThan(0);
    expect(compareRefs(ref('a.md', 1), ref('a.md', 9))).toBeLessThan(0);
    expect(compareRefs(ref('a.md', 1, 2), ref('a.md', 1, 30))).toBeLessThan(0);
    expect(compareRefs(ref('a.md', 1, 1, 5), ref('a.md', 1, 1, 50))).toBeLessThan(0);
  });

  it('is zero only for references to the same place', () => {
    expect(compareRefs(ref('a.md', 3, 4, 9), ref('a.md', 3, 4, 9))).toBe(0);
  });

  it('sorts a list totally, so two runs cannot disagree', () => {
    const refs = [ref('b.md', 1), ref('a.md', 9), ref('a.md', 2, 7), ref('a.md', 2, 1)];
    expect([...refs].sort(compareRefs).map((r) => `${r.file}:${r.span.start.line}:${r.span.start.column}`)).toEqual([
      'a.md:2:1',
      'a.md:2:7',
      'a.md:9:1',
      'b.md:1:1',
    ]);
  });
});

describe('front matter', () => {
  it('captures YAML front matter and starts the body after it', () => {
    const doc = scanMarkdown('---\nstatus: accepted\n---\n\n# Title\n');
    expect(doc.frontMatter?.raw).toBe('status: accepted\n');
    expect(doc.headings.map((h) => h.text)).toEqual(['Title']);
  });

  it('ignores a lone rule that never closes', () => {
    const doc = scanMarkdown('---\n\n# Title\n');
    expect(doc.frontMatter).toBeNull();
  });

  it('does not extract links from front matter as prose links', () => {
    const doc = scanMarkdown('---\nsupersedes: [ADR-0003](0003.md)\n---\n\nBody.\n');
    expect(doc.links).toHaveLength(0);
  });
});

describe('code masking', () => {
  it('ignores links inside fenced code', () => {
    const md = ['See [real](real.md).', '', '```md', 'See [fake](fake.md).', '```', ''].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('handles tilde fences and fences carrying an info string', () => {
    const md = ['~~~markdown', '[a](a.md)', '~~~', '', '```ts title="x.ts"', '[b](b.md)', '```', '[c](c.md)'].join('\n');
    expect(targets(md)).toEqual(['c.md']);
  });

  it('does not let a nested fence close the outer block early', () => {
    const md = ['````md', '```', '[hidden](hidden.md)', '```', '````', '[shown](shown.md)'].join('\n');
    expect(targets(md)).toEqual(['shown.md']);
  });

  it('ignores links inside inline code spans', () => {
    const md = 'Write `[fake](fake.md)` to link, like [real](real.md).';
    expect(targets(md)).toEqual(['real.md']);
  });

  it('matches inline spans by backtick run length', () => {
    const md = 'A ``code ` with tick [no](no.md)`` and [yes](yes.md).';
    expect(targets(md)).toEqual(['yes.md']);
  });

  it('treats an unterminated backtick as prose, not as code', () => {
    const md = 'A stray ` tick and [yes](yes.md).';
    expect(targets(md)).toEqual(['yes.md']);
  });

  it('masks the four HTML elements whose content is not Markdown', () => {
    for (const tag of ['script', 'style', 'pre', 'textarea']) {
      const md = [`<${tag}>`, '[fake](fake.md)', `</${tag}>`, '', '[real](real.md)'].join('\n');
      expect(targets(md), tag).toEqual(['real.md']);
    }
  });

  it('opens a raw-text block only at the start of a line', () => {
    // The case that must not match. A sentence mentioning the tag would
    // otherwise swallow every citation below it, to the end of the document.
    const md = ['Use the <script> tag to embed [one](one.md).', '', '[two](two.md)'].join('\n');
    expect(targets(md)).toEqual(['one.md', 'two.md']);
  });

  it('opens one that is indented, as the spec allows', () => {
    const md = ['   <pre>', '[fake](fake.md)', '   </pre>', '', '[real](real.md)'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('opens one whose tag ends the line', () => {
    const md = ['<script', 'type="module">', '[fake](fake.md)', '</script>', '[real](real.md)'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('does not let a raw-text tag inside a fence escape it', () => {
    // Already masked as code either way. What matters is the unclosed one: read
    // as an opening tag it would run to the end of the document, taking every
    // citation after the fence with it.
    const md = ['```html', '<script>', '```', '', '[real](real.md)'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('leaves HTML whose content is Markdown alone', () => {
    // A decision written inside a collapsed section is still a decision, and
    // `<div>` wrappers are how a repository centres a diagram.
    const md = ['<details><summary>Why</summary>', '', '[real](real.md)', '', '</details>'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('closes a raw-text block on the line that carries its end tag', () => {
    const md = ['<pre>[fake](fake.md)</pre>', '', '[real](real.md)'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('does not mistake a tag that merely starts the same way', () => {
    const md = ['<presentation-note>', '', '[real](real.md)', '', '</presentation-note>'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('runs an unclosed raw-text block to the end, as a browser does', () => {
    const md = ['<script>', '[fake](fake.md)', '', '[also-fake](also.md)'].join('\n');
    expect(targets(md)).toEqual([]);
  });

  it('masks an indented code block outside a list', () => {
    const md = ['Prose.', '', '    [fake](fake.md)', '', '[real](real.md)'].join('\n');
    expect(targets(md)).toEqual(['real.md']);
  });

  it('does NOT treat indented list continuations as code', () => {
    // Four-space indentation under a bullet is continuation far more often than
    // it is a code block. Masking it would drop the link written there.
    const md = ['- An item that continues', '    with [a link](target.md) on the next line.'].join('\n');
    expect(targets(md)).toEqual(['target.md']);
  });

  it('reports masked offsets for code and comments', () => {
    const doc = scanMarkdown('a `b` c <!-- d --> e');
    expect(doc.isMasked(doc.text.indexOf('b'))).toBe(true);
    expect(doc.isMasked(doc.text.indexOf('d'))).toBe(true);
    expect(doc.isMasked(doc.text.indexOf('e'))).toBe(false);
  });

  it('keeps the masked copy the same length and line shape as the source', () => {
    const md = 'x\n```\nhidden\n```\ny <!-- c -->\n';
    const doc = scanMarkdown(md);
    expect(doc.masked).toHaveLength(doc.text.length);
    expect(doc.masked.split('\n')).toHaveLength(doc.text.split('\n').length);
    expect(doc.masked).not.toContain('hidden');
  });
});

describe('headings', () => {
  it('reads ATX headings and slugs them the way GitHub does', () => {
    const doc = scanMarkdown('# Open Questions\n## Decision & Rationale\n');
    expect(doc.headings.map((h) => [h.level, h.text, h.slug])).toEqual([
      [1, 'Open Questions', 'open-questions'],
      [2, 'Decision & Rationale', 'decision--rationale'],
    ]);
  });

  it('reads setext headings', () => {
    const doc = scanMarkdown('Title\n=====\n\nSub\n---\n');
    expect(doc.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Sub'],
    ]);
  });

  it('strips closing hashes and ignores headings inside code', () => {
    const doc = scanMarkdown('## Status ##\n\n```\n# Not a heading\n```\n');
    expect(doc.headings.map((h) => h.text)).toEqual(['Status']);
  });
});

describe('list items', () => {
  it('captures a wrapped item as one multi-line block', () => {
    const md = ['- [ ] Should we shard the write path', '  before the migration lands?'].join('\n');
    const [item] = scanMarkdown(md).listItems;
    expect(item?.checkbox).toBe(' ');
    expect(item?.body).toBe('Should we shard the write path\n  before the migration lands?');
    expect(item?.firstLine).toBe('Should we shard the write path');
  });

  it('includes nested content in the parent body', () => {
    const md = ['- Should we shard?', '  - Resolved: no, one node suffices.', '', '- Next item'].join('\n');
    const items = scanMarkdown(md).listItems;
    expect(items[0]?.body).toContain('Resolved: no');
    expect(items[0]?.depth).toBe(0);
    expect(items[1]?.depth).toBe(1);
    expect(items[2]?.firstLine).toBe('Next item');
    expect(items[2]?.depth).toBe(0);
  });

  it('stops an item at the next heading', () => {
    const md = ['- An item', '', '## Next section', '', 'Prose.'].join('\n');
    const [item] = scanMarkdown(md).listItems;
    expect(item?.body.trim()).toBe('An item');
  });

  it('reads every checkbox state, not just space and x', () => {
    const md = ['- [ ] open', '- [x] done', '- [~] narrowed', '- [?] question', '- [-] dropped'].join('\n');
    expect(scanMarkdown(md).listItems.map((i) => i.checkbox)).toEqual([' ', 'x', '~', '?', '-']);
  });

  it('handles ordered markers and paren markers', () => {
    const md = ['1. first', '2) second'].join('\n');
    expect(scanMarkdown(md).listItems.map((i) => i.firstLine)).toEqual(['first', 'second']);
  });

  it('does not mistake a bracketed link at item start for a checkbox', () => {
    const md = '- [ADR-0003](0003.md) explains the original choice.';
    const [item] = scanMarkdown(md).listItems;
    expect(item?.checkbox).toBeNull();
    expect(item?.firstLine).toMatch(/^\[ADR-0003\]/);
  });

  it('ignores list markers inside code fences', () => {
    const md = ['```', '- [ ] not an item', '```', '- [ ] a real item'].join('\n');
    expect(scanMarkdown(md).listItems.map((i) => i.firstLine)).toEqual(['a real item']);
  });

  it('reads items inside block quotes', () => {
    const md = ['> - [ ] quoted obligation'].join('\n');
    expect(scanMarkdown(md).listItems.map((i) => i.firstLine)).toEqual(['quoted obligation']);
  });
});

describe('links', () => {
  it('reads inline links, titles included', () => {
    expect(targets('[a](path/to.md "Title")')).toEqual(['path/to.md']);
  });

  it('reads angle-bracketed destinations with spaces', () => {
    expect(targets('[a](<my file.md>)')).toEqual(['my file.md']);
  });

  it('reads reference links through to the destination the label stands for', () => {
    const md = ['See [ADR-3][adr3] and [adr3].', '', '[adr3]: ../adr/0003.md'].join('\n');
    const links = scanMarkdown(md).links;
    // Document order. The definition line yields a definition and nothing else:
    // its own label must not be harvested a second time as a shortcut link.
    expect(links.map((l) => [l.form, l.target])).toEqual([
      ['reference', '../adr/0003.md'],
      ['shortcut', '../adr/0003.md'],
      ['definition', '../adr/0003.md'],
    ]);
    // The label survives beside the destination, because a report has to be able
    // to quote what was written.
    expect(links.map((l) => l.label)).toEqual(['adr3', 'adr3', 'adr3']);
  });

  it('points a reference link at the definition, which is where the fix goes', () => {
    const md = ['See [ADR-3][adr3].', '', '[adr3]: ../adr/0003.md'].join('\n');
    const [reference] = scanMarkdown(md).links;
    // The construct is on line 1 and its destination is on line 3. Both are
    // recorded: the citation is where it was read, the target where it is edited.
    expect(reference?.line).toBe(1);
    expect(md.slice(reference?.targetStart ?? 0)).toBe('../adr/0003.md');
  });

  it('leaves a bracket pair with no definition as prose', () => {
    // `[design][one]` renders literally when nothing defines `one`, so reading it
    // as a citation invents a reference - and then reports it as broken.
    expect(targets('See [design][one] and [alone].')).toEqual([]);
  });

  it('reads a collapsed reference through the label it repeats', () => {
    // `[label][]` has an empty reference, so the label is both the text and
    // the key. Reading the empty half as the key resolves nothing.
    const md = ['[adr3][] and [x][adr3]', '', '[adr3]: ../adr/0003.md'].join('\n');
    expect(targets(md)).toEqual(['../adr/0003.md', '../adr/0003.md', '../adr/0003.md']);
  });

  it('takes the first definition of a repeated label, as CommonMark does', () => {
    const md = ['[a][x]', '', '[x]: first.md', '[x]: second.md'].join('\n');
    const [use] = scanMarkdown(md).links;
    expect(use?.target).toBe('first.md');
  });

  it('reads wiki links and drops the display half', () => {
    expect(targets('[[0007-sharding|Sharding]] and [[0008]]')).toEqual(['0007-sharding', '0008']);
  });

  it('reads autolinks', () => {
    expect(targets('<https://example.com/adr-7>')).toEqual(['https://example.com/adr-7']);
  });

  it('skips images', () => {
    expect(targets('![diagram](diagram.png) and [spec](spec.md)')).toEqual(['spec.md']);
  });

  it('handles nested brackets in a label', () => {
    expect(targets('[see [ADR-3] here](0003.md)')).toEqual(['0003.md']);
  });

  it('handles parentheses inside a destination', () => {
    expect(targets('[a](path/to_(v2).md)')).toEqual(['path/to_(v2).md']);
  });

  it('does not run away on an unmatched bracket', () => {
    const md = `[unclosed label ${'x'.repeat(50)}\n\nNext paragraph [real](real.md).`;
    expect(targets(md)).toEqual(['real.md']);
  });

  it('records precise offsets for the destination', () => {
    const md = 'text [label](target.md) tail';
    const [link] = scanMarkdown(md).links;
    expect(md.slice(link?.targetStart ?? 0, (link?.targetStart ?? 0) + 9)).toBe('target.md');
    expect(link?.line).toBe(1);
  });

  it('keeps line numbers correct after a fenced block', () => {
    const md = ['# T', '', '```', 'x', '```', '', '[a](a.md)'].join('\n');
    expect(scanMarkdown(md).links[0]?.line).toBe(7);
  });
});

describe('html comments', () => {
  it('captures multi-line comments', () => {
    const md = '<!-- @spec-node\n     id="ADR-1"\n     status="accepted" -->\n';
    const [comment] = scanMarkdown(md).comments;
    expect(comment?.inner).toContain('id="ADR-1"');
    expect(comment?.line).toBe(1);
  });

  it('ignores comments inside code fences', () => {
    const md = ['```', '<!-- @spec-node id="fake" -->', '```', '<!-- @spec-node id="real" -->'].join('\n');
    const comments = scanMarkdown(md).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.inner).toContain('real');
  });

  it('ignores comments inside raw-text HTML', () => {
    // The `<!--` here opens a JavaScript string, not a comment. A page teaching
    // people how to annotate a document is exactly where such a sample lives.
    const md = [
      '<script>',
      'const s = "<!-- @spec-node id=\\"FAKE\\" -->";',
      '</script>',
      '<!-- @spec-node id="real" -->',
    ].join('\n');
    const comments = scanMarkdown(md).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.inner).toContain('real');
  });
});

describe('slugify', () => {
  it('lowercases, drops punctuation and hyphenates spaces', () => {
    expect(slugify('Open Questions')).toBe('open-questions');
    expect(slugify('`code` and **bold**')).toBe('code-and-bold');
    expect(slugify('C++ / Rust?')).toBe('c--rust');
  });

  it('keeps non-latin letters', () => {
    expect(slugify('架構決策')).toBe('架構決策');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * What the scanner does with input that is not quite text. See ADR-0013.
 */
describe('unusual line terminators and bytes', () => {
  const NUL = String.fromCharCode(0);
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

  const BODY = [
    '---',
    'status: accepted',
    '---',
    '',
    '# ADR-0001: Probe',
    '',
    '## Open Questions',
    '',
    '- [ ] first',
    '- [ ] second',
    '',
    'See [gone](docs/nope.md).',
    '',
  ];

  it('reads a lone carriage return as a line ending, exactly as CommonMark says', () => {
    // A classic-Mac file has to produce the same line numbers as a POSIX one,
    // for the same reason a Windows one does: half a team otherwise gets
    // diagnostics pointing at line 1 of everything.
    const shape = (separator: string) => {
      const result = analyseSources([{ path: 'docs/adr/0001-probe.md', text: BODY.join(separator) }]);
      return {
        items: result.corpus.items.map((item) => [item.at.span.start.line, item.text]),
        findings: result.diagnostics.map((finding) => [finding.at.span.start.line, finding.rule]),
      };
    };
    const posix = shape(LF);
    expect(posix.items).toEqual([
      [9, 'first'],
      [10, 'second'],
    ]);
    expect(posix.findings).toEqual([[12, 'broken-reference']]);
    expect(shape(CR)).toEqual(posix);
    expect(shape(CR + LF)).toEqual(posix);
  });

  it('reports a NUL byte as a problem with the input, not as a finding', () => {
    // spec-graph is likely the only tool that got this far: grep, diff and
    // every review interface read the file as binary and show nothing.
    const text = ['---', 'status: accepted', '---', '', `# ADR-0001: Pr${NUL}obe`, ''].join(LF);
    const result = analyseSources([{ path: 'docs/adr/0001-probe.md', text }]);
    expect(result.corpus.problems.map((problem) => problem.message)).toEqual([
      'contains a NUL byte, so grep, diff and review tooling read this file as binary - check whether it was saved as UTF-16',
    ]);
    expect(result.corpus.problems[0]?.at.span.start.line).toBe(5);
    // Not a finding, so it cannot fail a build over somebody else's encoding.
    expect(result.diagnostics).toEqual([]);
  });

  it('says it once, however many NULs there are', () => {
    const text = ['---', 'status: accepted', '---', '', `# A${NUL}${NUL}B${NUL}C`, ''].join(LF);
    expect(analyseSources([{ path: 'a.md', text }]).corpus.problems).toHaveLength(1);
  });

  it('says nothing about a file that has none', () => {
    expect(analyseSources([{ path: 'a.md', text: BODY.join(LF) }]).corpus.problems).toEqual([]);
  });
});
