import { describe, expect, it } from 'vitest';

import {
  diffExports,
  DiffInputError,
  diffVerdict,
  formatDiffJson,
  formatDiffMarkdown,
  formatDiffText,
  generatorWarning,
  parseGraphExport,
  type GraphExport,
} from '../src/diff.js';
import { formatGraph } from '../src/report.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * `spec-graph diff`, and the one property it exists to hold: a change is reported
 * only against a name that means the same thing in both states (ADR-0020).
 *
 * The cases that matter most are the ones where a naive comparison would report
 * something - a question renumbered, a relation moved into front matter, two
 * items with one title - and this one must say nothing, or say only what it can
 * see.
 *
 * Every export is built inside the test that reads it. Analysing a corpus while
 * the file is collected would make everything it reaches a static mutant
 * (ADR-0007).
 */

const GENERATOR = { name: 'spec-graph', version: '1.2.3' };

/** One state of a corpus, exported and read back the way the command reads it. */
const exported = (files: Readonly<Record<string, string>>, generator = GENERATOR): GraphExport => {
  const sources = Object.entries(files).map(([path, text]): Source => ({ path, text }));
  return parseGraphExport(formatGraph(analyseSources(sources).graph, 'json', { generator }), 'state.json');
};

const lines = (...parts: string[]): string => `${parts.join('\n')}\n`;

const cache = (...questions: string[]): string =>
  lines('---', 'status: accepted', '---', '', '# ADR-0001: Cache', '', '## Open Questions', '', ...questions);

/**
 * An export written by hand, for what spec-graph's own exports never hold - an id
 * two items share, nodes out of order - or to fix every field a report prints.
 */
const assembled = (nodes: readonly object[], edges: readonly object[] = [], generator: object = GENERATOR): GraphExport =>
  parseGraphExport(JSON.stringify({ version: 1, generator, nodes, edges }), 'assembled.json');

const adr = (id: string, title: string, path: string, phase: string, status: string | null) => ({ id, kind: 'document', title, path, phase, status });

const question = (id: string, title: string, openness: string, fields: object = {}) => ({
  id: `ADR-0001#${id}`,
  kind: 'item',
  title,
  document: 'ADR-0001',
  section: ['ADR-0001: Cache', 'Open Questions'],
  openness,
  declared: false,
  ...fields,
});

