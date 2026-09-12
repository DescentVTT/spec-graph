import { describe, expect, it } from 'vitest';

import { scanMarkdown } from '../src/markdown.js';
import { formatGraph } from '../src/report.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { AnyRuleId } from '../src/types.js';

/**
 * Registers: files that hold many specifications rather than one.
 *
 * A specification is a region of a file, not a file. See ADR-0009. The bar for
 * calling a region a specification is deliberately high - an identifier *and* a
 * status, or an identifier column *and* a status or relation column - because
 * one signal alone matches `## Q3 2026 Roadmap` and `## v1.2.0`.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

const rules = (files: Record<string, string>): AnyRuleId[] => analyse(files).diagnostics.map((d) => d.rule);
const ids = (files: Record<string, string>): string[] =>
  analyse(files)
    .corpus.documents.map((d) => d.id)
    .sort();

const REGISTER = [
  '# Architecture Register',
  '',
  'The single authority for platform decisions.',
  '',
  '## ADR-0001: Use one writer',
  '',
  '**Status:** Superseded by ADR-0003',
  '',
  'One process owns every write.',
  '',
  '## ADR-0002: Cache eviction',
  '',
  '**Status:** accepted',
  '',
  'This depends on ADR-0001.',
  '',
  '### Open Questions',
  '',
  '- [ ] Which policy? Deferred to ADR-0001.',
  '',
  '## ADR-0003: Many writers',
  '',
  '**Status:** accepted',
  '',
  'Writes are accepted on any node.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Headings                                                                   */
/* -------------------------------------------------------------------------- */

describe('a register written as headings', () => {
  const files = { 'docs/register.md': REGISTER };

  it('yields one specification per section, plus the file', () => {
    expect(ids(files)).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003', 'register']);
  });

  it('reads each section its own lifecycle', () => {
    const { graph } = analyse(files);
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
    expect(graph.document('ADR-0002')?.phase).toBe('active');
    expect(graph.document('ADR-0003')?.phase).toBe('active');
    // The file itself declares nothing, and is not made to.
    expect(graph.document('register')?.phase).toBe('unknown');
  });

  it('anchors a specification at its own heading, not at line one', () => {
    const { graph } = analyse(files);
    const second = graph.document('ADR-0002');
    expect(second?.at.file).toBe('docs/register.md');
    expect(second?.at.span.start.line).toBe(11);
  });

  it('attributes an obligation to its section rather than to the file', () => {
    const { corpus } = analyse(files);
    expect(corpus.items).toHaveLength(1);
    expect(corpus.items[0]?.document).toBe('ADR-0002');
    expect(corpus.items[0]?.id).toBe('ADR-0002#open-questions.1');
  });

  it('resolves relations between sections of one file', () => {
    const { graph } = analyse(files);
    expect(graph.out('ADR-0002', ['depends-on']).map((e) => e.to)).toEqual(['ADR-0001']);
    expect(graph.in('ADR-0001', ['supersedes']).map((e) => e.from)).toEqual(['ADR-0003']);
  });

  it('finds the defects that were invisible while the file was one node', () => {
    const found = rules(files);
    // An open question handed to a decision this same file supersedes.
    expect(found).toContain('ghost-handover');
    // And a live decision resting on it.
    expect(found).toContain('stale-premise');
  });

  it('numbers obligations within their own specification', () => {
    const two = {
      'docs/r.md': [
        '# R',
        '',
        '## ADR-0001: One',
        '',
        '**Status:** accepted',
        '',
        '### Open Questions',
        '',
        '- [ ] first',
        '',
        '## ADR-0002: Two',
        '',
        '**Status:** accepted',
        '',
        '### Open Questions',
        '',
        '- [ ] second',
      ].join('\n'),
    };
    expect(analyse(two).corpus.items.map((i) => i.id)).toEqual([
      'ADR-0001#open-questions.1',
      'ADR-0002#open-questions.1',
    ]);
  });
});

