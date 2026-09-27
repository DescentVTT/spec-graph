import { describe, expect, it } from 'vitest';

import { extractDocument, type ExtractedDocument } from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { EdgeKind, SourceRef } from '../src/types.js';

/**
 * What extraction decides about each citation: what it is, which way it runs,
 * where it was written, and when two readings of one citation are one.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** The file's own specification. None of these documents opts out. */
function extract(text: string, path = 'docs/adr/0001-a.md'): ExtractedDocument {
  const extracted = extractDocument({ path, text });
  if (extracted === null) throw new Error(`${path} opted out`);
  return extracted;
}

const covered = (text: string, at: SourceRef): string => text.slice(at.span.start.offset, at.span.end.offset);

/** How the one link in `text` to `0002-b.md` reads. */
function reading(text: string): { kind: EdgeKind; inverted: boolean } | undefined {
  const found = extract(text).references.find((reference) => reference.target === '0002-b.md');
  return found && { kind: found.kind, inverted: found.inverted };
}

const REFERENCES = { kind: 'references', inverted: false } as const;

describe('what an edge records about where it was written', () => {
  // An edge's origin says which of the four places declared it, and its raw
  // text is what produced it (`Edge` in types.ts): the JSON export carries the
  // first, and a program that shows an edge to a reader shows the second.
  it('names the origin and keeps the text of every way a relation is written', () => {
    const files = {
      'docs/adr/0001-a.md': [
        '---',
        'depends-on: ADR-0002',
        'status: Superseded by ADR-0003',
        '---',
        '',
        '# A',
        '',
        '<!-- @spec-edge kind="blocked-by" to="ADR-0004" -->',
        '<!-- @spec-edge kind="assumes" from="ADR-0005" -->',
        '',
        'Constrained by [ADR-0006](0006-f.md), and as decided in ADR-0007.',
      ].join('\n'),
      'docs/adr/0002-b.md': '# B\n',
      'docs/adr/0003-c.md': '# C\n',
      'docs/adr/0004-d.md': '# D\n',
      'docs/adr/0005-e.md': '# E\n',
      'docs/adr/0006-f.md': '# F\n',
      'docs/adr/0007-g.md': '# G\n',
    };
    const edges = analyse(files).graph.edges.map(
      (edge) => `${edge.from} -${edge.kind}-> ${edge.to} | ${edge.origin} | ${edge.raw}`,
    );
    expect(edges.sort()).toEqual([
      'ADR-0001 -assumes-> ADR-0006 | link | [ADR-0006](0006-f.md)',
      'ADR-0001 -assumes-> ADR-0007 | text | ADR-0007',
      'ADR-0001 -blocked-by-> ADR-0004 | directive | @spec-edge kind="blocked-by" to="ADR-0004"',
      'ADR-0001 -depends-on-> ADR-0002 | front-matter | depends-on: ADR-0002',
      'ADR-0003 -supersedes-> ADR-0001 | front-matter | Superseded by ADR-0003',
      'ADR-0005 -assumes-> ADR-0001 | directive | @spec-edge kind="assumes" from="ADR-0005"',
    ]);
  });

  it('keeps a reference link as it was written', () => {
    const { references } = extract('# A\n\nSee [ADR-0003][c].\n\n[c]: 0003-c.md\n');
    expect(references.map((reference) => reference.raw)).toEqual(['[ADR-0003][c]']);
  });
});

describe('a @spec-edge naming a document the repository does not have', () => {
  it('is reported in either direction, as every deliberate reference is', () => {
    // "A link, a front-matter field or a directive that does not resolve is a
    // broken foreign key and is reported" (README) - even in a family the
    // repository has never heard of, which would silence a bare mention.
    const { corpus } = analyse({
      'docs/adr/0001-a.md': [
        '# A',
        '',
        '<!-- @spec-edge kind="depends-on" to="SEC-0042" -->',
        '<!-- @spec-edge kind="depends-on" from="SEC-0043" -->',
      ].join('\n'),
    });
    expect(corpus.dangling.map((ref) => ref.target)).toEqual(['SEC-0042', 'SEC-0043']);
  });
});

