import { describe, expect, it } from 'vitest';

import { scanMarkdown } from '../src/markdown.js';
import { analyseSources, type Source } from '../src/runner.js';
import { findSpecificationRegions, readRegionStatus, regionAt } from '../src/sections.js';
import type { DocumentNode } from '../src/types.js';

/**
 * Where one specification ends and the next begins, when a file holds several.
 *
 * ADR-0009: a heading region needs an identifier it opens with *and* a status
 * of its own; a table row needs an identifier column *and* a status or a
 * relation column. These tests hold the edges of both - the forms a status is
 * written in, what a row's id cell may and may not name, which column is which
 * - and each asserts what a reader of the graph sees: the documents, their
 * status, their relations.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

const register = (...lines: string[]): Record<string, string> => ({
  'docs/register.md': ['# Register', '', ...lines].join('\n'),
});

const documents = (files: Record<string, string>): string[] =>
  analyse(files)
    .corpus.documents.map((d) => d.id)
    .sort();

const document = (files: Record<string, string>, id: string): DocumentNode | undefined => analyse(files).graph.document(id);

/** A table with a delimiter row under its header. */
const table = (header: string, ...rows: string[]): string[] => [
  `| ${header} |`,
  `| ${header.split('|').map(() => '--').join(' | ')} |`,
  ...rows.map((row) => `| ${row} |`),
];

/* -------------------------------------------------------------------------- */
/* Headings                                                                   */
/* -------------------------------------------------------------------------- */

describe('a heading region', () => {
  it('opens with its identifier, however the identifier is spaced', () => {
    expect(
      documents(
        register('## ADR 0007: Sharding', '', '**Status:** Accepted', '', '## KEP1234 Storage', '', '**Status:** Implemented'),
      ),
    ).toEqual(['ADR-0007', 'KEP-1234', 'register']);
  });

  it('is not a heading that only mentions an identifier', () => {
    expect(documents(register('## Notes on ADR-0007', '', '**Status:** Accepted'))).toEqual(['register']);
  });

  const STATUS_LINES: readonly (readonly [string, string])[] = [
    ['**Status:** Superseded by ADR-0012', 'Superseded by ADR-0012'],
    ['Status: Superseded by ADR-0012', 'Superseded by ADR-0012'],
    ['**Status**: Accepted', 'Accepted'],
    ['*Status* : Accepted', 'Accepted'],
    ['**Status: Accepted**', 'Accepted'],
    ['Status:Accepted', 'Accepted'],
    ['> **Status:** Accepted', 'Accepted'],
  ];

  it.each(STATUS_LINES)('reads the status in "%s" as "%s"', (line, status) => {
    expect(document(register('## ADR-0007: Sharding', '', line), 'ADR-0007')?.rawStatus).toBe(status);
  });

  it('does not read a status out of prose that only mentions one', () => {
    expect(
      documents(
        register(
          '## ADR-0007: Rollout',
          '',
          'Rollout status: green in every region.',
          '',
          'Statuses: proposed, accepted, rejected.',
        ),
      ),
    ).toEqual(['register']);
  });

  it('reads nothing from a Status field left empty', () => {
    // A template's placeholder is not a status, so the section is not yet a
    // specification.
    expect(documents(register('## ADR-0007: Template', '', '**Status:**', '', 'To be written.'))).toEqual(['register']);
  });

  it('points at a labelled status where it is written', () => {
    const at = document(register('## ADR-0007: Sharding', '', '**Status:** Superseded by ADR-0012'), 'ADR-0007')?.statusAt;
    expect([at?.span.start.line, at?.span.start.column, at?.span.end.column]).toEqual([5, 13, 35]);
  });

  it('points at a status under a Status heading where it is written', () => {
    const at = document(register('## ADR-0007: Sharding', '', '### Status', '', '-   Accepted', '-   Proposed'), 'ADR-0007')
      ?.statusAt;
    expect([at?.span.start.line, at?.span.start.column, at?.span.end.column]).toEqual([7, 5, 13]);
    const indented = document(register('## ADR-0007: Sharding', '', '### Status', '', '  Accepted'), 'ADR-0007')?.statusAt;
    expect([indented?.span.start.line, indented?.span.start.column, indented?.span.end.column]).toEqual([7, 3, 11]);
  });

  const HEADED: readonly (readonly [string, string[], string])[] = [
    ['the first entry of a status history', ['- Accepted', '- Proposed'], 'Accepted'],
    ['an entry with room after its bullet', ['-   Accepted'], 'Accepted'],
    ['a status with a dash inside it', ['Accepted - pending review'], 'Accepted - pending review'],
    ['a status ending in a hard line break', ['Accepted  '], 'Accepted'],
  ];

  it.each(HEADED)('reads %s under a Status heading', (_, lines, status) => {
    expect(document(register('## ADR-0007: Sharding', '', '### Status', '', ...lines), 'ADR-0007')?.rawStatus).toBe(status);
  });

  it('finds no status under a Status heading that holds none', () => {
    expect(documents(register('## ADR-0007: Sharding', '', '### Status', '#### Notes', '', 'Later.'))).toEqual(['register']);
    // An example in a code block is an example.
    expect(documents(register('## ADR-0007: Sharding', '', '### Status', '', '```text', 'Accepted', '```'))).toEqual([
      'register',
    ]);
    // Nor does it take the title of the next decision, underlined, as its own.
    expect(
      documents(register('## ADR-0001: A', '', '### Status', '', 'ADR-0002: B', '-----------', '', '**Status:** Accepted')),
    ).not.toContain('ADR-0001');
  });

  it('reads a Status heading only inside its own section', () => {
    expect(
      documents(register('## ADR-0001: A', '', '### Status', '', 'Accepted', '', '## ADR-0002: B', '', 'Nothing declared here.')),
    ).toEqual(['ADR-0001', 'register']);
  });
});