describe('what is not a specification', () => {
  it('a heading with an identifier but no status', () => {
    // `## Q3 2026 Roadmap` parses as family Q, number 3. One signal is not enough.
    const files = {
      'docs/plan.md': ['# Plan', '', '## Q3 2026 Roadmap', '', 'Ship the thing.', '', '## Q4 2026 Roadmap', '', 'Ship more.'].join('\n'),
    };
    expect(ids(files)).toEqual(['plan']);
  });

  it('a changelog', () => {
    const files = {
      'CHANGELOG.md': ['# Changelog', '', '## v1.2.0', '', 'Added things.', '', '## v1.1.0', '', 'Fixed things.'].join('\n'),
    };
    expect(ids(files)).toEqual(['CHANGELOG']);
  });

  it('the file title heading of an ordinary one-decision document', () => {
    // The H1 names the file; reading it as a region inside itself would give
    // every ADR in every repository a duplicate.
    const files = {
      'docs/adr/0007-sharding.md': ['---', 'status: accepted', '---', '', '# ADR-0007: Sharding', '', 'Shard by tenant.'].join('\n'),
    };
    expect(ids(files)).toEqual(['ADR-0007']);
  });

  it('a status section of an ordinary document', () => {
    const files = {
      'docs/adr/0007-x.md': ['# ADR-0007: X', '', '## Status', '', 'Accepted', '', '## Context', '', 'Words.'].join('\n'),
    };
    expect(ids(files)).toEqual(['ADR-0007']);
  });
});

