import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';
import { attributesOf, execute, matches, parseQuery, query, QueryError, renderMatch } from '../src/select.js';
import type { SpecGraph } from '../src/graph.js';

const SOURCES: Source[] = [
  { path: 'docs/adr/0001-base.md', text: '---\nstatus: accepted\nowner: platform\n---\n\n# Base\n' },
  {
    path: 'docs/adr/0002-old.md',
    text: '---\nstatus: superseded\nsuperseded-by: ADR-0003\n---\n\n# Old\n',
  },
  {
    path: 'docs/adr/0003-mid.md',
    text: '---\nstatus: superseded\nsupersedes: ADR-0002\nsuperseded-by: ADR-0004\n---\n\n# Mid\n',
  },
  {
    path: 'docs/adr/0004-new.md',
    text: [
      '---',
      'status: accepted',
      'supersedes: ADR-0003',
      'depends-on: ADR-0001',
      '---',
      '',
      '# New',
      '',
      '## Open Questions',
      '',
      '- [ ] Eviction policy? Deferred to [ADR-0002](0002-old.md).',
      '- [~] Cache size? Narrowed: 2 GB for now.',
      '- [x] Wire format? Resolved: CBOR.',
    ].join('\n'),
  },
];

const graph: SpecGraph = analyseSources(SOURCES).graph;
const ids = (selector: string): string[] =>
  query(graph, selector).map((match) => match.nodes[match.nodes.length - 1]?.id ?? '');

/* -------------------------------------------------------------------------- */

describe('parsing', () => {
  it('parses a bare node type', () => {
    expect(parseQuery('document')).toEqual({ start: { kind: 'document', predicates: [] }, steps: [] });
  });

  it('accepts plural and wildcard node types', () => {
    for (const word of ['document', 'documents', 'doc', 'docs']) {
      expect(parseQuery(word).start.kind).toBe('document');
    }
    for (const word of ['*', 'node', 'any']) {
      expect(parseQuery(word).start.kind).toBeNull();
    }
  });

  it('parses a predicate with no operator as a presence check', () => {
    expect(parseQuery('document[status]').start.predicates[0]).toEqual({
      key: 'status',
      operator: 'exists',
      value: '',
    });
  });

  it('parses quoted values, escapes included', () => {
    expect(parseQuery('document[title="a b"]').start.predicates[0]?.value).toBe('a b');
    expect(parseQuery("document[title='a b']").start.predicates[0]?.value).toBe('a b');
    expect(parseQuery('document[title="a\\"b"]').start.predicates[0]?.value).toBe('a"b');
  });

  it('parses every arrow form', () => {
    expect(parseQuery('document -assumes-> document').steps[0]).toMatchObject({
      direction: 'out',
      kinds: ['assumes'],
      transitive: false,
    });
    expect(parseQuery('document <-assumes- document').steps[0]).toMatchObject({
      direction: 'in',
      kinds: ['assumes'],
      transitive: false,
    });
    expect(parseQuery('document =supersedes=> document').steps[0]).toMatchObject({
      direction: 'out',
      transitive: true,
    });
    expect(parseQuery('document <=supersedes= document').steps[0]).toMatchObject({
      direction: 'in',
      transitive: true,
    });
  });

  it('parses a hyphenated relation name without confusing it for the arrow', () => {
    expect(parseQuery('item -delegates-to-> document').steps[0]?.kinds).toEqual(['delegates-to']);
    expect(parseQuery('item <-delegates-to- document').steps[0]?.kinds).toEqual(['delegates-to']);
  });

  it('parses a comma-separated relation list', () => {
    expect(parseQuery('item -assumes,depends-on-> document').steps[0]?.kinds).toEqual(['assumes', 'depends-on']);
  });

  it('treats an empty or starred relation as any relation', () => {
    expect(parseQuery('document --> document').steps[0]?.kinds).toBeNull();
    expect(parseQuery('document -*-> document').steps[0]?.kinds).toBeNull();
  });

  it('parses a multi-step path', () => {
    expect(parseQuery('document -contains-> item -delegates-to-> document').steps).toHaveLength(2);
  });

  it('rejects an unknown node type and names the real ones', () => {
    expect(() => parseQuery('widget')).toThrow(/document, item/);
  });

  it('rejects an unknown relation and names the real ones', () => {
    expect(() => parseQuery('document -invents-> document')).toThrow(/delegates-to/);
  });

  it('rejects a malformed predicate', () => {
    expect(() => parseQuery('document[')).toThrow(/attribute name/);
    expect(() => parseQuery('document[phase')).toThrow(/operator/);
    expect(() => parseQuery('document[phase=active')).toThrow(/"\]"/);
    expect(() => parseQuery('document[title="unterminated]')).toThrow(/unterminated/);
  });

  it('rejects a mismatched arrow', () => {
    expect(() => parseQuery('document -supersedes=> document')).toThrow(/mismatched arrow/);
  });

  it('rejects a step that is not an arrow', () => {
    expect(() => parseQuery('document then document')).toThrow(/relation step/);
  });

  it('reports the offset of the failure', () => {
    try {
      parseQuery('document[phase');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).offset).toBeGreaterThan(0);
    }
  });
});