describe('a directive that is not a @spec-edge', () => {
  it('declares no edge, whatever attributes it carries', () => {
    const { references } = extract('<!-- @spec-node kind="depends-on" to="ADR-0002" -->\n\n# A\n');
    expect(references.filter((reference) => reference.origin === 'directive')).toEqual([]);
  });
});

describe('a relation written with nothing in it', () => {
  it('is no relation, where front matter holds a placeholder', () => {
    const { corpus } = analyse({ 'docs/adr/0001-a.md': '---\nsupersedes: "..."\n---\n\n# A\n' });
    expect([corpus.edges, corpus.dangling]).toEqual([[], []]);
  });

  it('is no citation, where a status names a placeholder for its successor', () => {
    expect(extract('---\nstatus: Superseded by ...\n---\n\n# A\n').references).toEqual([]);
  });

  it('is not reported when a status names its successor in words rather than by identifier', () => {
    // Only a deliberate reference is validated (README); a status line is prose
    // that happens to name a successor, and "the multi-writer design" is not a
    // foreign key anybody wrote.
    const text = '---\nstatus: Superseded by the multi-writer design\n---\n\n# A\n';
    const { corpus } = analyse({ 'docs/adr/0001-a.md': text });
    expect(corpus.dangling).toEqual([]);
  });
});

describe('a link that is not a citation', () => {
  it('points at another site', () => {
    expect(extract('# A\n\nSee [the RFC](https://example.com/adr-0007).\n').references).toEqual([]);
  });

  it('has only a placeholder for a destination', () => {
    expect(extract('# A\n\nThe policy goes in [ADR-XXXX](...) once it is written.\n').references).toEqual([]);
  });
});

