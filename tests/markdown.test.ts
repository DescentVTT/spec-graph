import { describe, expect, it } from 'vitest';

import { anchorsOf, referenceLinks, scanMarkdown, slugify } from '../src/markdown.js';
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
    expect(doc.masks.structure).toHaveLength(doc.text.length);
    expect(doc.masks.structure.split('\n')).toHaveLength(doc.text.split('\n').length);
    expect(doc.masks.structure).not.toContain('hidden');
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

  it('reports an image as one, and spec-graph reads no image as a reference', () => {
    const doc = scanMarkdown('![diagram](diagram.png) and [spec](spec.md) and ![alt][d]\n\n[d]: d.png');
    expect(doc.links.filter((l) => l.image).map((l) => l.target)).toEqual(['diagram.png', 'd.png']);
    expect(referenceLinks(doc).map((l) => [l.form, l.target])).toEqual([
      ['inline', 'spec.md'],
      ['definition', 'd.png'],
    ]);
  });

  it('reads a wiki embed as a reference to the note it embeds', () => {
    // Obsidian's `![[note]]` transcludes the note, which cites it as surely as
    // `[[note]]` does. spec-graph read it as a wiki link before the scan knew
    // images, and still does now that the scan calls it one.
    const doc = scanMarkdown('![[0007-sharding]] and [[0008-queues|Queues]]');
    expect(doc.links.map((l) => l.image)).toEqual([true, false]);
    expect(referenceLinks(doc).map((l) => [l.form, l.target])).toEqual([
      ['wiki', '0007-sharding'],
      ['wiki', '0008-queues'],
    ]);
  });

  it('draws an edge to an embedded note, and none to a pictured one', () => {
    const { graph, diagnostics } = analyseSources([
      {
        path: 'docs/adr/0001-embeds.md',
        text: '# ADR-0001: Embeds\n\n![[0002-target]]\n\n![a diagram](0002-target.md)\n![gone](missing.png)\n',
      },
      { path: 'docs/adr/0002-target.md', text: '# ADR-0002: Target\n' },
    ]);
    expect(graph.edges.filter((e) => e.kind !== 'contains').map((e) => [e.from, e.to, e.declaredAt.span.start.line])).toEqual([
      ['ADR-0001', 'ADR-0002', 3],
    ]);
    expect(diagnostics.map((d) => d.rule)).not.toContain('broken-reference');
  });

  it('reads a badge wrapped in a link as the link alone', () => {
    // spec-core lists the image inside a link's text after the link, since
    // CommonMark renders it there. A badge cites nothing: neither its picture
    // nor its alt text may reach the graph, and the link around it must.
    const badge = '[![ADR-0003 badge](0003-pictured.md)](0002-target.md)';
    const scanned = scanMarkdown(badge);
    expect(scanned.links.map((l) => [l.image, l.target])).toEqual([
      [false, '0002-target.md'],
      [true, '0003-pictured.md'],
    ]);
    expect(referenceLinks(scanned).map((l) => l.target)).toEqual(['0002-target.md']);

    const { graph, diagnostics } = analyseSources([
      { path: 'docs/adr/0001-badges.md', text: `# ADR-0001: Badges\n\n${badge}\n[![status](missing.svg)](0002-target.md)\n` },
      { path: 'docs/adr/0002-target.md', text: '# ADR-0002: Target\n' },
      { path: 'docs/adr/0003-pictured.md', text: '# ADR-0003: Pictured\n' },
    ]);
    expect(graph.edges.filter((e) => e.kind !== 'contains').map((e) => [e.from, e.to, e.declaredAt.span.start.line])).toEqual([
      ['ADR-0001', 'ADR-0002', 3],
    ]);
    expect(diagnostics).toEqual([]);
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

  it('points a finding at an angle-bracketed destination inside its brackets', () => {
    // The span is the destination as written, so an editor that selects it
    // selects the path and not the `<` before it.
    const { diagnostics } = analyseSources([
      { path: 'docs/adr/0001-a.md', text: '# ADR-0001: A\n\nSee [it](<0009 missing.md>).\n' },
    ]);
    const [broken] = diagnostics.filter((d) => d.rule === 'broken-reference');
    expect([broken?.at.span.start.column, broken?.at.span.end.column]).toEqual([11, 26]);
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

/**
 * Comments and code spans are found in one pass, and whichever opens first
 * wins, as CommonMark has it. Found one kind after the other, a span that
 * merely mentioned `<!--` opened a comment running to the next `-->` anywhere.
 */
describe('comments and code spans, read left to right', () => {
  it('reads a span that mentions a comment as code, and the comment after it as a comment', () => {
    const md = ['# T', '', 'Use `<!--` to open.', '', '## Real heading', '', 'See [a](b.md).', '', '<!--', '## Hidden', '-->', ''];
    const doc = scanMarkdown(md.join('\n'));
    // Read as a comment, the span took the heading's section and the link with
    // it, and a broken reference to b.md would never have been reported.
    expect(doc.headings.map((h) => h.text)).toEqual(['T', 'Real heading']);
    expect(doc.links.map((l) => l.target)).toEqual(['b.md']);
    expect(doc.comments.map((c) => c.inner)).toEqual(['\n## Hidden\n']);
    expect(doc.isMasked(doc.text.indexOf('<!--'))).toBe(true);
  });

  it('lets a span close past a `<!--` it opened before', () => {
    const doc = scanMarkdown('A `span <!-- here` then [x](x.md) --> end.');
    expect(doc.comments).toEqual([]);
    expect(doc.links.map((l) => l.target)).toEqual(['x.md']);
  });

  it('lets a comment hold a backtick it opened before', () => {
    // Opening a span, the backtick in the comment would close at the first one
    // of `code` and take the link between them.
    const doc = scanMarkdown('Text <!-- one ` --> then [x](x.md) and `code`.');
    expect(doc.comments.map((c) => c.inner)).toEqual([' one ` ']);
    expect(doc.links.map((l) => l.target)).toEqual(['x.md']);
    expect(doc.isMasked(doc.text.indexOf('code'))).toBe(true);
  });

  it('closes a span only with a run of its own length', () => {
    const doc = scanMarkdown('Write ``a ` <!-- b`` then [x](x.md) --> done.');
    expect(doc.comments).toEqual([]);
    expect(doc.links.map((l) => l.target)).toEqual(['x.md']);
  });

  it('opens nothing with a run that never closes', () => {
    const doc = scanMarkdown('A `` run, <!-- note --> and [x](x.md) ` end.');
    expect(doc.comments.map((c) => c.inner)).toEqual([' note ']);
    expect(doc.links.map((l) => l.target)).toEqual(['x.md']);
  });

  it('does not let an escaped backtick open a span', () => {
    const doc = scanMarkdown('A \\` then <!-- note --> and [x](x.md) `.');
    expect(doc.comments.map((c) => c.inner)).toEqual([' note ']);
    expect(doc.links.map((l) => l.target)).toEqual(['x.md']);
  });

  it('neither opens nor closes a span with a backtick inside a fence', () => {
    expect(targets(['Open `here and [x](x.md).', '', '```', 'not ` the end', '```'].join('\n'))).toEqual(['x.md']);
    expect(targets(['```', 'a ` inside', '```', '[x](x.md) and a stray `'].join('\n'))).toEqual(['x.md']);
    // A run as long as the fence's own, looking past it for a closer.
    expect(targets(['An ``` unclosed [x](x.md).', '', '```', 'code', '```', ''].join('\n'))).toEqual(['x.md']);
    // Looking past one fence, and then past another.
    const past = ['Open `here and [x](x.md).', '', '```', 'not ` the end', '```', '', 'Still [y](y.md).', '', '```', 'nor ` this', '```', 'End.'];
    expect(targets(past.join('\n'))).toEqual(['x.md', 'y.md']);
  });

  it('reads what lies before, between and after code blocks', () => {
    const md = [
      'Use `[fake](fake.md)` and <!-- one -->.',
      '',
      '```',
      '<!-- fake -->',
      '```',
      '',
      'Between `x` and <!-- two -->.',
      '',
      '~~~',
      'a ` <!-- fake -->',
      '~~~',
      '',
      'After [real](real.md) <!-- three --> and ``` a ```.',
    ].join('\n');
    const doc = scanMarkdown(md);
    expect(doc.comments.map((c) => c.inner)).toEqual([' one ', ' two ', ' three ']);
    expect(doc.links.map((l) => l.target)).toEqual(['real.md']);
  });

  it('opens a comment at `<!--` and at no other `<`', () => {
    const doc = scanMarkdown('See <https://example.com/a> and <!-- note -->');
    expect(doc.comments.map((c) => c.inner)).toEqual([' note ']);
    expect(doc.links.map((l) => l.target)).toEqual(['https://example.com/a']);
  });

  it('keeps a `<!--` that never closes in the middle of a line as text, and reads the spans after it', () => {
    const doc = scanMarkdown('Text <!-- open\n\n`[fake](fake.md)` and <!-- again [real](real.md)');
    expect(doc.comments).toEqual([]);
    expect(doc.links.map((l) => l.target)).toEqual(['real.md']);
  });

  it('runs a `<!--` that opens a line and never closes to the end, as CommonMark does', () => {
    // An HTML block: a renderer hides everything after it, and so does the scan.
    const doc = scanMarkdown('[before](before.md)\n\n<!-- open\n\n# Hidden\n\n[after](after.md)');
    expect(doc.comments.map((c) => [c.line, c.closed])).toEqual([[3, false]]);
    expect(doc.links.map((l) => l.target)).toEqual(['before.md']);
    expect(doc.headings).toEqual([]);
  });

  it('says so when a comment that opens a line never closes, and reads no directive from it', () => {
    // A stray `<!-- @spec-ignore` read as a directive would drop the file.
    const text = '# ADR-0001: Open\n\n<!-- @spec-ignore\n\n- [ ] hidden\n';
    const { graph, corpus } = analyseSources([{ path: 'docs/adr/0001-open.md', text }]);
    expect(graph.documents.map((n) => n.id)).toEqual(['ADR-0001']);
    expect(corpus.problems.map((p) => [p.message, p.at.span.start.line, p.at.span.start.column])).toEqual([
      ['a comment opened here is never closed, so nothing after it is read - close it with -->', 3, 1],
    ]);
    expect(analyseSources([{ path: 'docs/adr/0001-shut.md', text: '# ADR-0001: Shut <!-- x -->\n' }]).corpus.problems).toEqual([]);
  });

  it('still closes a span after runs that never did, each a different length', () => {
    // None of these runs closes, and each once read the rest of the document
    // looking. The first search that fails now keeps what it saw, and the rest
    // are answered from it - which must not stop the span below from closing.
    //
    // No clock here, unlike the blow-up detectors for regex and glob. This cost
    // grew as the length to the power 1.5, not exponentially: fifteen seconds
    // took 2 MB, and that is more than mutation testing can afford to scan for
    // every mutant this test reaches, instrumented, inside the bound.
    const runs = Array.from({ length: 300 }, (_, k) => '`'.repeat(k + 2)).join(' ');
    const doc = scanMarkdown(`${runs}\n\nThen \`[fake](fake.md)\` and [real](real.md) <!-- note -->\n`);
    expect(doc.links.map((l) => l.target)).toEqual(['real.md']);
    expect(doc.comments.map((c) => c.inner)).toEqual([' note ']);
  });
});

/**
 * What a comment holds is text a renderer never shows, so it is not a heading,
 * an item or a table either. The first character of a line decides, as it does
 * in CommonMark: a line that begins inside a comment is HTML to its end.
 */
describe('what a comment holds is not structure', () => {
  it('reads no heading in a comment, and every heading around it', () => {
    const doc = scanMarkdown(['# Title', '<!--', '## Hidden', '   # Also hidden', '-->', '## Shown <!-- aside -->'].join('\n'));
    // A comment on a heading's line is not its text, as a renderer shows it.
    expect(doc.headings.map((h) => h.text)).toEqual(['Title', 'Shown']);
    expect(doc.lines.map((l) => l.comment)).toEqual([false, true, true, true, true, false]);
  });

  it('reads no setext heading out of a comment or under one', () => {
    const under = (md: string[]) => scanMarkdown(md.join('\n')).headings.map((h) => h.text);
    // A rule under a comment is a rule, not a heading called "<!-- note -->".
    expect(under(['<!-- note -->', '---'])).toEqual([]);
    expect(under(['   <!-- note -->', '==='])).toEqual([]);
    expect(under(['Prose. <!-- open', '===', '-->'])).toEqual([]);
    expect(under(['<!--', 'Title', '=====', '-->'])).toEqual([]);
    expect(under(['<!-- note -->', 'Title', '====='])).toEqual(['Title']);
  });

  it('reads no list item in a comment, and the items around it', () => {
    const md = ['- [ ] first', '<!--', '- [ ] parked', '  - [ ] nested and parked', '-->', '- [ ] second <!-- aside -->'];
    const items = scanMarkdown(md.join('\n')).listItems;
    expect(items.map((i) => i.firstLine)).toEqual(['first', 'second <!-- aside -->']);
  });

  it('does not end an item at a heading or a marker a comment holds', () => {
    const md = ['- [ ] Should we shard?', '<!--', '## Old notes', '- [ ] parked', '-->', '  Resolved: no.'].join('\n');
    const [item, ...rest] = scanMarkdown(md).listItems;
    expect(rest).toEqual([]);
    expect(item?.body).toContain('Resolved: no.');
    expect(item?.maskedBody).not.toContain('parked');
  });

  it('still ends an item at a blank line before an unindented comment', () => {
    const md = ['- [ ] first', '', '<!--', '- [ ] parked', '-->', 'Resolved: no.'].join('\n');
    expect(scanMarkdown(md).listItems.map((i) => i.body)).toEqual(['first']);
  });

  it('reads no table in a comment, nor a row of one a comment opens', () => {
    const tables = (md: string[]) => scanMarkdown(md.join('\n')).tables.map((t) => t.rows.map((r) => r.cells[0]?.text));
    expect(tables(['<!--', '| ID | Status |', '| -- | ------ |', '| ADR-9 | Accepted |', '-->'])).toEqual([]);
    expect(tables(['| ID | Status | <!--', '| -- | ------ |', '| ADR-9 | Accepted |', '-->'])).toEqual([]);
    expect(tables(['| ID | Status |', '| -- | ------ |', '| ADR-1 | Accepted | <!--', '| ADR-9 | Draft |', '-->'])).toEqual([
      ['ADR-1'],
    ]);
    expect(tables(['<!-- a register -->', '| ID | Status |', '| -- | ------ |', '| ADR-1 | Accepted |'])).toEqual([['ADR-1']]);
    // Masking hides the pipes of a row written wholly inside a comment. It does
    // not hide the ones after a comment that opens the line, which is HTML to
    // its end all the same, and begins no header and continues no table.
    expect(tables(['<!-- note --> | ID | Status |', '| -- | ------ |', '| ADR-1 | Accepted |'])).toEqual([]);
    expect(tables(['| ID | Status |', '| -- | ------ |', '| ADR-1 | Accepted |', '<!-- x --> | ADR-9 | Draft |'])).toEqual([
      ['ADR-1'],
    ]);
  });

  it('marks a line by its first character, not by where a comment on it starts', () => {
    const doc = scanMarkdown(['Prose <!-- a', '', 'still a -->', '', '  <!-- b --> after', 'x'].join('\n'));
    expect(doc.lines.map((l) => l.comment)).toEqual([false, false, true, false, true, false]);
  });
});

/**
 * ADR-0013 left three questions open, each a place where the scan found code
 * blocks before comments and so read structure out of what was not Markdown.
 * spec-core's scan finds comments while it finds blocks, so each is answered by
 * construction, and these hold the answers.
 */
describe('what ADR-0013 left open', () => {
  it('opens no fence inside a comment', () => {
    // It used to open one, and with no closer the rest of the document was code.
    const md = ['# ADR-0001: Title', '', '<!--', '```', '-->', '', '## Decision', '', 'Depends on [ADR-0002](0002-b.md).'];
    const doc = scanMarkdown(md.join('\n'));
    expect(doc.blocks).toEqual([]);
    expect(doc.headings.map((h) => h.text)).toEqual(['ADR-0001: Title', 'Decision']);
    expect(doc.links.map((l) => l.target)).toEqual(['0002-b.md']);
  });

  it('sets no list context from a marker inside a comment, so an indented block after it is code', () => {
    const md = ['<!--', '- a list marker', '-->', '', '    [ADR-0002](0002-b.md) in indented code'];
    const doc = scanMarkdown(md.join('\n'));
    expect(doc.blocks.map((b) => [b.kind, b.line])).toEqual([['indented', 5]]);
    expect(doc.links).toEqual([]);
    // Outside a comment the same marker does set it, and the line continues the item.
    const listed = scanMarkdown(['- a list marker', '', '    [ADR-0002](0002-b.md) continues it'].join('\n'));
    expect(listed.blocks).toEqual([]);
    expect(listed.links.map((l) => l.target)).toEqual(['0002-b.md']);
  });

  it('reads no heading, item, table or status inside <pre> or <script>', () => {
    const text = [
      '# ADR-0001: Raw',
      '',
      '<pre>',
      '## Not a heading',
      '- [ ] not an obligation',
      '| ID | Status |',
      '|----|--------|',
      '| R-1 | accepted |',
      '</pre>',
      '',
      '<script>',
      '# Nor this',
      '- [ ] nor this',
      '</script>',
      '',
      '## R-2: A section',
      '',
      '<pre>',
      'Status: accepted',
      '</pre>',
    ].join('\n');
    const doc = scanMarkdown(text);
    expect(doc.headings.map((h) => h.text)).toEqual(['ADR-0001: Raw', 'R-2: A section']);
    expect(doc.listItems).toEqual([]);
    expect(doc.tables).toEqual([]);
    // A status shown in a <pre> block is an example, so R-2 declares none and
    // is not a specification of its own.
    const { graph } = analyseSources([{ path: 'docs/adr/0001-raw.md', text }]);
    expect(graph.documents.map((n) => n.id)).toEqual(['ADR-0001']);
    const declared = analyseSources([{ path: 'docs/adr/0001-raw.md', text: text.replace('<pre>\nStatus', 'Status') }]);
    expect(declared.graph.documents.map((n) => n.id)).toEqual(['ADR-0001', 'R-2']);
  });

  it('reads no status from a status section that opens with raw HTML', () => {
    const status = (body: string) =>
      analyseSources([{ path: 'docs/adr/0001-a.md', text: `# ADR-0001: A\n\n## Status\n\n${body}\n` }]).graph.document('ADR-0001')
        ?.rawStatus;
    expect(status('<pre>\naccepted\n</pre>')).toBeNull();
    expect(status('Accepted')).toBe('Accepted');
  });
});

/**
 * Where spec-core's scan reads a document differently from the one it replaced,
 * spec-graph follows it, and a repository sees the difference in its graph.
 * Each is in the changelog; these hold what a user sees.
 */
describe('what the shared scan reads differently', () => {
  const edges = (...texts: [string, string][]) =>
    analyseSources(texts.map(([path, text]) => ({ path, text }))).graph.edges.filter((e) => e.kind !== 'contains');
  const B = ['docs/adr/0002-b.md', '# ADR-0002: B\n'] as [string, string];

  it('ends a code span with its paragraph, so a stray backtick hides nothing after it', () => {
    const text = '# ADR-0001: A\n\nAn unclosed `tick.\n\nDepends on [ADR-0002](0002-b.md).\n\nAnother tick` here.\n';
    expect(edges(['docs/adr/0001-a.md', text], B).map((e) => [e.kind, e.to])).toEqual([['depends-on', 'ADR-0002']]);
  });

  it('reads a heading as a renderer shows it, which moves the ids of the items under it', () => {
    const text = [
      '# ADR-0001: A <!-- draft -->',
      '',
      '## Open Questions <!-- short -->',
      '',
      '- Which?',
      '',
      '## Notes <!-- x -->',
      '',
      '- [ ] Checked?',
      '',
      '# C#',
    ].join('\n');
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text }]);
    expect(graph.document('ADR-0001')?.title).toBe('ADR-0001: A');
    // The comment kept the first section from reading as "Open Questions" at
    // all, and gave the second item the id `ADR-0001#notes----x---.1`.
    expect(graph.items.map((n) => n.id)).toEqual(['ADR-0001#open-questions.1', 'ADR-0001#notes.1']);
    // A closing run of `#` needs a space before it.
    expect(scanMarkdown(text).headings.map((h) => h.text)).toEqual(['ADR-0001: A', 'Open Questions', 'Notes', 'C#']);
  });

  it('reuses no setext underline, crosses no block quote with one, and reads `* * *` as a rule', () => {
    const doc = scanMarkdown(['Title', '===', '---', '', '> quoted', '---', '', '* * *'].join('\n'));
    expect(doc.headings.map((h) => h.text)).toEqual(['Title']);
    expect(doc.listItems).toEqual([]);
  });

  it('ends an item at a fence or a block quote no deeper than its marker', () => {
    const fenced = scanMarkdown(['- [ ] item', '```', 'code', '```', 'After [ADR-0002](0002-b.md).'].join('\n'));
    expect(fenced.listItems.map((i) => i.endLine)).toEqual([1]);
    const quoted = scanMarkdown(['- [ ] item', '> quote'].join('\n'));
    expect(quoted.listItems.map((i) => i.endLine)).toEqual([1]);
    // What followed the fence was the item's, and a relation written there was the item's too.
    const text = '# ADR-0001: A\n\n- [ ] item\n```\ncode\n```\nDepends on [ADR-0002](0002-b.md).\n';
    expect(edges(['docs/adr/0001-a.md', text], B).map((e) => e.from)).toEqual(['ADR-0001']);
  });

  it('closes every list at a heading, so an item after one is at depth 0', () => {
    const text = '# ADR-0001: A\n\n## Open Questions\n\n- a\n\n## Open Questions\n  - b\n';
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text }]);
    expect(graph.items.map((n) => n.title)).toEqual(['a', 'b']);
  });

  it('reads links as CommonMark does where spec-graph read them otherwise', () => {
    const text = [
      '# ADR-0001: A',
      '',
      'A [spaced](0002-b.md title-without-quotes) link is text.',
      '',
      '[foo](not a link) is a shortcut.',
      '',
      'A footnote[^1] and a note [Note] cite nothing.',
      '',
      '[^1]: 0002-b.md is where this came from.',
      '[Note]: this is prose, not a definition.',
      '[foo]: 0003-c.md',
      '',
      'See [outer [inner](0004-d.md) text].',
      '',
      'Label [Mixed   Case][] folded.',
      '',
      '[MIXED CASE]: 0005-e.md',
    ].join('\n');
    const others = ['0002-b', '0003-c', '0004-d', '0005-e'].map((name, k) => ({
      path: `docs/adr/${name}.md`,
      text: `# ADR-000${k + 2}: X\n`,
    }));
    const { graph, diagnostics } = analyseSources([{ path: 'docs/adr/0001-a.md', text }, ...others]);
    expect(graph.edges.filter((e) => e.kind !== 'contains').map((e) => [e.to, e.declaredAt.span.start.line])).toEqual([
      ['ADR-0003', 11],
      ['ADR-0004', 13],
      ['ADR-0005', 17],
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('reads a table only under a delimiter row with as many cells as its header', () => {
    const text = '# ADR-0001: A\n\n| ID | Status | Depends on |\n|----|--------|\n| R-1 | accepted | ADR-0002 |\n';
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text }, { path: B[0], text: B[1] }]);
    expect(graph.documents.map((n) => n.id)).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('ends a fence with its block quote, and reads an indented fence after a blank line as indented code', () => {
    const text = '# ADR-0001: A\n\n> ```\n> never closed\n\nDepends on [ADR-0002](0002-b.md).\n\n    ```\n    code\n\n## After\n\n- [ ] open\n';
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text }, { path: B[0], text: B[1] }]);
    expect(graph.edges.filter((e) => e.kind !== 'contains').map((e) => e.to)).toEqual(['ADR-0002']);
    expect(graph.items.map((n) => n.id)).toEqual(['ADR-0001#after.1']);
  });

  it("reads code four columns past a list item's text, and a fence that deep as no fence", () => {
    // Inside a list, four columns were never code, so a link in an example
    // indented under an item was a citation. And a fence opened at any depth:
    // one indented under a paragraph made the rest of the document code.
    const text = [
      '# ADR-0001: A',
      '',
      '- An item',
      '',
      '    still the item, citing [ADR-0002](0002-b.md)',
      '',
      '      [example](0009-missing.md) in code, four columns past the text',
      '',
      'A paragraph',
      '    ```',
      'that goes on.',
      '',
      '## Open Questions',
      '',
      '- [ ] open',
    ].join('\n');
    const { graph, diagnostics } = analyseSources([{ path: 'docs/adr/0001-a.md', text }, { path: B[0], text: B[1] }]);
    expect(graph.edges.filter((e) => e.kind !== 'contains').map((e) => e.to)).toEqual(['ADR-0002']);
    expect(diagnostics.map((d) => d.rule)).toEqual([]);
    expect(graph.items.filter((n) => n.openness === 'open').map((n) => n.id)).toEqual(['ADR-0001#open-questions.1']);
  });

  it('opens front matter only on exactly three dashes', () => {
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text: '----\nstatus: accepted\n----\n# ADR-0001: A\n' }]);
    expect(graph.document('ADR-0001')?.rawStatus).toBeNull();
  });
});

describe('anchorsOf', () => {
  it('answers to each slug, and to GitHub\'s anchor for a repeat of one', () => {
    const doc = scanMarkdown(['# Notes', '## Notes', '## Notes', '## Other'].join('\n'));
    expect([...anchorsOf(doc.headings)].sort()).toEqual(['notes', 'notes-1', 'notes-2', 'other']);
    expect([...anchorsOf(doc.headings.slice(2))].sort()).toEqual(['notes', 'notes-2', 'other']);
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