describe('an explicit directive is always enough', () => {
  it('makes a section a specification with no status line', () => {
    const files = {
      'docs/notes.md': [
        '# Notes',
        '',
        '## ADR-0009: Something',
        '',
        '<!-- @spec-node status="accepted" -->',
        '',
        'Words.',
      ].join('\n'),
    };
    expect(ids(files)).toEqual(['ADR-0009', 'notes']);
    expect(analyse(files).graph.document('ADR-0009')?.phase).toBe('active');
  });

  it('lets the directive rename the section', () => {
    const files = {
      'docs/notes.md': [
        '# Notes',
        '',
        '## ADR-0009: Something',
        '',
        '<!-- @spec-node id="DEC-0009" status="accepted" -->',
      ].join('\n'),
    };
    expect(ids(files)).toEqual(['DEC-0009', 'notes']);
  });
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

const TABLE = [
  '# Decision Table',
  '',
  '| ID | Title | Status | Depends on | Superseded by |',
  '| :- | :---- | :----- | :--------- | :------------ |',
  '| ADR-0001 | Use one writer | Superseded | - | ADR-0003 |',
  '| ADR-0002 | Cache eviction | Accepted | ADR-0001 | - |',
  '| ADR-0003 | Many writers | Accepted | - | - |',
].join('\n');

describe('a register written as a table', () => {
  const files = { 'docs/table.md': TABLE };

  it('yields one specification per row', () => {
    expect(ids(files)).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003', 'table']);
  });

  it('reads status and title from their columns', () => {
    const { graph } = analyse(files);
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
    expect(graph.document('ADR-0002')?.phase).toBe('active');
    expect(graph.document('ADR-0002')?.title).toBe('Cache eviction');
  });

  it('types relations by the column header the author wrote', () => {
    const { graph } = analyse(files);
    expect(graph.out('ADR-0002', ['depends-on']).map((e) => e.to)).toEqual(['ADR-0001']);
    // "Superseded by" runs the other way: ADR-0003 supersedes ADR-0001.
    expect(graph.in('ADR-0001', ['supersedes']).map((e) => e.from)).toEqual(['ADR-0003']);
  });

  it('points a finding at the cell that declares it', () => {
    const stale = analyse(files).diagnostics.find((d) => d.rule === 'stale-premise');
    expect(stale?.at.span.start.line).toBe(6);
    // Column four, where `ADR-0001` is written - not the row, not the file.
    expect(stale?.at.span.start.column).toBeGreaterThan(40);
  });

  it('reads several targets from one cell', () => {
    const many = {
      'docs/t.md': [
        '| ID | Status | Depends on |',
        '| :- | :----- | :--------- |',
        '| ADR-0009 | Accepted | ADR-0001, ADR-0002 and ADR-0003 |',
        '| ADR-0001 | Accepted | - |',
        '| ADR-0002 | Accepted | - |',
        '| ADR-0003 | Accepted | - |',
      ].join('\n'),
    };
    expect(analyse(many).graph.out('ADR-0009', ['depends-on']).map((e) => e.to).sort()).toEqual([
      'ADR-0001',
      'ADR-0002',
      'ADR-0003',
    ]);
  });

  it('treats an empty marker as no relation at all', () => {
    const { corpus } = analyse(files);
    expect(corpus.dangling).toEqual([]);
    for (const marker of ['-', '—', 'n/a', 'none', 'TBD']) {
      const one = {
        'docs/t.md': ['| ID | Status | Depends on |', '| :- | :----- | :--------- |', `| ADR-0001 | Accepted | ${marker} |`].join('\n'),
      };
      expect(analyse(one).corpus.dangling, marker).toEqual([]);
    }
  });

  it('does not also read the cell as a prose citation', () => {
    // One typed edge, not a typed edge and a neutral citation beside it.
    const { graph } = analyse(files);
    expect(graph.edges.filter((e) => e.kind === 'references')).toEqual([]);
  });

  it('resolves a linked identifier in a cell', () => {
    const linked = {
      'docs/adr/0001-a.md': '---\nstatus: accepted\n---\n\n# A\n',
      'docs/t.md': [
        '| ID | Status | Depends on |',
        '| :- | :----- | :--------- |',
        '| ADR-0009 | Accepted | [ADR-0001](adr/0001-a.md) |',
      ].join('\n'),
    };
    expect(analyse(linked).graph.out('ADR-0009', ['depends-on']).map((e) => e.to)).toEqual(['ADR-0001']);
  });
});

describe('what is not a specification table', () => {
  it('a table with identifiers but no status or relation column', () => {
    // A citation list. Promoting its rows would invent a register nobody wrote.
    const files = {
      'docs/refs.md': ['# References', '', '| Ref | Note |', '| :-- | :--- |', '| ADR-0001 | background |'].join('\n'),
    };
    expect(ids(files)).toEqual(['refs']);
  });

  it('a table with no identifier column', () => {
    const files = {
      'docs/x.md': ['# X', '', '| Thing | Status |', '| :---- | :----- |', '| a | Accepted |'].join('\n'),
    };
    expect(ids(files)).toEqual(['x']);
  });

  it('a row whose identifier cell is empty', () => {
    const files = {
      'docs/x.md': ['| ID | Status |', '| :- | :----- |', '| - | Accepted |', '| ADR-0001 | Accepted |'].join('\n'),
    };
    expect(ids(files)).toEqual(['ADR-0001', 'x']);
  });
});

/* -------------------------------------------------------------------------- */
/* The table scanner                                                          */
/* -------------------------------------------------------------------------- */

describe('table scanning', () => {
  it('needs a delimiter row to be a table at all', () => {
    expect(scanMarkdown('| a | b |\n| c | d |\n').tables).toEqual([]);
    expect(scanMarkdown('| a | b |\n| :- | -: |\n| c | d |\n').tables).toHaveLength(1);
  });

  it('does not split on a pipe inside inline code', () => {
    const doc = scanMarkdown(['| a | b |', '| :- | :- |', '| `x|y` | z |'].join('\n'));
    expect(doc.tables[0]?.rows[0]?.cells.map((c) => c.text)).toEqual(['`x|y`', 'z']);
  });

  it('does not split on an escaped pipe', () => {
    const doc = scanMarkdown(['| a | b |', '| :- | :- |', '| x\\|y | z |'].join('\n'));
    expect(doc.tables[0]?.rows[0]?.cells.map((c) => c.text)).toEqual(['x\\|y', 'z']);
  });

  it('ignores a table inside a fenced block', () => {
    const doc = scanMarkdown(['```md', '| a | b |', '| :- | :- |', '| c | d |', '```'].join('\n'));
    expect(doc.tables).toEqual([]);
  });

  it('ends a table at the first line that is not a row', () => {
    const doc = scanMarkdown(['| a | b |', '| :- | :- |', '| c | d |', '', 'prose'].join('\n'));
    expect(doc.tables[0]?.rows).toHaveLength(1);
  });

  it('records an offset for every cell', () => {
    const md = ['| a | b |', '| :- | :- |', '| ADR-0001 | done |'].join('\n');
    const cell = scanMarkdown(md).tables[0]?.rows[0]?.cells[0];
    expect(md.slice(cell?.start ?? 0, cell?.end ?? 0)).toBe('ADR-0001');
  });

  it('handles rows without border pipes', () => {
    const doc = scanMarkdown(['a | b', ':- | :-', 'c | d'].join('\n'));
    expect(doc.tables[0]?.rows[0]?.cells.map((c) => c.text)).toEqual(['c', 'd']);
  });
});

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

describe('a register contains the specifications written inside it', () => {
  const files = { 'docs/register.md': REGISTER };

  it('relates the file to each specification it holds', () => {
    const { graph } = analyse(files);
    const held = graph
      .out('register', ['contains'])
      .map((edge) => edge.to)
      .filter((id) => graph.document(id) !== undefined)
      .sort();
    expect(held).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003']);
  });

  it('is absent from an ordinary one-specification-per-file corpus', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '# ADR-0001: A\n\n## Status\n\naccepted\n',
      'docs/adr/0002-b.md': '# ADR-0002: B\n\n## Status\n\naccepted\n',
    });
    const between = graph.edges.filter(
      (edge) => edge.kind === 'contains' && graph.document(edge.to) !== undefined,
    );
    expect(between).toEqual([]);
  });

  it('carries no obligation, so a retired register does not indict what it holds', () => {
    const { graph, diagnostics } = analyse({
      'docs/old.md': [
        '---',
        'status: retired',
        '---',
        '',
        '# Superseded Register',
        '',
        '## ADR-0100: Still in force',
        '',
        '**Status:** accepted',
      ].join('\n'),
      'docs/live.md': '# ADR-0200: Live\n\n## Status\n\naccepted\n\nThis depends on ADR-0100.\n',
    });

    expect(graph.document('old')?.phase).toBe('retired');
    expect(graph.document('ADR-0100')?.phase).toBe('active');
    expect(diagnostics.map((d) => d.rule)).not.toContain('stale-premise');
  });

  it('survives --documents-only, where containment of an item does not', () => {
    // Hiding items makes "this document holds this obligation" redundant. It
    // does not make "this register holds this decision" redundant - that is
    // structure between documents, and the whole point of the view.
    const { graph } = analyse(files);
    const exported = JSON.parse(formatGraph(graph, 'json', { documentsOnly: true })) as {
      edges: { kind: string; from: string; to: string }[];
    };
    const contains = exported.edges.filter((edge) => edge.kind === 'contains');

    expect(contains.map((edge) => edge.to).sort()).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003']);
    expect(formatGraph(graph, 'json', {})).toContain('#open-questions.1');
    expect(JSON.stringify(contains)).not.toContain('#open-questions');
  });
});

