import { describe, expect, it } from 'vitest';

import { extractDocument, type ExtractedDocument } from '../src/extract.js';

/**
 * Which bullets extraction makes obligations, what it calls them, and how it
 * quotes them back. An item's id is what a baseline and a diff key on
 * (ADR-0020), and its text is what a finding quotes to the reader.
 */

function extract(text: string): ExtractedDocument {
  const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text });
  if (extracted === null) throw new Error('the document opted out');
  return extracted;
}

const items = (text: string) => extract(text).items;

describe('an obligation above every heading', () => {
  it('is numbered under the document itself', () => {
    const found = items('- [ ] Which shard key?\n- [ ] Which region?\n\n# A\n');
    expect(found.map((item) => item.id)).toEqual(['ADR-0001#item.1', 'ADR-0001#item.2']);
  });
});

describe('a @spec-item directive', () => {
  it('makes a plain bullet an obligation, wherever it is', () => {
    const found = items('# A\n\n## Context\n\n<!-- @spec-item state="narrowed" -->\n- Only the payment path\n');
    expect(found.map((item) => item.text)).toEqual(['Only the payment path']);
  });

  it('with no id leaves the item numbered, and says its id was not declared', () => {
    // "because `open-questions.1` could be either" (ADR-0020): only a declared
    // id names the same item across a rewording, so a diff must be told which.
    const [item] = items('# A\n\n## Context\n\n<!-- @spec-item state="narrowed" -->\n- Only the payment path\n');
    expect([item?.id, item?.declared]).toEqual(['ADR-0001#context.1', false]);
  });

  it('with an id names the item, and says so', () => {
    const [item] = items('# A\n\n## Open Questions\n\n<!-- @spec-item id="shard-key" -->\n- [ ] Which key?\n');
    expect([item?.id, item?.declared]).toEqual(['ADR-0001#shard-key', true]);
  });

  it('gives the item the title it names, and leaves its text as written', () => {
    const [item] = items(
      '# A\n\n## Open Questions\n\n<!-- @spec-item title="Pick a shard key" -->\n- [ ] Which key do we shard on?\n',
    );
    expect([item?.title, item?.text]).toEqual(['Pick a shard key', 'Which key do we shard on?']);
  });
});

describe('an obligation section', () => {
  const TEXT = [
    '# A',
    '',
    '## Open Questions',
    '',
    '- Which shard key?',
    '',
    '### Storage',
    '',
    '- Which disk class?',
    '',
    '## Decision',
    '',
    '- Shard by tenant.',
  ].join('\n');

  it('holds the bullets of its subsections, and ends at the next heading of its level', () => {
    // "The section ends at the next heading of its level" (README).
    expect(items(TEXT).map((item) => item.text)).toEqual(['Which shard key?', 'Which disk class?']);
  });

  it('records the headings an obligation sits under, outermost first', () => {
    expect(items(TEXT).map((item) => item.section)).toEqual([
      ['A', 'Open Questions'],
      ['A', 'Open Questions', 'Storage'],
    ]);
  });
});

describe('how an obligation is quoted', () => {
  const quoted = (bullet: string) => items(`# A\n\n## Open Questions\n\n- [ ] ${bullet}\n`).map((item) => item.text);

  it('reads a wiki link as the name a reader sees', () => {
    expect(quoted('Settled in [[ADR-0007]] or [[0008-cache|the cache decision]]?')).toEqual([
      'Settled in ADR-0007 or the cache decision?',
    ]);
  });

  it('is one line of single-spaced prose', () => {
    expect(quoted('Which   shard  key, and when?  ')).toEqual(['Which shard key, and when?']);
  });

  it('starts at its first word when it opens with a picture that has no words', () => {
    expect(quoted('![](warning.svg) Which shard key?')).toEqual(['Which shard key?']);
  });

  it('keeps a line of 120 characters whole, and shortens a longer one', () => {
    const exact = `${'a'.repeat(59)} ${'b'.repeat(60)}`;
    expect(exact).toHaveLength(120);
    expect(quoted(exact)).toEqual([exact]);
    expect(quoted(`${exact}c`)).toEqual([`${exact.slice(0, 117)}...`]);
  });
});

describe('the obligation a relation is written in', () => {
  it('is the innermost one, when obligations nest', () => {
    const text = [
      '# A',
      '',
      '## Open Questions',
      '',
      '- [ ] Which shard key?',
      '  - [ ] And its range? Deferred to [ADR-0002](0002-b.md).',
    ].join('\n');
    const [reference] = extract(text).references;
    expect(reference?.from).toBe('ADR-0001#open-questions.2');
  });
});