describe('documents', () => {
  it('reports a document that kept its id through a rename as moved and accepted, not removed and added', () => {
    const plans = (status: string) => lines('---', `status: ${status}`, '---', '', '# ADR-0002: Plans');
    const diff = diffExports(
      exported({ 'docs/adr/0002-plans.md': plans('draft') }),
      exported({ 'docs/adr/0002-cache-plans.md': plans('accepted') }),
    );
    expect(diff.documents.added).toEqual([]);
    expect(diff.documents.removed).toEqual([]);
    expect(diff.documents.changed).toEqual([
      {
        id: 'ADR-0002',
        path: ['docs/adr/0002-plans.md', 'docs/adr/0002-cache-plans.md'],
        phase: ['draft', 'active'],
        status: ['draft', 'accepted'],
      },
    ]);
    expect(formatDiffText(diff)).toContain(
      '  ~ ADR-0002  moved from docs/adr/0002-plans.md to docs/adr/0002-cache-plans.md; draft -> active; status draft -> accepted\n',
    );
    expect(formatDiffMarkdown(diff)).toContain(
      '| changed | `ADR-0002` | moved from docs/adr/0002-plans.md to docs/adr/0002-cache-plans.md; draft -> active; status draft -> accepted |\n',
    );
  });

  it('reports documents added and removed, a retitle and a status first written down', () => {
    const one = (title: string) => lines('---', 'status: accepted', '---', '', `# ADR-0001: ${title}`);
    const diff = diffExports(
      exported({
        'docs/adr/0005-z.md': lines('# ADR-0005: Z'),
        'docs/adr/0001-a.md': one('Cache'),
        'docs/adr/0003-old.md': lines('# ADR-0003: Old'),
      }),
      exported({
        'docs/adr/0005-z.md': lines('---', 'status: accepted', '---', '', '# ADR-0005: Z'),
        'docs/adr/0001-a.md': one('Caching'),
        'docs/adr/0004-new.md': lines('# ADR-0004: New'),
      }),
    );
    expect(diff.documents.added.map((document) => document.id)).toEqual(['ADR-0004']);
    expect(diff.documents.removed.map((document) => document.id)).toEqual(['ADR-0003']);
    expect(diff.documents.changed.map((change) => change.id)).toEqual(['ADR-0001', 'ADR-0005']);
    expect(diff.documents.changed[0]).toEqual({ id: 'ADR-0001', title: ['ADR-0001: Cache', 'ADR-0001: Caching'] });
    expect(formatDiffText(diff)).toBe(
      lines(
        '4 documents changed.',
        '',
        'Documents',
        '  + ADR-0004  ADR-0004: New (unknown)',
        '  - ADR-0003  ADR-0003: Old',
        '  ~ ADR-0001  retitled "ADR-0001: Caching"',
        '  ~ ADR-0005  unknown -> active; status none -> accepted',
      ),
    );
  });

  it('says nothing about a document that did not change', () => {
    const files = { 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') };
    const diff = diffExports(exported(files), exported(files));
    expect(diff.documents).toEqual({ added: [], removed: [], changed: [] });
    expect(diffVerdict(diff)).toBe('No relational change.');
  });
});

describe('relations', () => {
  const target = lines('---', 'status: retired', '---', '', '# ADR-0001: Old');

  it('ignores where a relation was declared', () => {
    const inProse = lines('---', 'status: accepted', '---', '', '# ADR-0002: New', '', 'Supersedes ADR-0001.');
    const inFrontMatter = lines('---', 'status: accepted', 'supersedes: ADR-0001', '---', '', '# ADR-0002: New');
    const before = exported({ 'docs/adr/0001-old.md': target, 'docs/adr/0002-new.md': inProse });
    const after = exported({ 'docs/adr/0001-old.md': target, 'docs/adr/0002-new.md': inFrontMatter });
    // Both states hold the supersession, or this would pass for nothing.
    for (const state of [before, after]) {
      expect(state.edges).toContainEqual({ kind: 'supersedes', from: 'ADR-0002', to: 'ADR-0001' });
    }
    expect(diffExports(before, after).relations).toEqual({ added: [], removed: [] });
  });

  it('lifts an item\'s relation onto the document that owns it', () => {
    const before = exported({ 'docs/adr/0001-a.md': cache('- [ ] Who owns retention?'), 'docs/adr/0002-b.md': target });
    const after = exported({
      'docs/adr/0001-a.md': cache('- [ ] Who owns retention? Deferred to [ADR-0002](0002-b.md).'),
      'docs/adr/0002-b.md': target,
    });
    const { relations } = diffExports(before, after);
    expect(relations.added).toEqual([{ kind: 'delegates-to', from: 'ADR-0001', to: 'ADR-0002' }]);
    expect(relations.removed).toEqual([]);
  });

  it('reports a relation that is gone', () => {
    const dependent = (sentence: string) => lines('---', 'status: accepted', '---', '', '# ADR-0002: New', '', sentence);
    const diff = diffExports(
      exported({ 'docs/adr/0001-old.md': target, 'docs/adr/0002-new.md': dependent('Depends on ADR-0001.') }),
      exported({ 'docs/adr/0001-old.md': target, 'docs/adr/0002-new.md': dependent('Stands alone.') }),
    );
    expect(diff.relations).toEqual({ added: [], removed: [{ kind: 'depends-on', from: 'ADR-0002', to: 'ADR-0001' }] });
  });

  it('says nothing of a document gaining a question, or of a question deferred to its own document', () => {
    const before = exported({ 'docs/adr/0001-a.md': cache() });
    const after = exported({ 'docs/adr/0001-a.md': cache('- [ ] Who owns retention? Deferred to [ADR-0001](0001-a.md).') });
    // Both edges are in the export, and each, lifted, ends where it began.
    expect(after.edges).toEqual([
      { kind: 'contains', from: 'ADR-0001', to: 'ADR-0001#open-questions.1' },
      { kind: 'delegates-to', from: 'ADR-0001#open-questions.1', to: 'ADR-0001' },
    ]);
    expect(diffExports(before, after).relations).toEqual({ added: [], removed: [] });
  });
});

describe('obligations', () => {
  it('does not report a question as reopened because another was inserted above it', () => {
    const before = exported({ 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?', '- [x] Wire format? Resolved: CBOR.') });
    const after = exported({
      'docs/adr/0001-a.md': cache('- [ ] Cache size limit?', '- [ ] Eviction policy?', '- [x] Wire format? Resolved: CBOR.'),
    });
    // The hazard is real in these two exports: the id the closed question had is
    // an open question's now, so a comparison by id would call it reopened.
    const at = (state: GraphExport, id: string) => state.items.find((item) => item.id === id);
    expect(at(before, 'ADR-0001#open-questions.2')?.openness).toBe('closed');
    expect(at(after, 'ADR-0001#open-questions.2')?.openness).toBe('open');

    const { obligations } = diffExports(before, after);
    expect(obligations.transitions).toEqual([]);
    expect(obligations.disappeared).toEqual([]);
    expect(obligations.appeared).toEqual([
      { document: 'ADR-0001', section: ['ADR-0001: Cache', 'Open Questions'], place: 'Open Questions', title: 'Cache size limit?', openness: 'open' },
    ]);
  });

  it('reports a question resolved when its title is unchanged', () => {
    const diff = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') }),
      exported({ 'docs/adr/0001-a.md': cache('- [x] Eviction policy?') }),
    );
    expect(diff.obligations.transitions).toEqual([
      { document: 'ADR-0001', section: ['ADR-0001: Cache', 'Open Questions'], place: 'Open Questions', title: 'Eviction policy?', openness: ['open', 'closed'] },
    ]);
    expect(formatDiffText(diff)).toContain('resolved     ADR-0001 > Open Questions: "Eviction policy?" (open -> closed)');
  });

  it('names a question reopened, and one narrowed, by the openness it went to', () => {
    const reopened = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [x] Eviction policy?') }),
      exported({ 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') }),
    );
    expect(formatDiffText(reopened)).toContain('reopened     ADR-0001 > Open Questions: "Eviction policy?" (closed -> open)');
    const narrowed = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') }),
      exported({ 'docs/adr/0001-a.md': cache('- [~] Eviction policy?') }),
    );
    expect(formatDiffText(narrowed)).toContain('narrowed     ADR-0001 > Open Questions: "Eviction policy?" (open -> partial)');
  });

  it('never pairs a reworded question, and never calls it resolved', () => {
    const { obligations } = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') }),
      exported({ 'docs/adr/0001-a.md': cache('- [x] Eviction policy for large objects?') }),
    );
    expect(obligations.transitions).toEqual([]);
    expect(obligations.disappeared.map((item) => [item.title, item.openness])).toEqual([['Eviction policy?', 'open']]);
    expect(obligations.appeared.map((item) => [item.title, item.openness])).toEqual([['Eviction policy for large objects?', 'closed']]);
  });

  it('pairs by a declared id, however the question was reworded', () => {
    const declared = (box: string, text: string) => cache('<!-- @spec-item id="retention" -->', `- [${box}] ${text}`);
    const before = exported({ 'docs/adr/0001-a.md': declared(' ', 'Who owns retention?') });
    const after = exported({ 'docs/adr/0001-a.md': declared('x', 'Retention is owned by platform.') });
    expect(before.items.map((item) => [item.id, item.declared])).toEqual([['ADR-0001#retention', true]]);
    expect(diffExports(before, after).obligations).toMatchObject({
      transitions: [{ title: 'Retention is owned by platform.', openness: ['open', 'closed'] }],
      appeared: [],
      disappeared: [],
    });
  });

  it('follows a question through a retitle of its document', () => {
    const titled = (title: string, box: string) =>
      lines('---', 'status: accepted', '---', '', `# ADR-0001: ${title}`, '', '## Open Questions', '', `- [${box}] Eviction policy?`);
    const before = exported({ 'docs/adr/0001-a.md': titled('Cache', ' ') });
    const after = exported({ 'docs/adr/0001-a.md': titled('Caching', 'x') });
    // A section path starts at the document's own heading, so it did change.
    expect([before.items[0]?.section, after.items[0]?.section]).toEqual([
      ['ADR-0001: Cache', 'Open Questions'],
      ['ADR-0001: Caching', 'Open Questions'],
    ]);
    expect(diffExports(before, after).obligations).toEqual({
      transitions: [
        { document: 'ADR-0001', section: ['ADR-0001: Caching', 'Open Questions'], place: 'Open Questions', title: 'Eviction policy?', openness: ['open', 'closed'] },
      ],
      appeared: [],
      disappeared: [],
    });
  });

  it('pairs nothing when two items in one section share a title, on either side', () => {
    const both = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] TBD', '- [ ] TBD') }),
      exported({ 'docs/adr/0001-a.md': cache('- [x] TBD', '- [ ] TBD') }),
    );
    expect(both.obligations.transitions).toEqual([]);
    expect(both.obligations.appeared).toHaveLength(2);
    expect(both.obligations.disappeared).toHaveLength(2);

    const oneLeft = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] TBD', '- [ ] TBD') }),
      exported({ 'docs/adr/0001-a.md': cache('- [x] TBD') }),
    );
    expect(oneLeft.obligations.transitions).toEqual([]);
    expect(oneLeft.obligations.appeared).toHaveLength(1);
    expect(oneLeft.obligations.disappeared).toHaveLength(2);
  });

  it('pairs nothing by a declared id that two items share, on either side', () => {
    // spec-graph's own graph keys nodes by id, so its exports never repeat one;
    // an export edited or assembled by something else can, and is still read.
    const dup = (title: string, openness: string) => question('dup', title, openness, { declared: true });
    const twice = assembled([dup('First?', 'open'), dup('Second?', 'open')]);
    const once = assembled([dup('Reworded?', 'closed')]);

    const shrank = diffExports(twice, once).obligations;
    expect(shrank.transitions).toEqual([]);
    expect(shrank.appeared.map((unpaired) => unpaired.title)).toEqual(['Reworded?']);
    expect(shrank.disappeared.map((unpaired) => unpaired.title)).toEqual(['First?', 'Second?']);

    const grew = diffExports(once, twice).obligations;
    expect(grew.transitions).toEqual([]);
    expect(grew.appeared.map((unpaired) => unpaired.title)).toEqual(['First?', 'Second?']);
    expect(grew.disappeared.map((unpaired) => unpaired.title)).toEqual(['Reworded?']);
  });

  it('lists a question whose declared id is gone as disappeared', () => {
    const before = exported({ 'docs/adr/0001-a.md': cache('<!-- @spec-item id="retention" -->', '- [ ] Who owns retention?') });
    const after = exported({ 'docs/adr/0001-a.md': cache() });
    expect(diffExports(before, after).obligations).toEqual({
      transitions: [],
      appeared: [],
      disappeared: [
        { document: 'ADR-0001', section: ['ADR-0001: Cache', 'Open Questions'], place: 'Open Questions', title: 'Who owns retention?', openness: 'open' },
      ],
    });
  });

  it('pairs an item once: by its declared id, and never again by its title', () => {
    // Paired by id, the question kept its openness and changed nothing. The new
    // numbered question took its old title, and must not be read as it resolved.
    const retention = (title: string) => question('retention', title, 'open', { declared: true });
    const before = assembled([retention('Who owns retention?')]);
    const after = assembled([retention('Who owns data retention?'), question('open-questions.2', 'Who owns retention?', 'closed')]);
    expect(diffExports(before, after).obligations).toMatchObject({
      transitions: [],
      appeared: [{ title: 'Who owns retention?', openness: 'closed' }],
      disappeared: [],
    });
  });

  it('trusts no id from an export made before items said whether theirs was declared', () => {
    const declared = (box: string, text: string) => cache('<!-- @spec-item id="retention" -->', `- [${box}] ${text}`);
    const files = (box: string, text: string) => ({ 'docs/adr/0001-a.md': declared(box, text) });
    const sources = Object.entries(files(' ', 'Who owns retention?')).map(([path, text]): Source => ({ path, text }));
    const old = JSON.parse(formatGraph(analyseSources(sources).graph, 'json')) as { nodes: Record<string, unknown>[] };
    for (const node of old.nodes) delete node['declared'];
    const before = parseGraphExport(JSON.stringify(old), 'old.json');
    expect(before.items[0]?.declared).toBeNull();

    const { obligations } = diffExports(before, exported(files('x', 'Retention is owned by platform.')));
    expect(obligations.transitions).toEqual([]);
    expect(obligations.appeared.map((item) => item.title)).toEqual(['Retention is owned by platform.']);
  });
});

