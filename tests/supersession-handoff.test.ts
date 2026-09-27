import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * A superseded document handing its open question to the document that
 * replaced it.
 *
 * `circular-delegation` reports "obligations or supersessions in a cycle, so
 * none can ever land" (README). ADR-0002 supersedes ADR-0001 and ADR-0001
 * defers its question to ADR-0002 is a loop only once both are projected onto
 * documents: the question lands on the live successor and nothing hands it
 * back. Reporting it would be a false alarm on the most ordinary thing a
 * superseded decision does (ADR-0006).
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every circular-delegation finding, as its message and the documents in it. */
function cycles(files: Record<string, string>): { message: string; nodes: string[] }[] {
  return analyse(files)
    .diagnostics.filter((diagnostic) => diagnostic.rule === 'circular-delegation')
    .map((diagnostic) => ({ message: diagnostic.message, nodes: [...diagnostic.nodes].sort() }));
}

const doc = (frontMatter: string, body: string): string => `---\n${frontMatter}\n---\n\n${body}\n`;

const question = (title: string, target: string, path: string): string =>
  `# ${title}\n\n## Open Questions\n\n- [ ] Who owns retention? Deferred to [${target}](${path}).`;

describe('a superseded document handing its question to its successor', () => {
  it.each([
    [
      'the successor declares the supersession',
      doc('status: superseded', question('Old', 'ADR-0002', '0002-new.md')),
      doc('status: accepted\nsupersedes: ADR-0001', '# New'),
    ],
    [
      'the superseded document declares it in its status',
      doc('status: Superseded by ADR-0002', question('Old', 'ADR-0002', '0002-new.md')),
      doc('status: accepted', '# New'),
    ],
    [
      'the whole document is delegated rather than one question',
      doc('status: superseded\ndelegates-to: ADR-0002', '# Old'),
      doc('status: accepted\nsupersedes: ADR-0001', '# New'),
    ],
    [
      'the question is handed to one of the successor’s own items',
      doc('status: superseded', question('Old', 'retention', '0002-new.md#retention')),
      doc(
        'status: accepted\nsupersedes: ADR-0001',
        '# New\n\n## Open Questions\n\n<!-- @spec-item id="retention" -->\n- [ ] Who owns retention?',
      ),
    ],
  ])('closes no cycle when %s', (_, old, replacement) => {
    expect(cycles({ 'docs/adr/0001-old.md': old, 'docs/adr/0002-new.md': replacement })).toEqual([]);
  });

  it('is still a relation in the graph, and the supersession beside it', () => {
    const { graph } = analyse({
      'docs/adr/0001-old.md': doc('status: superseded', question('Old', 'ADR-0002', '0002-new.md')),
      'docs/adr/0002-new.md': doc('status: accepted\nsupersedes: ADR-0001', '# New'),
    });
    expect(
      graph.edges
        .filter((edge) => edge.kind !== 'contains')
        .map((edge) => `${edge.from} ${edge.kind} ${edge.to}`)
        .sort(),
    ).toEqual(['ADR-0001#open-questions.1 delegates-to ADR-0002', 'ADR-0002 supersedes ADR-0001']);
  });
});

describe('a cycle the hand-off does not excuse', () => {
  const pingPong = {
    'docs/adr/0001-a.md': doc('status: accepted', question('A', 'ADR-0002', '0002-b.md')),
    'docs/adr/0002-b.md': doc('status: accepted', question('B', 'ADR-0001', '0001-a.md')),
  };

  it('is two documents passing a question back and forth, neither superseding the other', () => {
    expect(cycles(pingPong)).toEqual([
      { message: 'delegation cycle across 2 documents: nothing in it can ever land', nodes: ['ADR-0001', 'ADR-0002'] },
    ]);
  });

  it('is still reported when one of them superseded some other document', () => {
    const files = {
      ...pingPong,
      'docs/adr/0002-b.md': doc('status: accepted\nsupersedes: ADR-0003', question('B', 'ADR-0001', '0001-a.md')),
      'docs/adr/0003-c.md': doc('status: superseded', question('C', 'ADR-0002', '0002-b.md')),
    };
    expect(cycles(files).map((cycle) => cycle.nodes)).toEqual([['ADR-0001', 'ADR-0002']]);
  });

  it('is a question handed on to a document that replaced nobody, and names only that loop', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-old.md': doc(
        'status: superseded',
        `${question('Old', 'ADR-0002', '0002-new.md')}\n- [ ] Who owns backups? Deferred to [ADR-0003](0003-c.md).`,
      ),
      'docs/adr/0002-new.md': doc('status: accepted\nsupersedes: ADR-0001', '# New'),
      'docs/adr/0003-c.md': doc('status: accepted', question('C', 'ADR-0001', '0001-old.md')),
    });
    const found = diagnostics.filter((diagnostic) => diagnostic.rule === 'circular-delegation');
    expect(found.map((diagnostic) => [...diagnostic.nodes].sort())).toEqual([['ADR-0001', 'ADR-0003']]);
    expect(found[0]?.related.map((related) => related.note)).toEqual([
      'ADR-0001#open-questions.2 delegates to ADR-0003',
      'ADR-0003#open-questions.1 delegates to ADR-0001',
    ]);
  });

  it('is two documents superseding each other, which the hand-off leaves a supersession cycle', () => {
    expect(
      cycles({
        'docs/adr/0001-a.md': doc('status: superseded\nsupersedes: ADR-0002', question('A', 'ADR-0002', '0002-b.md')),
        'docs/adr/0002-b.md': doc('status: superseded\nsupersedes: ADR-0001', '# B'),
      }),
    ).toEqual([{ message: 'supersession cycle across 2 documents', nodes: ['ADR-0001', 'ADR-0002'] }]);
  });
});