describe('a @spec-node directive in a heading region', () => {
  it('is the only directive that makes a section a specification', () => {
    expect(
      documents(register('## ADR-0007: Sharding', '', '<!-- @spec-edge kind="relates-to" to="ADR-0001" -->', '')),
    ).toEqual(['register']);
  });

  it('counts only inside its own section, in either direction', () => {
    expect(
      documents(register('## ADR-0001: A', '', '<!-- @spec-node status="accepted" -->', '', '## ADR-0002: B', '', 'Nothing.')),
    ).toEqual(['ADR-0001', 'register']);
    expect(
      documents(register('## ADR-0001: A', '', 'Nothing.', '', '## ADR-0002: B', '', '<!-- @spec-node status="accepted" -->')),
    ).toEqual(['ADR-0002', 'register']);
  });

  it('is the last one written, when a section has two', () => {
    // The one written last is the one a reader sees as the final word.
    const files = register(
      '## ADR-0007: Sharding',
      '',
      '<!-- @spec-node status="proposed" -->',
      '<!-- @spec-node status="accepted" -->',
    );
    expect(document(files, 'ADR-0007')?.rawStatus).toBe('accepted');
  });

  it('leaves the heading its id when its own id is not a name', () => {
    // `id=\"ADR-9\"` written inside a string parses to a lone backslash. The
    // section used to fall back to the file's name: the register contained
    // itself, and ADR-0007 vanished.
    const { corpus, graph } = analyse(
      register('## ADR-0007: Sharding', '', '<!-- @spec-node id=\\"ADR-9\\" status="accepted" -->', '', 'Text.'),
    );
    expect(corpus.documents.map((d) => d.id).sort()).toEqual(['ADR-0007', 'register']);
    expect(graph.edges.filter((e) => e.kind === 'contains').map((e) => `${e.from}>${e.to}`)).toEqual(['register>ADR-0007']);
  });
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

describe('a register kept as a table', () => {
  it('is read with no status column when it declares relations', () => {
    const { graph } = analyse(register(...table('ID | Title | Depends on', 'ADR-0001 | One | -', 'ADR-0002 | Two | ADR-0001')));
    expect(graph.documents.map((d) => d.id).sort()).toEqual(['ADR-0001', 'ADR-0002', 'register']);
    expect(graph.out('ADR-0002', ['depends-on']).map((e) => e.to)).toEqual(['ADR-0001']);
    expect(graph.document('ADR-0002')?.rawStatus).toBeNull();
  });

  it('reads an empty or placeholder status cell as no status, and an empty title cell as no title', () => {
    const { graph } = analyse(
      register(...table('ID | Title | Status', 'ADR-0001 |  |  ', 'ADR-0002 | Two | -', 'ADR-0003 | Three | n/a')),
    );
    for (const id of ['ADR-0001', 'ADR-0002', 'ADR-0003']) {
      expect([graph.document(id)?.rawStatus, graph.document(id)?.statusAt]).toEqual([null, null]);
    }
    expect(graph.document('ADR-0001')?.title).toBe('ADR-0001');
  });

  it('reads a status that ends in a full stop', () => {
    expect(document(register(...table('ID | Status', 'ADR-0001 | Accepted.')), 'ADR-0001')?.phase).toBe('active');
  });

  it('names a row by the text of its id cell, however that is formatted', () => {
    expect(
      documents(
        register(
          ...table(
            'ID | Title | Status',
            '**ADR-0001** | Bold | Accepted',
            '`ADR-0002` | Code | Accepted',
            '[ADR-0003](#adr-0003) | Linked | Accepted',
            '[[ADR-0004]] | Wiki | Accepted',
            '[[0005-notes\\|ADR-0005]] | Wiki with a label | Accepted',
            'NAV-1 | Opens like "n/a" and is not it | Accepted',
          ),
        ),
      ),
    ).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003', 'ADR-0004', 'ADR-0005', 'NAV-1', 'register']);
  });

  it('skips a row whose id cell names nothing', () => {
    // `?` for a row nobody has numbered yet used to fall back to the file's
    // own name: the register contained itself, and the row vanished.
    const { corpus, graph } = analyse(
      register(...table('ID | Title | Status', ' | Blank | Proposed', '- | Dash | Proposed', '? | Not numbered | Proposed', 'TBD | To be decided | Proposed', 'OI-2 | Numbered | Open')),
    );
    expect(corpus.documents.map((d) => d.id).sort()).toEqual(['OI-2', 'register']);
    expect(graph.edges.filter((e) => e.kind === 'contains').map((e) => `${e.from}>${e.to}`)).toEqual(['register>OI-2']);
  });

  it('skips a row cut off before its id cell', () => {
    expect(documents(register(...table('Title | ID | Status', 'Unfinished', 'Kept | ADR-0001 | Accepted')))).toEqual([
      'ADR-0001',
      'register',
    ]);
  });

  it('does not read an id cell as a citation of the row it names', () => {
    // A register whose ids link down to their details. The link is the row's
    // name, not a reference the row makes.
    const { diagnostics } = analyse(
      register(...table('ID | Title | Status', '[OI-1](#oi-1-details) | One | Open'), '', '## OI-1 details', '', 'The long version.'),
    );
    expect(diagnostics).toEqual([]);
  });

  it('owns what is written in its row, and leaves prose after the table to the file', () => {
    const { graph } = analyse({
      ...register(
        ...table('ID | Status | Notes', 'ADR-0001 | Accepted | Follows ADR-0002.', 'ADR-0002 | Accepted | -'),
        '',
        'Last reviewed against ADR-0003.',
      ),
      'docs/adr/0003-review.md': '---\nstatus: accepted\n---\n\n# Review\n',
    });
    const cited = graph.edges.filter((e) => e.kind === 'references').map((e) => `${e.from}>${e.to}`);
    expect(cited.sort()).toEqual(['ADR-0001>ADR-0002', 'register>ADR-0003']);
  });
});

describe('the columns of a register', () => {
  it('reads the first id, status and title columns, and any later one as data', () => {
    // `Decision` could name either column; after an `ID` it is the title.
    expect(document(register(...table('ID | Decision | Status', 'ADR-0001 | Use one writer | Accepted')), 'ADR-0001')?.title).toBe(
      'Use one writer',
    );
    const phased = document(register(...table('ID | Status | Phase', 'ADR-0001 | Accepted | 2')), 'ADR-0001');
    expect([phased?.rawStatus, phased?.phase]).toEqual(['Accepted', 'active']);
    expect(
      document(
        register(...table('ID | Status | Title | Summary', 'ADR-0001 | Accepted | Use one writer | Writes go through one process')),
        'ADR-0001',
      )?.title,
    ).toBe('Use one writer');
  });

  it('matches a header whole, not by how it begins or ends', () => {
    // "Notes" begins like "No", "Next phase" ends like "phase", "Owner name"
    // ends like "name". None of them is the column it resembles.
    expect(documents(register(...table('Notes | Status | Depends on', 'fine | accepted | -')))).toEqual(['register']);
    expect(documents(register(...table('ID | Next phase', 'OI-1 | Beta')))).toEqual(['register']);
    expect(
      document(register(...table('ID | Status | Owner name | Title', 'ADR-0001 | Accepted | Sam | Use one writer')), 'ADR-0001')?.title,
    ).toBe('Use one writer');
  });

  it('reads a "No." column as the identifier', () => {
    expect(documents(register(...table('No. | Title | Status', 'ADR-0001 | One | Accepted')))).toEqual(['ADR-0001', 'register']);
  });
});

describe('a relation cell', () => {
  const dependencies = (cell: string) => {
    const result = analyse({
      ...register(...table('ID | Status | Depends on', 'ADR-0001 | Accepted | -', 'ADR-0003 | Accepted | -', `ADR-0002 | Accepted | ${cell}`)),
      'docs/adr/0009-first.md': '---\nstatus: accepted\n---\n\n# ADR-0009: First\n',
    });
    return {
      to: result.graph.out('ADR-0002', ['depends-on']).map((e) => e.to).sort(),
      findings: result.diagnostics.map((d) => d.rule),
    };
  };

  it('declares nothing when it is empty or says NA', () => {
    expect(dependencies('')).toEqual({ to: [], findings: [] });
    expect(dependencies('NA')).toEqual({ to: [], findings: [] });
  });

  it('splits a list written without spaces', () => {
    expect(dependencies('ADR-0001,ADR-0003').to).toEqual(['ADR-0001', 'ADR-0003']);
  });

  it('reads a link by its destination and nothing else', () => {
    // "see" is not a second dependency, and not a broken one either.
    expect(dependencies('[see](adr/0009-first.md)')).toEqual({ to: ['ADR-0009'], findings: [] });
  });

  it('falls back to the label of a link with no destination', () => {
    expect(dependencies('[ADR-0001]()').to).toEqual(['ADR-0001']);
  });

  it('reads a link destination written with space inside its parentheses', () => {
    // CommonMark allows it, and the space is not part of the destination: this
    // one is external, so the label is what names the dependency.
    expect(dependencies('[ADR-0001]( https://example.test/adr-1 )').to).toEqual(['ADR-0001']);
  });
});

/* -------------------------------------------------------------------------- */
/* The exported helpers                                                       */
/* -------------------------------------------------------------------------- */

// Both are part of the programmatic API, for a tool that works out regions of
// its own. A region runs from `start` up to, and not including, `end`.

describe('readRegionStatus', () => {
  it('reads a status that begins where the region begins', () => {
    const labelled = scanMarkdown('Status: Accepted\n');
    expect(readRegionStatus(labelled, 0, labelled.text.length)).toEqual({ text: 'Accepted', start: 8, end: 16 });
    const headed = scanMarkdown('### Status\n\nProposed\n');
    expect(readRegionStatus(headed, 0, headed.text.length)?.text).toBe('Proposed');
  });

  it('reads no status that begins where the region ends', () => {
    const scanned = scanMarkdown('Intro.\nStatus: Accepted\n');
    expect(readRegionStatus(scanned, 0, 'Intro.\n'.length)).toBeNull();
  });
});

describe('regionAt', () => {
  const regions = () =>
    findSpecificationRegions(
      scanMarkdown(
        [
          '# Register',
          '',
          '## ADR-0001: Outer',
          '',
          '**Status:** Accepted',
          '',
          '### ADR-0002: Inner',
          '',
          '**Status:** Proposed',
          '',
          'Inside the inner one.',
          '',
          '| ID | Status |',
          '| -- | -- |',
          '| ADR-0003 | Accepted |',
          '',
          'After the table.',
        ].join('\n'),
      ),
      [],
      'register',
    );

  it('finds the innermost region, whatever order the regions are given in', () => {
    const all = regions();
    const inner = all.find((r) => r.declaredId === 'ADR-0002')!;
    expect(regionAt(all, inner.start + 1)?.declaredId).toBe('ADR-0002');
    expect(regionAt([...all].reverse(), inner.start + 1)?.declaredId).toBe('ADR-0002');
  });

  it('holds its start and not its end', () => {
    const all = regions();
    const row = all.find((r) => r.declaredId === 'ADR-0003')!;
    expect(regionAt(all, row.start)?.declaredId).toBe('ADR-0003');
    expect(regionAt(all, row.end)?.declaredId).not.toBe('ADR-0003');
  });
});