describe('generators', () => {
  const files = { 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') };

  it('warns when the two exports were made by different versions, or by one it cannot name', () => {
    expect(generatorWarning(diffExports(exported(files), exported(files)))).toBeNull();
    const newer = diffExports(exported(files), exported(files, { name: 'spec-graph', version: '1.3.0' }));
    expect(generatorWarning(newer)).toBe(
      'the exports were made by spec-graph 1.2.3 and spec-graph 1.3.0; a change in extraction between versions reads as a change in the repository',
    );
    expect(formatDiffText(newer)).toMatch(/^warning: the exports were made by spec-graph 1\.2\.3 and spec-graph 1\.3\.0/);

    const fork = diffExports(exported(files), exported(files, { name: 'spec-graph-fork', version: '1.2.3' }));
    expect(generatorWarning(fork)).toContain('made by spec-graph 1.2.3 and spec-graph-fork 1.2.3;');

    const sources = Object.entries(files).map(([path, text]): Source => ({ path, text }));
    const unnamed = parseGraphExport(formatGraph(analyseSources(sources).graph, 'json'), 'old.json');
    expect(generatorWarning(diffExports(unnamed, exported(files)))).toContain('made by an unknown version and spec-graph 1.2.3;');
    expect(generatorWarning(diffExports(exported(files), unnamed))).toContain('made by spec-graph 1.2.3 and an unknown version;');
  });

  it('names no generator from half of one', () => {
    for (const generator of [{ name: 'spec-graph' }, { version: '1.2.3' }]) {
      expect(assembled([], [], generator).generator).toBeNull();
    }
  });
});

describe('reading an export', () => {
  it('refuses what is not an export, and says how to make one', () => {
    const refused = (raw: string) => {
      try {
        parseGraphExport(raw, 'in.json');
      } catch (error) {
        expect(error).toBeInstanceOf(DiffInputError);
        return (error as Error).message;
      }
      throw new Error('accepted');
    };
    expect(refused('{ not json')).toBe('in.json is not JSON; make it with `spec-graph graph --graph-format json`');
    expect(refused('{"name":"a-package"}')).toBe('in.json is not a graph export; make it with `spec-graph graph --graph-format json`');
    expect(refused('[1,2]')).toContain('is not a graph export');
    expect(refused('{"version":1,"edges":[]}')).toContain('is not a graph export');
    expect(refused('{"version":1,"nodes":[]}')).toContain('is not a graph export');
    expect(refused('{"version":2,"nodes":[],"edges":[]}')).toBe('in.json is export version 2, and this reads version 1');
    expect(refused('{"version":1,"nodes":[{"kind":"document"}],"edges":[]}')).toBe('in.json: node 0 has no id');
    expect(refused('{"version":1,"nodes":[null],"edges":[]}')).toBe('in.json: node 0 has no id');
    expect(refused('{"version":1,"nodes":[{"id":"x","kind":"folder"}],"edges":[]}')).toBe('in.json: node x is neither a document nor an item');
    for (const edge of ['{"from":"a","to":"b"}', '{"kind":"depends-on","to":"b"}', '{"kind":"depends-on","from":"a"}']) {
      expect(refused(`{"version":1,"nodes":[],"edges":[${edge}]}`)).toBe('in.json: edge 0 is missing its kind or ends');
    }
  });

  it('reads a field it does not know as a field it does not use, and one it lacks as empty', () => {
    const later = parseGraphExport(
      JSON.stringify({
        version: 1,
        later: true,
        nodes: [
          { id: 'A', kind: 'document', later: 1 },
          { id: 'A#1', kind: 'item' },
          { id: 'A#2', kind: 'item', section: ['Open Questions', 2] },
        ],
        edges: [],
      }),
      'in.json',
    );
    expect(later.documents).toEqual([{ id: 'A', title: '', path: '', phase: 'unknown', status: null }]);
    expect(later.items).toEqual([
      { id: 'A#1', title: '', document: '', section: [], openness: 'unknown', declared: null },
      { id: 'A#2', title: '', document: '', section: ['Open Questions'], openness: 'unknown', declared: null },
    ]);
  });
});

describe('reports', () => {
  /**
   * Two exports holding at least two of every kind of change, written by hand so
   * every field a report prints is fixed. Nodes and edges are listed in order,
   * as spec-graph writes them, unless `reversed`.
   */
  const everyKindOfChange = ({ reversed = false } = {}): [GraphExport, GraphExport] => {
    const order = <T>(list: T[]): T[] => (reversed ? [...list].reverse() : list);
    const cacheDocument = adr('ADR-0001', 'ADR-0001: Cache', 'docs/adr/0001-cache.md', 'active', 'accepted');
    const storage = { section: ['ADR-0001: Cache', 'Open Questions', 'Storage'] };
    const before = assembled(
      order([
        cacheDocument,
        adr('ADR-0002', 'ADR-0002: Plans', 'docs/adr/0002-plans.md', 'draft', 'draft'),
        adr('ADR-0003', 'ADR-0003: Old', 'docs/adr/0003-old.md', 'active', 'accepted'),
        adr('ADR-0005', 'ADR-0005: Gone', 'docs/adr/0005-gone.md', 'unknown', null),
        adr('ADR-0007', 'ADR-0007: Log', 'docs/adr/0007-log.md', 'active', 'accepted'),
        question('open-questions.1', 'Eviction policy?', 'open'),
        question('open-questions.2', 'Size limit?', 'closed'),
        question('open-questions.3', 'Wire format?', 'open'),
        question('open-questions.4', 'Retention?', 'partial'),
        question('storage.1', 'Where does the log go?', 'open', storage),
        question('storage.2', 'Who rotates it?', 'partial', storage),
      ]),
      order([
        { kind: 'depends-on', from: 'ADR-0002', to: 'ADR-0001' },
        { kind: 'references', from: 'ADR-0001', to: 'ADR-0003' },
        { kind: 'supersedes', from: 'ADR-0007', to: 'ADR-0005' },
      ]),
    );
    const after = assembled(
      order([
        cacheDocument,
        adr('ADR-0002', 'ADR-0002: Plans', 'docs/adr/0002-cache-plans.md', 'active', 'accepted'),
        adr('ADR-0004', 'ADR-0004: New', 'docs/adr/0004-new.md', 'active', 'accepted'),
        adr('ADR-0006', 'ADR-0006: Newer', 'docs/adr/0006-newer.md', 'draft', 'proposed'),
        adr('ADR-0007', 'ADR-0007: Logging', 'docs/adr/0007-log.md', 'active', null),
        question('open-questions.1', 'Eviction policy?', 'closed'),
        question('open-questions.2', 'Size limit?', 'open'),
        question('open-questions.3', 'Wire format?', 'partial'),
        question('open-questions.4', 'Retention?', 'open'),
        // Under a heading that is not its document's title, and under none.
        question('open-questions.1', 'Who reads it?', 'open', { id: 'ADR-0004#open-questions.1', document: 'ADR-0004', section: ['Open Questions'] }),
        question('1', 'Anything else?', 'open', { id: 'ADR-0006#1', document: 'ADR-0006', section: [] }),
      ]),
      order([
        { kind: 'depends-on', from: 'ADR-0002', to: 'ADR-0001' },
        { kind: 'supersedes', from: 'ADR-0004', to: 'ADR-0003' },
        { kind: 'delegates-to', from: 'ADR-0001#open-questions.4', to: 'ADR-0006' },
      ]),
      { name: 'spec-graph', version: '1.3.0' },
    );
    return [before, after];
  };

  it('writes every kind of change, in the terminal and in markdown', () => {
    const diff = diffExports(...everyKindOfChange());
    const warning =
      'the exports were made by spec-graph 1.2.3 and spec-graph 1.3.0; a change in extraction between versions reads as a change in the repository';
    expect(formatDiffText(diff)).toBe(
      lines(
        `warning: ${warning}`,
        '',
        '6 documents, 4 relations and 8 obligations changed.',
        '',
        'Documents',
        '  + ADR-0004  ADR-0004: New (active)',
        '  + ADR-0006  ADR-0006: Newer (draft)',
        '  - ADR-0003  ADR-0003: Old',
        '  - ADR-0005  ADR-0005: Gone',
        '  ~ ADR-0002  moved from docs/adr/0002-plans.md to docs/adr/0002-cache-plans.md; draft -> active; status draft -> accepted',
        '  ~ ADR-0007  status accepted -> none; retitled "ADR-0007: Logging"',
        '',
        'Relations',
        '  + ADR-0001 -delegates-to-> ADR-0006',
        '  + ADR-0004 -supersedes-> ADR-0003',
        '  - ADR-0001 -references-> ADR-0003',
        '  - ADR-0007 -supersedes-> ADR-0005',
        '',
        'Obligations',
        '  resolved     ADR-0001 > Open Questions: "Eviction policy?" (open -> closed)',
        '  widened      ADR-0001 > Open Questions: "Retention?" (partial -> open)',
        '  reopened     ADR-0001 > Open Questions: "Size limit?" (closed -> open)',
        '  narrowed     ADR-0001 > Open Questions: "Wire format?" (open -> partial)',
        '  appeared     ADR-0004 > Open Questions: "Who reads it?" (open)',
        '  appeared     ADR-0006: "Anything else?" (open)',
        '  disappeared  ADR-0001 > Open Questions > Storage: "Where does the log go?" (was open)',
        '  disappeared  ADR-0001 > Open Questions > Storage: "Who rotates it?" (was partial)',
      ),
    );
    expect(formatDiffMarkdown(diff)).toBe(
      lines(
        '### spec-graph diff',
        '',
        '6 documents, 4 relations and 8 obligations changed.',
        '',
        `> **Warning:** ${warning}.`,
        '',
        '| | Document | Change |',
        '| --- | --- | --- |',
        '| added | `ADR-0004` | ADR-0004: New - active |',
        '| added | `ADR-0006` | ADR-0006: Newer - draft |',
        '| removed | `ADR-0003` | ADR-0003: Old |',
        '| removed | `ADR-0005` | ADR-0005: Gone |',
        '| changed | `ADR-0002` | moved from docs/adr/0002-plans.md to docs/adr/0002-cache-plans.md; draft -> active; status draft -> accepted |',
        '| changed | `ADR-0007` | status accepted -> none; retitled "ADR-0007: Logging" |',
        '',
        '| | From | Relation | To |',
        '| --- | --- | --- | --- |',
        '| added | `ADR-0001` | delegates-to | `ADR-0006` |',
        '| added | `ADR-0004` | supersedes | `ADR-0003` |',
        '| removed | `ADR-0001` | references | `ADR-0003` |',
        '| removed | `ADR-0007` | supersedes | `ADR-0005` |',
        '',
        '| | Where | Obligation |',
        '| --- | --- | --- |',
        '| resolved | ADR-0001 > Open Questions | Eviction policy? (open -> closed) |',
        '| widened | ADR-0001 > Open Questions | Retention? (partial -> open) |',
        '| reopened | ADR-0001 > Open Questions | Size limit? (closed -> open) |',
        '| narrowed | ADR-0001 > Open Questions | Wire format? (open -> partial) |',
        '| appeared | ADR-0004 > Open Questions | Who reads it? (open) |',
        '| appeared | ADR-0006 | Anything else? (open) |',
        '| disappeared | ADR-0001 > Open Questions > Storage | Where does the log go? (was open) |',
        '| disappeared | ADR-0001 > Open Questions > Storage | Who rotates it? (was partial) |',
      ),
    );
  });

  it('lists what arrived where nothing was, and what is gone when nothing arrived', () => {
    const arrived = formatDiffText(diffExports(assembled([], []), everyKindOfChange()[1]));
    expect(arrived).toContain('\n\nObligations\n  appeared     ADR-0001 > Open Questions: "Eviction policy?" (closed)\n');

    const gone = diffExports(everyKindOfChange()[0], assembled([], []));
    const text = formatDiffText(gone);
    expect(text).toMatch(/^5 documents, 3 relations and 6 obligations changed\.\n\nDocuments\n {2}- ADR-0001 {2}ADR-0001: Cache\n/);
    expect(text).toContain('\n\nRelations\n  - ADR-0002 -depends-on-> ADR-0001\n');
    expect(text).toContain('\n\nObligations\n  disappeared  ADR-0001 > Open Questions: "Eviction policy?" (was open)\n');
    const markdown = formatDiffMarkdown(gone);
    expect(markdown).toContain('| --- | --- | --- |\n| removed | `ADR-0001` | ADR-0001: Cache |\n');
    expect(markdown).toContain('| --- | --- | --- | --- |\n| removed | `ADR-0002` | depends-on | `ADR-0001` |\n');
    expect(markdown).toContain('| --- | --- | --- |\n| disappeared | ADR-0001 > Open Questions | Eviction policy? (was open) |\n');
  });

  it('writes the same bytes whatever order an export lists its nodes and edges in', () => {
    const inOrder = diffExports(...everyKindOfChange());
    const reversed = diffExports(...everyKindOfChange({ reversed: true }));
    for (const format of [formatDiffText, formatDiffMarkdown, formatDiffJson]) expect(format(reversed)).toBe(format(inOrder));
  });

  it('says there is no relational change in one line when there is none', () => {
    const files = { 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') };
    const diff = diffExports(exported(files), exported(files));
    expect(formatDiffText(diff)).toBe('No relational change.\n');
    expect(formatDiffMarkdown(diff)).toBe('### spec-graph diff\n\nNo relational change.\n');
  });

  it('counts what changed in the verdict, with plurals', () => {
    const one = lines('# ADR-0001: One');
    const two = lines('# ADR-0002: Two', '', 'Depends on ADR-0001.');
    expect(diffVerdict(diffExports(exported({ 'a.md': one }), exported({ 'a.md': one, 'b.md': two })))).toBe(
      '1 document and 1 relation changed.',
    );
    expect(
      diffVerdict(diffExports(exported({ 'docs/adr/0001-a.md': cache() }), exported({ 'docs/adr/0001-a.md': cache('- [ ] A?', '- [ ] B?') }))),
    ).toBe('2 obligations changed.');
  });

  it('keeps every markdown table rectangular, whatever a title holds', () => {
    const diff = diffExports(
      exported({ 'docs/adr/0001-a.md': cache('- [ ] Plain?') }),
      exported({
        'docs/adr/0001-a.md': cache('- [x] Plain?', '- [ ] A | B?'),
        'docs/adr/0002-b.md': lines('# ADR-0002: Pipes | too', '', 'Depends on ADR-0001.'),
      }),
    );
    const markdown = formatDiffMarkdown(diff);
    const tables = markdown.split('\n\n').filter((block) => block.startsWith('|'));
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      // An escaped pipe is an entity, so every literal pipe left is a cell border.
      const widths = table.trim().split('\n').map((row) => row.split('|').length);
      expect(new Set(widths).size, table).toBe(1);
    }
    expect(markdown).toContain('A &#124; B?');
  });

  it('writes the same bytes for the same exports, in whatever order the files were read', () => {
    const files = {
      'docs/adr/0001-a.md': cache('- [x] Eviction policy?', '- [ ] Size?'),
      'docs/adr/0002-b.md': lines('# ADR-0002: B', '', 'Depends on ADR-0001.'),
      'docs/adr/0003-c.md': lines('# ADR-0003: C', '', 'Depends on ADR-0002.'),
    };
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const base = { 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') };
    const first = diffExports(exported(base), exported(files));
    const second = diffExports(exported(base), exported(reversed));
    for (const format of [formatDiffText, formatDiffMarkdown, formatDiffJson]) expect(format(second)).toBe(format(first));
    expect(first.documents.added.map((document) => document.id)).toEqual(['ADR-0002', 'ADR-0003']);
  });

  it('gives a bot the diff itself, with the verdict and the warning beside it', () => {
    const files = { 'docs/adr/0001-a.md': cache('- [ ] Eviction policy?') };
    const diff = diffExports(exported(files), exported({ 'docs/adr/0001-a.md': cache('- [x] Eviction policy?') }, { name: 'spec-graph', version: '2.0.0' }));
    const json = JSON.parse(formatDiffJson(diff)) as Record<string, unknown>;
    expect(json).toMatchObject({ version: 1, verdict: '1 obligation changed.', obligations: { transitions: [{ openness: ['open', 'closed'] }] } });
    expect(json['warning']).toContain('spec-graph 2.0.0');
  });
});

describe('the export a diff reads', () => {
  it('names its generator only when told it', () => {
    const graph = () => analyseSources([{ path: 'a.md', text: lines('# ADR-0001: A') }]).graph;
    expect(JSON.parse(formatGraph(graph(), 'json', { generator: GENERATOR }))).toMatchObject({ version: 1, generator: GENERATOR });
    expect(JSON.parse(formatGraph(graph(), 'json'))).not.toHaveProperty('generator');
  });

  it('says whether an item\'s id was declared or numbered', () => {
    // In separate documents: a directive currently binds every item within reach
    // below it, which is a defect of its own and not what this asserts.
    const state = exported({
      'docs/adr/0001-a.md': cache('<!-- @spec-item id="retention" -->', '- [ ] Who owns retention?'),
      'docs/adr/0002-b.md': lines('---', 'status: accepted', '---', '', '# ADR-0002: B', '', '## Open Questions', '', '- [ ] Numbered?'),
    });
    expect(state.items.map((item) => [item.id, item.declared])).toEqual([
      ['ADR-0001#retention', true],
      ['ADR-0002#open-questions.1', false],
    ]);
  });
});