describe('a link in a typed relation column', () => {
  const table = (cell: string): string =>
    ['# Register', '', '| ID       | Status   | Depends on |', '| :------- | :------- | :--------- |',
     '| ADR-0001 | accepted | -          |', `| ADR-0002 | accepted | ${cell} |`].join('\n');

  const target = (cell: string): string[] => {
    const { graph } = analyse({
      'docs/register.md': table(cell),
      'docs/adr/0001-first.md': '# ADR-0001: First\n\n## Status\n\naccepted\n',
    });
    return graph.out('ADR-0002', ['depends-on']).map((edge) => edge.to);
  };

  it('follows the destination, not the label', () => {
    // A link states where its target lives; the label states only what it is
    // called. "see" is not the dependency - the file it points at is.
    expect(target('[see](adr/0001-first.md)')).toEqual(['ADR-0001']);
  });

  it('does not cut a path on its own slash, or strip its underscores', () => {
    expect(target('[ADR-0001](adr/0001-first.md)')).toEqual(['ADR-0001']);

    // A slash would split the target in two; an underscore reads as emphasis.
    // Both survive only because links are lifted out before either happens.
    const { graph } = analyse({
      'docs/register.md': table('[x](notes/deep_path/a_b.md)'),
      'docs/notes/deep_path/a_b.md': ['# ADR-0009: Deep', '', '## Status', '', 'accepted'].join('\n'),
    });
    expect(graph.out('ADR-0002', ['depends-on']).map((edge) => edge.to)).toEqual(['ADR-0009']);
  });

  it('reads a wiki link by name, since it carries no path', () => {
    expect(target('[[ADR-0001]]')).toEqual(['ADR-0001']);
  });

  it('falls back to the label when the destination names nobody here', () => {
    expect(target('[ADR-0001](https://example.test/adr-1)')).toEqual(['ADR-0001']);
    expect(target('[ADR-0001](#section)')).toEqual(['ADR-0001']);
  });

  it('keeps every target in a cell that lists several', () => {
    const { graph } = analyse({
      'docs/register.md': table('[see](adr/0001-first.md) and ADR-0003'),
      'docs/adr/0001-first.md': '# ADR-0001: First\n\n## Status\n\naccepted\n',
      'docs/adr/0003-third.md': '# ADR-0003: Third\n\n## Status\n\naccepted\n',
    });
    expect(graph.out('ADR-0002', ['depends-on']).map((edge) => edge.to)).toEqual(['ADR-0001', 'ADR-0003']);
  });
});