describe('attributes', () => {
  const base = graph.document('ADR-0001');
  const item = graph.items.find((node) => node.disposition === 'narrowed');

  it('exposes shared attributes on both node kinds', () => {
    expect(attributesOf(base!, 'id')).toEqual(['ADR-0001']);
    expect(attributesOf(base!, 'kind')).toEqual(['document']);
    expect(attributesOf(item!, 'kind')).toEqual(['item']);
    expect(attributesOf(base!, 'line')).toEqual(['1']);
    expect(attributesOf(item!, 'document')).toEqual(['ADR-0004']);
  });

  it('exposes document attributes', () => {
    expect(attributesOf(base!, 'phase')).toEqual(['active']);
    expect(attributesOf(base!, 'receptivity')).toEqual(['receptive']);
    expect(attributesOf(base!, 'status')).toEqual(['accepted']);
    expect(attributesOf(base!, 'fm.owner')).toEqual(['platform']);
    expect(attributesOf(base!, 'alias')).toContain('adr0001');
    expect(attributesOf(base!, 'fm.missing')).toEqual([]);
    expect(attributesOf(base!, 'nonsense')).toEqual([]);
  });

  it('exposes item attributes', () => {
    expect(attributesOf(item!, 'state')).toEqual(['narrowed']);
    expect(attributesOf(item!, 'disposition')).toEqual(['narrowed']);
    expect(attributesOf(item!, 'openness')).toEqual(['partial']);
    expect(attributesOf(item!, 'section')).toEqual(['New', 'Open Questions']);
    expect(attributesOf(item!, 'evidence')).toEqual(['marker']);
    expect(attributesOf(item!, 'conflicted')).toEqual(['false']);
    expect(attributesOf(item!, 'nonsense')).toEqual([]);
  });

  it('lets an item inherit lifecycle attributes from its document', () => {
    expect(attributesOf(item!, 'phase', graph)).toEqual(['active']);
    expect(attributesOf(item!, 'receptivity', graph)).toEqual(['receptive']);
    // Without a graph there is no owner to inherit from, and it says so rather
    // than inventing a phase.
    expect(attributesOf(item!, 'phase')).toEqual([]);
    expect(attributesOf(item!, 'path')).toEqual(['docs/adr/0004-new.md']);
  });
});

