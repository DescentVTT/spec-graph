import { describe, expect, it } from 'vitest';

import { scanMarkdown } from '../src/markdown.js';
import { formatGraph } from '../src/report.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { RuleId } from '../src/types.js';

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

const rules = (files: Record<string, string>): RuleId[] => analyse(files).diagnostics.map((d) => d.rule);
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
