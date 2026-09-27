import { describe, expect, it } from 'vitest';

import { attr, directiveFor, parseDirectives, type Directive } from '../src/directives.js';
import { scanMarkdown, type ListItem } from '../src/markdown.js';

/**
 * Which directive annotates a region, as `directiveFor` answers it for a caller
 * of the API: one written inside the region, or one above it within the
 * look-behind the caller gives, the closest winning. Extraction binds items
 * with `bindItemDirectives` instead; this is the general question, asked of any
 * span of text.
 */

function scanned(...lines: string[]): { text: string; items: readonly ListItem[]; directives: Directive[] } {
  const text = lines.join('\n');
  const doc = scanMarkdown(text);
  return { text, items: doc.listItems, directives: parseDirectives(doc.comments) };
}

const span = (item: ListItem | undefined): { start: number; end: number } => {
  if (item === undefined) throw new Error('no such item');
  return { start: item.start, end: item.end };
};

const id = (directive: Directive | null): string | null => (directive === null ? null : (attr(directive, 'id')?.value ?? null));

describe('the directive for a region', () => {
  it('is only ever one of the kind asked for', () => {
    const { items, directives } = scanned('<!-- @spec-node id="ADR-0001" -->', '- [ ] first');
    expect(id(directiveFor(directives, 'spec-item', span(items[0]), 100))).toBeNull();
    expect(id(directiveFor(directives, 'spec-node', span(items[0]), 100))).toBe('ADR-0001');
  });

  it('is one written inside the region, and never one written after it', () => {
    const { items, directives } = scanned('- [ ] first <!-- @spec-item id="one" -->', '- [ ] second <!-- @spec-item id="two" -->');
    expect(id(directiveFor(directives, 'spec-item', span(items[0]), 100))).toBe('one');
    expect(id(directiveFor(directives, 'spec-item', span(items[1]), 0))).toBe('two');
  });

  it('may sit at either edge of the region and still be inside it', () => {
    const opening = '<!-- @spec-node id="ADR-0001" -->\n\n# One\n';
    const closing = '# One\n\n<!-- @spec-node id="ADR-0001" -->';
    for (const text of [opening, closing]) {
      const directives = parseDirectives(scanMarkdown(text).comments);
      expect(id(directiveFor(directives, 'spec-node', { start: 0, end: text.length }, 0)), text).toBe('ADR-0001');
    }
  });

  it('may sit above the region by as many characters as the look-behind allows, and no more', () => {
    const { items, directives } = scanned('<!-- @spec-item id="one" -->', '- [ ] first');
    // One line break lies between the comment and the item.
    expect(id(directiveFor(directives, 'spec-item', span(items[0]), 1))).toBe('one');
    expect(id(directiveFor(directives, 'spec-item', span(items[0]), 0))).toBeNull();
    // Directly against the region, it is in reach of no look-behind at all.
    const [directive] = directives;
    const text = '<!-- @spec-item id="one" -->\n- [ ] first';
    expect(id(directiveFor(directives, 'spec-item', { start: directive?.end ?? 0, end: text.length }, 0))).toBe('one');
  });

  it('is the closest of several, whatever order they are handed over in', () => {
    const { items, directives } = scanned('<!-- @spec-item id="far" -->', '<!-- @spec-item id="near" -->', '- [ ] first');
    expect(id(directiveFor(directives, 'spec-item', span(items[0]), 100))).toBe('near');
    expect(id(directiveFor([...directives].reverse(), 'spec-item', span(items[0]), 100))).toBe('near');
  });
});