/* -------------------------------------------------------------------------- */
/* Column vocabulary                                                          */
/* -------------------------------------------------------------------------- */

describe('the relation column vocabulary', () => {
  // A column header is a typed declaration, and getting its direction wrong is
  // a silent, load-bearing bug: `Superseded by` pointing the wrong way makes a
  // retired decision look like the survivor. Each phrase is asserted for both
  // the kind it means and the way it points.
  const edge = (header: string): { kind: string; from: string; to: string } | undefined => {
    const { graph } = analyse({
      'docs/register.md': [
        '# Register',
        '',
        `| ID | Status | ${header} |`,
        '| :- | :----- | :----- |',
        '| ADR-0001 | accepted | - |',
        '| ADR-0002 | accepted | ADR-0001 |',
      ].join('\n'),
    });
    const [found] = graph.edges
      .filter((candidate) => candidate.kind !== 'contains')
      .map((candidate) => ({ kind: candidate.kind, from: candidate.from, to: candidate.to }));
    return found;
  };

  const FORWARD: readonly (readonly [string, string])[] = [
    ['Depends on', 'depends-on'],
    ['Depends-on', 'depends-on'],
    ['Dependencies', 'depends-on'],
    ['Requires', 'depends-on'],
    ['Supersedes', 'supersedes'],
    ['Replaces', 'supersedes'],
    ['Blocked by', 'blocked-by'],
    ['Blocked on', 'blocked-by'],
    ['Amends', 'amends'],
    ['Extends', 'amends'],
    ['Assumes', 'assumes'],
    ['Delegates to', 'delegates-to'],
    ['Delegated to', 'delegates-to'],
    ['Tracked in', 'delegates-to'],
    ['Related', 'relates-to'],
    ['Related to', 'relates-to'],
    ['See also', 'relates-to'],
    ['References', 'references'],
  ];

  const INVERTED: readonly (readonly [string, string])[] = [
    ['Superseded by', 'supersedes'],
    ['Replaced by', 'supersedes'],
    ['Blocks', 'blocked-by'],
  ];

  it.each(FORWARD)('reads "%s" as %s from the row that declares it', (header, kind) => {
    expect(edge(header)).toEqual({ kind, from: 'ADR-0002', to: 'ADR-0001' });
  });

  it.each(INVERTED)('reads "%s" as %s pointing back at the row', (header, kind) => {
    expect(edge(header)).toEqual({ kind, from: 'ADR-0001', to: 'ADR-0002' });
  });

  it('reads a header however it was capitalised or spaced', () => {
    expect(edge('DEPENDS  ON')).toEqual({ kind: 'depends-on', from: 'ADR-0002', to: 'ADR-0001' });
  });

  it('leaves a header it does not know as prose', () => {
    // Not a relation column, so the identifier in the cell is scanned as an
    // ordinary citation rather than typed - and stays a citation.
    expect(edge('Owner')?.kind).toBe('references');
  });
});

describe('a column header is matched whole', () => {
  const table = (headers: string, row: string): Record<string, string> => ({
    'docs/register.md': ['# Register', '', `| ${headers} |`, `| ${headers.replace(/[^|]+/g, ' :- ')} |`, `| ${row} |`].join('\n'),
  });

  it('does not read "Grid" as an identifier column', () => {
    // Anchored at both ends: without the leading anchor, any header *ending*
    // in "id" becomes the column every row is identified by.
    expect(ids(table('Grid | Status | Depends on', 'ADR-0010 | accepted | -'))).toEqual(['register']);
  });

  it('does not read "Status notes" as a status column', () => {
    // A notes column would give every row a lifecycle it never declared.
    expect(ids(table('ID | Status notes', 'ADR-0020 | fine'))).toEqual(['register']);
  });

  it('does not read "Name of thing" as a title column', () => {
    const { graph } = analyse(table('ID | Status | Name of thing', 'ADR-0030 | accepted | Whatever'));
    expect(graph.document('ADR-0030')?.title).toBe('ADR-0030');
  });
});