describe('a link inside the text of another', () => {
  // CommonMark reads the inner one as the link, and the brackets around it and
  // the destination after them as text, so the rendered page links to ADR-0002
  // and nowhere else (spec-core's ADR-0004). The outer destination was the one
  // edge drawn, and the document the reader can follow was cited by none.
  it('cites the inner target alone, in every bracket form', () => {
    const files = (body: string) => ({
      'docs/adr/0001-a.md': `# A\n\n${body}\n`,
      'docs/adr/0002-b.md': '# B\n',
      'docs/adr/0003-c.md': '# C\n',
    });
    for (const [body, raw] of [
      ['See [a [ADR-0002](0002-b.md) c](0003-c.md).', '[ADR-0002](0002-b.md)'],
      ['See [a [ADR-0002] c](0003-c.md).\n\n[ADR-0002]: 0002-b.md', '[ADR-0002][ADR-0002]'],
    ] as const) {
      const { graph, diagnostics } = analyse(files(body));
      expect(graph.edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to} | ${edge.raw}`), body).toEqual([
        `ADR-0001 -references-> ADR-0002 | ${raw}`,
      ]);
      expect(diagnostics, body).toEqual([]);
    }
  });
});

/** Each link `body` cites, by target and as it was written. */
function links(body: string): string[] {
  return extract(`# A\n\n${body}\n`)
    .references.filter((reference) => reference.origin === 'link')
    .map((reference) => `${reference.target} | ${reference.raw}`);
}

describe('a link reference definition', () => {
  // CommonMark's, as spec-core reads it from 65ef842 (spec-core's ADR-0004): a
  // definition cannot interrupt a paragraph, and its label holds no unescaped
  // bracket and at most 999 characters.
  it('defines nothing on the line under a paragraph, so a reference through it cites nothing', () => {
    // A renderer shows that line as the paragraph's text, and the reference as
    // text too. It was a definition, and the reference an edge to ADR-0002.
    for (const above of ['Some text', '> Quoted text', '- An item']) {
      const { graph, diagnostics } = analyse({
        'docs/adr/0001-a.md': `# A\n\nSee [the record][r].\n\n${above}\n[r]: 0002-b.md\n`,
        'docs/adr/0002-b.md': '# B\n',
      });
      expect([graph.edges, diagnostics], above).toEqual([[], []]);
    }
  });

  it('leaves the identifiers on such a line to be read as prose', () => {
    expect(bare('Some text\n[ADR-0003]: 0003-c.md')).toEqual(['ADR-0003']);
    // A label of more than 999 characters is no label, wherever it is written.
    expect(bare(`[ADR-0003${' x'.repeat(500)}]: 0003-c.md`)).toEqual(['ADR-0003']);
  });

  it('still defines where it opens a paragraph or a block quote, or follows a heading, a rule, code, a comment or a definition', () => {
    for (const written of [
      '[r]: 0002-b.md',
      'Some text\n> [r]: 0002-b.md',
      'Records\n===\n[r]: 0002-b.md',
      '***\n[r]: 0002-b.md',
      '```\ncode\n```\n[r]: 0002-b.md',
      '<!-- a note -->\n[r]: 0002-b.md',
      '[s]: 0003-c.md\n[r]: 0002-b.md',
    ]) {
      expect(links(`See [the record][r].\n\n${written}`), written).toEqual(['0002-b.md | [the record][r]']);
    }
  });

  it('holds no bracket in its label, so what looked like one can be a link', () => {
    // It was a definition of `r.md](0002-b.md)` under the label `[r`, and cited nothing.
    expect(links('[[r]: r.md](0002-b.md)')).toEqual(['0002-b.md | [[r]: r.md](0002-b.md)']);
  });

  it('holds an escaped bracket in its label', () => {
    expect(links('See [a\\]b].\n\n[a\\]b]: 0002-b.md')).toEqual(['0002-b.md | [a\\]b][a\\]b]']);
  });
});

describe('a reference link whose second bracket is no label', () => {
  // The second bracket of a full reference is a link label, and one holding a
  // bracket or more than 999 characters is not: the first bracket is then read
  // as a shortcut, as commonmark.js reads it. It cited nothing.
  it('cites through its first bracket', () => {
    for (const second of ['[a[b]c]', `[${'x'.repeat(1000)}]`]) {
      expect(links(`See [r]${second}.\n\n[r]: 0002-b.md`), second.slice(0, 9)).toEqual(['0002-b.md | [r][r]']);
    }
  });

  it('cites nothing when its second bracket is a label nothing defines', () => {
    expect(links('See [r][abc].\n\n[r]: 0002-b.md')).toEqual([]);
  });
});

describe('one citation, one reference', () => {
  it('does not count a linked document again where prose names it', () => {
    for (const link of ['[[ADR-0007]]', '[[ADR-0007#scope]]']) {
      const { references } = extract(`# A\n\nSee ${link}. We still rely on ADR-0007.\n`);
      expect(references.map((reference) => reference.origin), link).toEqual(['link']);
    }
  });

  it('reads every entry of a front-matter list, though they share one line', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\ndepends-on: [ADR-0002, ADR-0003]\n---\n\n# A\n',
      'docs/adr/0002-b.md': '# B\n',
      'docs/adr/0003-c.md': '# C\n',
    });
    expect(graph.out('ADR-0001').map((edge) => edge.to)).toEqual(['ADR-0002', 'ADR-0003']);
  });

  it('keeps two readings of one place apart when they claim different relations', () => {
    // `Superseded (ADR-0009)` is a supersession to the status reader and, to
    // prose scanning, a bare citation with no phrase governing it. Collapsing
    // the two would keep the narrower - and lose the supersession.
    const { graph } = analyse({
      'docs/adr/0001-a.md': '# A\n\n## Status\n\nSuperseded (ADR-0009)\n',
      'docs/adr/0009-i.md': '# I\n',
    });
    expect(graph.edges.map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`).sort()).toEqual([
      'ADR-0001 -references-> ADR-0009',
      'ADR-0009 -supersedes-> ADR-0001',
    ]);
  });

  it('keeps a citation written earlier than one it matches, since the two do not overlap', () => {
    const text = [
      '# A',
      '',
      'As decided in ADR-0007, writes are sharded.',
      '',
      '<!-- @spec-edge kind="assumes" to="ADR-0007" -->',
    ].join('\n');
    const lines = extract(text).references.map((reference) => reference.declaredAt.span.start.line);
    expect(lines.sort()).toEqual([3, 5]);
  });
});

describe('a governing phrase', () => {
  // "A phrase governs a reference when it stands no more than 40 characters
  // before it, in the same statement: a sentence, a paragraph, a list item or a
  // table cell. A negation between the two cancels it." (README)
  const DELEGATES = { kind: 'delegates-to', inverted: false } as const;

  it('reaches across a short noun phrase to the reference', () => {
    expect(reading('# A\n\nDeferred to the sharding decision in [ADR-0002](0002-b.md).\n')).toEqual(DELEGATES);
  });

  it('reaches exactly 40 characters and no further', () => {
    const gap = ' the sharding decision made last spring ';
    expect(gap).toHaveLength(40);
    const beyond = gap.replace('spring', 'springs');
    expect(reading(`# A\n\nDeferred to${gap}[ADR-0002](0002-b.md).\n`)).toEqual(DELEGATES);
    expect(reading(`# A\n\nDeferred to${beyond}[ADR-0002](0002-b.md).\n`)).toEqual(REFERENCES);
  });

  it('does not reach a reference far along the same sentence', () => {
    const text =
      '# A\n\nThe choice was deferred to the steering group, which met in March and later circulated ' +
      '[ADR-0002](0002-b.md).\n';
    expect(reading(text)).toEqual(REFERENCES);
  });

  it('is cancelled by a negation after it, and not by one before it', () => {
    expect(reading('# A\n\nNot in this release: deferred to [ADR-0002](0002-b.md).\n')).toEqual(DELEGATES);
  });

  it('is not cancelled by a word that only begins like a negation', () => {
    expect(reading('# A\n\nDeferred to the notification design in [ADR-0002](0002-b.md).\n')).toEqual(DELEGATES);
  });

  it('survives a line break inside it, however far the next line is indented', () => {
    const text = '# A\n\n## Open Questions\n\n- [ ] Which policy applies? Deferred\n      to [ADR-0002](0002-b.md).\n';
    expect(reading(text)).toEqual(DELEGATES);
  });
});

describe('a statement ends', () => {
  const BLOCKED = '- Blocked by the vendor';
  const after = (separator: string) =>
    reading(`# A\n\n${BLOCKED}${separator}[ADR-0002](0002-b.md) describes the fallback.\n`);

  it('at a blank line', () => {
    expect(after('\n\n')).toEqual(REFERENCES);
  });

  it('at a line holding nothing but spaces', () => {
    expect(after('\n   \n')).toEqual(REFERENCES);
  });

  it('at the next list item, nested or not', () => {
    expect(after('\n- ')).toEqual(REFERENCES);
    expect(after('\n  - ')).toEqual(REFERENCES);
  });

  it('and not at a line break inside one', () => {
    expect(after('\n  ')).toEqual({ kind: 'blocked-by', inverted: false });
  });
});

describe('a phrase that follows the reference', () => {
  it('makes the reference its subject, emphasised or not', () => {
    const text = '# A\n\n[ADR-0002](0002-b.md) *deferred* to this decision the choice of shard key.\n';
    expect(reading(text)).toEqual({ kind: 'delegates-to', inverted: true });
  });

  it('does not reach into the next paragraph', () => {
    // "Replaces the old cache" is this document speaking. Read as the link's
    // predicate, it would have ADR-0002 retire this document.
    expect(reading('# A\n\nThe replacement is [ADR-0002](0002-b.md)\n\nReplaces the old cache entirely.\n')).toEqual(
      REFERENCES,
    );
  });

  it('claims nothing when it is a depends-on phrase', () => {
    // "`[ADR-0002](0002.md) requires a migration` says nothing about this
    // document." (README)
    expect(reading('# A\n\n[ADR-0002](0002-b.md) requires a schema migration.\n')).toEqual(REFERENCES);
  });

  it('claims nothing when it already points back, rather than reading it backwards', () => {
    // `[ADR-0002] blocks this` means this document is blocked by ADR-0002. The
    // subject-first reading would have ADR-0002 blocked by this one instead.
    expect(reading('# A\n\n[ADR-0002](0002-b.md) blocks this rollout.\n')).toEqual(REFERENCES);
  });
});

/** The identifiers prose in `line` yields, with the text each one covers. */
function bare(line: string): string[] {
  const text = `# A\n\n${line}\n`;
  return extract(text)
    .references.filter((reference) => reference.origin === 'text')
    .map((reference) => covered(text, reference.declaredAt));
}

describe('an identifier in prose', () => {
  it('is not one when it is glued to a path or an extension', () => {
    expect(bare('Kept as archive/ADR-0003, notes.ADR-0004 and ADR-0005/draft, beside ADR-0006.')).toEqual(['ADR-0006']);
  });

  it('is pointed at exactly, after a link on the same line', () => {
    expect(bare('See [ADR-0001](0001-a.md), then as decided in ADR-0006 and RFC-0012.')).toEqual([
      'ADR-0006',
      'RFC-0012',
    ]);
  });
});

describe('a target wearing Markdown', () => {
  it('sheds the brackets of a wiki link written in front matter', () => {
    const { graph, corpus } = analyse({
      'docs/adr/0001-a.md': '---\nrelated: "[[ADR-0002]]"\n---\n\n# A\n',
      'docs/adr/0002-b.md': '# B\n',
    });
    expect([graph.out('ADR-0001').map((edge) => edge.to), corpus.dangling]).toEqual([['ADR-0002'], []]);
    // And a finding about one that names nothing quotes the name, not the brackets.
    const missing = analyse({ 'docs/adr/0001-a.md': '---\nrelated: "[[ADR-0099]]"\n---\n\n# A\n' });
    expect(missing.corpus.dangling.map((ref) => ref.target)).toEqual(['ADR-0099']);
  });

  it('keeps the parentheses a file name holds', () => {
    const text = '# A\n\nSee [the cache](0002-cache(v2).md).\n';
    expect(extract(text).references.map((reference) => reference.target)).toEqual(['0002-cache(v2).md']);
    const { graph } = analyse({ 'docs/adr/0001-a.md': text, 'docs/adr/0002-cache(v2).md': '# Cache\n' });
    expect(graph.out('ADR-0001').map((edge) => edge.to)).toEqual(['ADR-0002']);
  });

  it('sheds the punctuation that ends the sentence around it', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: Superseded by ADR-0002.\n---\n\n# A\n',
      'docs/adr/0002-b.md': '# B\n',
    });
    expect(graph.in('ADR-0001').map((edge) => `${edge.from} -${edge.kind}->`)).toEqual(['ADR-0002 -supersedes->']);
    const missing = analyse({ 'docs/adr/0001-a.md': '---\nstatus: Superseded by ADR-0099...\n---\n\n# A\n' });
    expect(missing.corpus.dangling.map((ref) => ref.target)).toEqual(['ADR-0099']);
  });
});

describe('a front-matter key one edit from a relation', () => {
  const check = (frontMatter: string) =>
    analyse({
      'docs/adr/0001-a.md': `---\n${frontMatter}\n---\n\n# A\n`,
      'docs/adr/0002-b.md': '# B\n',
    }).diagnostics.filter((diagnostic) => diagnostic.rule === 'unknown-relation-key');

  it('is reported when it carries a path to a document, quoted or not', () => {
    // ADR-0014: "a prefixed identifier, or a path with a document extension".
    expect(check('supercedes-by: 0002-b.md')).toHaveLength(1);
    expect(check('supercedes-by: " 0002-b.md "')).toHaveLength(1);
  });

  it('is not reported when the path leads off the site, or is blank', () => {
    expect(check('supercedes-by: https://example.com/0002-b.md')).toEqual([]);
    expect(check('supercedes-by: "  "')).toEqual([]);
  });

  it('names every relation it could have meant, as a list the author can read', () => {
    const [found] = check('referencs: ADR-0002');
    expect(found?.hint).toBe('spell it references, reference, or move it out of front matter if it is not a relation');
  });
});