describe('matching', () => {
  const base = graph.document('ADR-0001');

  it('matches on node kind', () => {
    expect(matches(base!, { kind: 'document', predicates: [] })).toBe(true);
    expect(matches(base!, { kind: 'item', predicates: [] })).toBe(false);
    expect(matches(base!, { kind: null, predicates: [] })).toBe(true);
  });

  it('applies every operator', () => {
    expect(ids('document[id=ADR-0001]')).toEqual(['ADR-0001']);
    expect(ids('document[id^=ADR-000]')).toHaveLength(4);
    expect(ids('document[id$=0004]')).toEqual(['ADR-0004']);
    expect(ids('document[title*=ol]')).toEqual(['ADR-0002']);
    expect(ids('document[phase!=retired]')).toEqual(['ADR-0001', 'ADR-0004']);
    expect(ids('document[fm.owner]')).toEqual(['ADR-0001']);
  });

  it('matches case-insensitively', () => {
    expect(ids('document[id=adr-0001]')).toEqual(['ADR-0001']);
    expect(ids('document[phase=ACTIVE]')).toHaveLength(2);
  });

  it('matches a multi-valued attribute when any value matches', () => {
    // `section` holds the whole heading path, so the item matches on either.
    expect(ids('item[section="Open Questions"]')).toHaveLength(3);
    expect(ids('item[section=New]')).toHaveLength(3);
  });

  it('rejects an unquoted value containing a space rather than truncating it', () => {
    // Silently matching on "Open" would be worse than saying the query is wrong.
    expect(() => parseQuery('item[section=Open Questions]')).toThrow(QueryError);
  });

  it('treats an invalid regex as matching nothing instead of crashing', () => {
    expect(ids('document[id~="("]')).toEqual([]);
  });

  it('combines predicates conjunctively', () => {
    expect(ids('document[phase=active][id$=0004]')).toEqual(['ADR-0004']);
    expect(ids('document[phase=active][id$=9999]')).toEqual([]);
  });
});

describe('traversal', () => {
  it('walks one hop forwards and backwards', () => {
    expect(ids('document[id=ADR-0004] -supersedes-> document')).toEqual(['ADR-0003']);
    expect(ids('document[id=ADR-0003] <-supersedes- document')).toEqual(['ADR-0004']);
  });

  it('walks transitively, and reports the whole path', () => {
    const found = query(graph, 'document[id=ADR-0004] =supersedes=> document');
    expect(found.map((m) => m.nodes[m.nodes.length - 1]?.id).sort()).toEqual(['ADR-0002', 'ADR-0003']);
    const deep = found.find((m) => m.nodes[m.nodes.length - 1]?.id === 'ADR-0002');
    expect(deep?.edges).toHaveLength(2);
  });

  it('walks transitively backwards', () => {
    expect(ids('document[id=ADR-0002] <=supersedes= document').sort()).toEqual(['ADR-0003', 'ADR-0004']);
  });

  it('follows any relation when none is named', () => {
    expect(ids('document[id=ADR-0004] --> *').length).toBeGreaterThan(1);
  });

  it('chains steps', () => {
    expect(ids('document[id=ADR-0004] -contains-> item -delegates-to-> document')).toEqual(['ADR-0002']);
  });

  it('returns nothing rather than throwing when a step dead-ends', () => {
    expect(ids('document[id=ADR-0001] -supersedes-> document -supersedes-> document')).toEqual([]);
  });

  it('caps expansion but not the initial selection', () => {
    // Truncating the start set would silently drop rule findings; truncating a
    // runaway expansion only drops paths nobody was going to read.
    expect(execute(graph, parseQuery('*'), { limit: 2 })).toHaveLength(graph.nodes.size);
    expect(execute(graph, parseQuery('* --> *'), { limit: 2 })).toHaveLength(2);
  });

  it('renders a path the way a report shows it', () => {
    const [match] = query(graph, 'document[id=ADR-0004] -contains-> item -delegates-to-> document');
    expect(renderMatch(match!)).toBe('ADR-0004 -contains-> ADR-0004#open-questions.1 -delegates-to-> ADR-0002');
    expect(renderMatch({ nodes: [graph.document('ADR-0001')!], edges: [] })).toBe('ADR-0001');
  });
});

describe('reflexive edges', () => {
  const selfLinking = analyseSources([
    {
      path: 'docs/adr/0001-a.md',
      text: ['---', 'status: accepted', '---', '', '# A', '', 'Depends on [ADR-0001](0001-a.md).'].join('\n'),
    },
  ]).graph;

  it('are excluded from traversal by default', () => {
    // A document that links to itself is a formatting quirk. Traversing it
    // would turn every table of contents into a relationship.
    expect(query(selfLinking, 'document -depends-on-> document')).toHaveLength(0);
  });

  it('can be opted into', () => {
    const found = execute(selfLinking, parseQuery('document -depends-on-> document'), { allowReflexive: true });
    expect(found).toHaveLength(1);
  });
});