describe('a section does not borrow another section\'s status', () => {
  it('stops at the next heading of the same level', () => {
    // The region ends at the next heading of the same level *or above*. Ending
    // it only at a shallower heading would let a section without a status of
    // its own take the next section's, and become a specification it never
    // declared itself to be.
    expect(
      ids({
        'docs/register.md': [
          '# Register',
          '',
          '## ADR-0001: No status of its own',
          '',
          'Some prose.',
          '',
          '## ADR-0002: Has one',
          '',
          '**Status:** accepted',
        ].join('\n'),
      }),
    ).toEqual(['ADR-0002', 'register']);
  });

  it('gives a nested section its own prose', () => {
    const { graph } = analyse({
      'docs/register.md': [
        '# Register',
        '',
        '## ADR-0001: Outer',
        '',
        '**Status:** accepted',
        '',
        '### ADR-0002: Inner',
        '',
        '**Status:** accepted',
        '',
        'This depends on ADR-0003.',
      ].join('\n'),
      'docs/adr/0003-third.md': '# ADR-0003: Third\n\n## Status\n\naccepted\n',
    });
    expect(graph.out('ADR-0002', ['depends-on']).map((relation) => relation.to)).toEqual(['ADR-0003']);
    expect(graph.out('ADR-0001', ['depends-on'])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

describe('a register does not answer to its file path', () => {
  // ADR-0009 says a region does not claim the file's path, because two nodes
  // answering to one path would make every link to that file ambiguous. That
  // was true of the alias table and false of the path index, where a collision
  // is resolved by keeping whichever was written last - so a link to a file
  // holding a register bound to its final row, silently, and anchors were then
  // checked against that row's span rather than the file's.
  const TABLE_FORM = [
    '---',
    'status: active',
    '---',
    '# A doc',
    '',
    '## How to read this document',
    '',
    'text',
    '',
    '| ID | Requirement | Status |',
    '| :--- | :--- | :--- |',
    '| FR-1 | thing | Implemented |',
    '| FR-2 | other | Specified |',
  ].join('\n');

  const HEADING_FORM = [
    '---',
    'status: active',
    '---',
    '# A doc',
    '',
    '## How to read this document',
    '',
    'text',
    '',
    '## FR-1 First',
    '',
    '**Status:** Implemented',
    '',
    '## FR-2 Second',
    '',
    '**Status:** Specified',
  ].join('\n');

  const cite = (link: string): string => ['# B', '', `This rests on ${link}.`].join('\n');

  const targets = (register: string, link: string): string[] => {
    const { graph } = analyse({ 'docs/A.md': register, 'B.md': cite(link) });
    return graph.out('B').map((edge) => edge.to);
  };

  for (const [form, register] of [
    ['a table', TABLE_FORM],
    ['headings', HEADING_FORM],
  ] as const) {
    it(`resolves a path link into ${form} register to the file, not to its last row`, () => {
      expect(targets(register, '[A](docs/A.md)')).toEqual(['A']);
    });

    it(`resolves an anchor into ${form} register against the whole file`, () => {
      // The false positive this produced was the visible half of the bug. The
      // link bound to a row, and a row's anchor set holds only what is inside
      // its own span - nothing, for a table row.
      const files = { 'docs/A.md': register, 'B.md': cite('[x](docs/A.md#how-to-read-this-document)') };
      expect(rules(files)).toEqual([]);
      expect(targets(register, '[x](docs/A.md#how-to-read-this-document)')).toEqual(['A']);
    });
  }

  it('still reports an anchor that genuinely is not there', () => {
    const files = { 'docs/A.md': TABLE_FORM, 'B.md': cite('[y](docs/A.md#no-such-heading)') };
    expect(rules(files)).toEqual(['broken-reference']);
  });

  it('keeps the path on the region nodes, so a selector still finds them', () => {
    // The path is dropped from the *index*, not from the node: a finding has to
    // be able to say which file a region lives in.
    const { graph } = analyse({ 'docs/A.md': TABLE_FORM });
    const here = graph.documents.filter((node) => node.path === 'docs/A.md').map((node) => node.id);
    expect(here.sort()).toEqual(['A', 'FR-1', 'FR-2']);
  });

  it('leaves README parent addressing alone', () => {
    // `docs/adr/0007/README.md` is also addressed as `docs/adr/0007`, and that
    // key is produced by the same loop the guard now wraps.
    const files = {
      'docs/adr/0007/README.md': ['# ADR-0007: Sharding', '', '## Status', '', 'accepted'].join('\n'),
      'B.md': cite('[z](docs/adr/0007)'),
    };
    expect(rules(files)).toEqual([]);
    expect(analyse(files).graph.out('B').map((edge) => edge.to)).toEqual(['ADR-0007']);
  });
});
