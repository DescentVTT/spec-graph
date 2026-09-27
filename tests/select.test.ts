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

// Analysed inside each test that reads it, never once when this file is
// collected. Work done before any test is named is counted by Stryker as static,
// and every mutant it reaches reruns the whole suite (ADR-0007). The corpus is
// four documents, so analysing it again costs a millisecond.
const corpus = (): SpecGraph => analyseSources(SOURCES).graph;
const ids = (selector: string): string[] =>
  query(corpus(), selector).map((match) => match.nodes[match.nodes.length - 1]?.id ?? '');

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
  const nodes = () => {
    const graph = corpus();
    return { graph, base: graph.document('ADR-0001'), item: graph.items.find((node) => node.disposition === 'narrowed') };
  };

  it('exposes shared attributes on both node kinds', () => {
    const { base, item } = nodes();
    expect(attributesOf(base!, 'id')).toEqual(['ADR-0001']);
    expect(attributesOf(base!, 'kind')).toEqual(['document']);
    expect(attributesOf(item!, 'kind')).toEqual(['item']);
    expect(attributesOf(base!, 'line')).toEqual(['1']);
    expect(attributesOf(item!, 'document')).toEqual(['ADR-0004']);
  });

  it('exposes document attributes', () => {
    const { base } = nodes();
    expect(attributesOf(base!, 'phase')).toEqual(['active']);
    expect(attributesOf(base!, 'receptivity')).toEqual(['receptive']);
    expect(attributesOf(base!, 'status')).toEqual(['accepted']);
    expect(attributesOf(base!, 'fm.owner')).toEqual(['platform']);
    expect(attributesOf(base!, 'alias')).toContain('adr0001');
    expect(attributesOf(base!, 'fm.missing')).toEqual([]);
    expect(attributesOf(base!, 'nonsense')).toEqual([]);
  });

  it('exposes item attributes', () => {
    const { item } = nodes();
    expect(attributesOf(item!, 'state')).toEqual(['narrowed']);
    expect(attributesOf(item!, 'disposition')).toEqual(['narrowed']);
    expect(attributesOf(item!, 'openness')).toEqual(['partial']);
    expect(attributesOf(item!, 'section')).toEqual(['New', 'Open Questions']);
    expect(attributesOf(item!, 'evidence')).toEqual(['marker']);
    expect(attributesOf(item!, 'conflicted')).toEqual(['false']);
    expect(attributesOf(item!, 'nonsense')).toEqual([]);
  });

  it('lets an item inherit lifecycle attributes from its document', () => {
    const { graph, item } = nodes();
    expect(attributesOf(item!, 'phase', graph)).toEqual(['active']);
    expect(attributesOf(item!, 'receptivity', graph)).toEqual(['receptive']);
    // Without a graph there is no owner to inherit from, and it says so rather
    // than inventing a phase.
    expect(attributesOf(item!, 'phase')).toEqual([]);
    expect(attributesOf(item!, 'path')).toEqual(['docs/adr/0004-new.md']);
  });

  it('lets an item answer to its document\'s status and to every spelling of its name', () => {
    // The README: items inherit their document's lifecycle, path and aliases.
    const items = ['ADR-0004#open-questions.1', 'ADR-0004#open-questions.2', 'ADR-0004#open-questions.3'];
    expect(ids('item[status=accepted]').sort()).toEqual(items);
    expect(ids('item[alias=adr4]').sort()).toEqual(items);
  });

  it('answers title, file and document on either kind of node', () => {
    expect(ids('document[title=Base]')).toEqual(['ADR-0001']);
    expect(ids('*[file=docs/adr/0001-base.md]')).toEqual(['ADR-0001']);
    // A document is its own document, so this is ADR-0004 and what it holds.
    expect(ids('*[document=ADR-0004]').sort()).toEqual([
      'ADR-0004',
      'ADR-0004#open-questions.1',
      'ADR-0004#open-questions.2',
      'ADR-0004#open-questions.3',
    ]);
  });
});

describe('attributes a corpus has to be written for', () => {
  const graph = (): SpecGraph =>
    analyseSources([
      {
        path: 'docs/adr/0001-cache.md',
        text: [
          '---',
          'status: accepted',
          'owner: platform',
          'reviewer: ""',
          'tags: [cache, storage]',
          '---',
          '',
          '# Use C++ for the cache',
          '',
          '## Open Questions',
          '',
          '- [ ] Eviction policy?',
          '  Still argued about.',
          '- [ ] Size? Resolved: 2 GB.',
        ].join('\n'),
      },
      { path: 'docs/adr/0002-draft.md', text: '# A document that never says what state it is in\n' },
    ]).graph;
  const found = (selector: string): string[] => query(graph(), selector).map((m) => m.nodes[0]?.id ?? '');

  it('answers status only where one was written', () => {
    expect(found('document[status]')).toEqual(['ADR-0001']);
    expect(found('document[status!=accepted]')).toEqual(['ADR-0002']);
  });

  it('reads front matter through the fm. namespace and nowhere else', () => {
    expect(found('document[fm.owner=platform]')).toEqual(['ADR-0001']);
    // An underscore for the dot is an unknown key, and an unknown key matches
    // nothing rather than guessing which front-matter key was meant.
    expect(found('document[fm_owner=platform]')).toEqual([]);
  });

  it('matches a list-valued front-matter key on any of its entries', () => {
    expect(found('document[fm.tags=storage]')).toEqual(['ADR-0001']);
    expect(found('document[fm.tags=cache]')).toEqual(['ADR-0001']);
  });

  it('does not count an empty value as present', () => {
    expect(found('document[fm.owner]')).toEqual(['ADR-0001']);
    expect(found('document[fm.reviewer]')).toEqual([]);
  });

  it('reads an item\'s first line as its text and all of it as its body', () => {
    expect(found('item[text="Eviction policy?"]')).toEqual(['ADR-0001#open-questions.1']);
    expect(found('item[body*=argued]')).toEqual(['ADR-0001#open-questions.1']);
    expect(found('item[text*=argued]')).toEqual([]);
  });

  it('marks an item whose signals disagree about whether it is open', () => {
    // An empty box under a body that says "Resolved" is worth a human's look.
    expect(found('item[conflicted=true]')).toEqual(['ADR-0001#open-questions.2']);
    expect(found('item[conflicted=false]')).toEqual(['ADR-0001#open-questions.1']);
  });

  it('matches = exactly, $= at the end only, and *= as literal text', () => {
    expect(found('document[id=ADR-000]')).toEqual([]);
    expect(found('document[id$=ADR]')).toEqual([]);
    // `C++` is not a pattern, and matching it as one would refuse to compile.
    expect(found('document[title*=c++]')).toEqual(['ADR-0001']);
  });
});

describe('matching', () => {
  it('matches on node kind', () => {
    const base = corpus().document('ADR-0001');
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

  it('rejects an unparseable pattern rather than matching nothing with it', () => {
    // It used to match nothing, which is indistinguishable from a pattern that
    // ran and found none. Every other mistake in this grammar is a usage error
    // that points at the character; a pattern is now one too. See ADR-0017.
    expect(() => parseQuery('document[id~="("]')).toThrow(QueryError);
    expect(() => parseQuery('document[id~=a{3,1}]')).toThrow(QueryError);
  });

  it('matches a pattern with the automaton, not with RegExp', () => {
    // The matcher lives in spec-core now, and its own suite holds it to
    // RegExp. What is held here is that `~=` reaches it: the ADR-0017 title
    // pattern against a fifty-four-character title that fails it takes RegExp
    // over a minute, and a lookahead is refused rather than run.
    const title = 'the quick brown fox jumps over the lazy dog and keeps!';
    const graph = analyseSources([{ path: 'docs/a.md', text: `---\nstatus: accepted\n---\n\n# ${title}\n` }]).graph;
    const started = performance.now();
    expect(query(graph, 'document[title~="^([A-Za-z0-9_]+[ ]?)+$"]')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => parseQuery('document[id~="(?=ADR)"]')).toThrow('lookaround is not supported');
  });

  it('points at the character of the pattern that failed, not at the predicate', () => {
    // The caret is the whole reason a pattern is compiled while parsing rather
    // than on first use: this is the only place that knows where it was written.
    const selector = 'document[id~="ab(c"]';
    try {
      parseQuery(selector);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect(selector[(error as QueryError).offset]).toBe('(');
    }
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
    const graph = corpus();
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
    const graph = corpus();
    // Truncating the start set would silently drop rule findings; truncating a
    // runaway expansion only drops paths nobody was going to read.
    expect(execute(graph, parseQuery('*'), { limit: 2 })).toHaveLength(graph.nodes.size);
    expect(execute(graph, parseQuery('* --> *'), { limit: 2 })).toHaveLength(2);
  });

  it('renders a path the way a report shows it', () => {
    const graph = corpus();
    const [match] = query(graph, 'document[id=ADR-0004] -contains-> item -delegates-to-> document');
    expect(renderMatch(match!)).toBe('ADR-0004 -contains-> ADR-0004#open-questions.1 -delegates-to-> ADR-0002');
    expect(renderMatch({ nodes: [graph.document('ADR-0001')!], edges: [] })).toBe('ADR-0001');
  });

  it('renders every node a transitive path passed through, and each edge the way it points', () => {
    // `spec-graph query 'document[id=ADR-0009] =supersedes=> document'` is in
    // the README. Reading the middle of a transitive path off its end printed
    // `ADR-0004 -supersedes-> ADR-0002 -supersedes-> ADR-0002`, and a backward
    // step printed as if the relation pointed the other way.
    const graph = corpus();
    const rendered = (selector: string): string[] => query(graph, selector).map(renderMatch).sort();
    expect(rendered('document[id=ADR-0004] =supersedes=> document')).toEqual([
      'ADR-0004 -supersedes-> ADR-0003',
      'ADR-0004 -supersedes-> ADR-0003 -supersedes-> ADR-0002',
    ]);
    expect(rendered('document[id=ADR-0003] <-supersedes- document')).toEqual(['ADR-0003 <-supersedes- ADR-0004']);
    expect(rendered('document[id=ADR-0002] <=supersedes= document')).toEqual([
      'ADR-0002 <-supersedes- ADR-0003',
      'ADR-0002 <-supersedes- ADR-0003 <-supersedes- ADR-0004',
    ]);
  });

  it('reports a path once, however many relations join its nodes', () => {
    const { graph } = analyseSources([
      { path: 'docs/adr/0001-a.md', text: '---\nstatus: accepted\ndepends-on: ADR-0002\nassumes: ADR-0002\n---\n\n# A\n' },
      { path: 'docs/adr/0002-b.md', text: '---\nstatus: accepted\n---\n\n# B\n' },
    ]);
    expect(graph.out('ADR-0001', ['depends-on', 'assumes'])).toHaveLength(2);
    expect(query(graph, 'document[id=ADR-0001] --> document').map((m) => m.nodes[1]?.id)).toEqual(['ADR-0002']);
  });

  it('tells two paths apart by their nodes, not by their ids run together', () => {
    // `a` then `bc`, and `ab` then `c`: the same letters, two different paths.
    const doc = (name: string, dependsOn?: string): Source => ({
      path: `docs/notes/${name}.md`,
      text: `---\nstatus: accepted\n${dependsOn ? `depends-on: ${dependsOn}\n` : ''}---\n\n# ${name}\n`,
    });
    const { graph } = analyseSources([doc('a', 'bc'), doc('bc', 'x'), doc('ab', 'c'), doc('c', 'x'), doc('x')]);
    const paths = query(graph, '* -depends-on-> * -depends-on-> document[id=x]').map((m) => m.nodes.map((n) => n.id).join(' > '));
    expect(paths.sort()).toEqual(['a > bc > x', 'ab > c > x']);
  });

  it('walks backwards transitively by the shortest path, and reports each edge of it', () => {
    // A reaches D directly and by way of B and C; the direct route is the one.
    const doc = (name: string, dependsOn: string[] = []): Source => ({
      path: `docs/adr/000${name}.md`,
      text: `---\nstatus: accepted\n${dependsOn.length > 0 ? `depends-on: [${dependsOn.join(', ')}]\n` : ''}---\n\n# ${name}\n`,
    });
    const { graph } = analyseSources([doc('1', ['ADR-0002', 'ADR-0004']), doc('2', ['ADR-0003']), doc('3', ['ADR-0004']), doc('4')]);
    const found = query(graph, 'document[id=ADR-0004] <=depends-on= document');
    const hops = Object.fromEntries(found.map((m) => [m.nodes[1]?.id, m.edges.map((e) => `${e.from}>${e.to}`)]));
    expect(hops).toEqual({
      'ADR-0001': ['ADR-0001>ADR-0004'],
      'ADR-0003': ['ADR-0003>ADR-0004'],
      'ADR-0002': ['ADR-0003>ADR-0004', 'ADR-0002>ADR-0003'],
    });
  });

  it('comes back round to where it started on a cycle, by the shortest way, in either direction', () => {
    // P and Q depend on each other; P, R and S go round a longer loop.
    const doc = (name: string, dependsOn: string[]): Source => ({
      path: `docs/notes/${name}.md`,
      text: `---\nstatus: accepted\ndepends-on: [${dependsOn.join(', ')}]\n---\n\n# ${name}\n`,
    });
    const { graph } = analyseSources([doc('p', ['q', 'r']), doc('q', ['p']), doc('r', ['s']), doc('s', ['p'])]);
    const back = (selector: string): string[] | undefined =>
      query(graph, selector)
        .find((m) => m.nodes[1]?.id === 'p')
        ?.edges.map((e) => `${e.from}>${e.to}`);
    expect(back('document[id=p] =depends-on=> document')).toEqual(['p>q', 'q>p']);
    expect(back('document[id=p] <=depends-on= document')).toEqual(['p>q', 'q>p'].reverse());
  });
});

describe('reflexive edges', () => {
  const selfLinking = () =>
    analyseSources([
      {
        path: 'docs/adr/0001-a.md',
        text: ['---', 'status: accepted', '---', '', '# A', '', 'Depends on [ADR-0001](0001-a.md).'].join('\n'),
      },
    ]).graph;

  it('are excluded from traversal by default', () => {
    // A document that links to itself is a formatting quirk. Traversing it
    // would turn every table of contents into a relationship.
    expect(query(selfLinking(), 'document -depends-on-> document')).toHaveLength(0);
  });

  it('can be opted into', () => {
    const found = execute(selfLinking(), parseQuery('document -depends-on-> document'), { allowReflexive: true });
    expect(found).toHaveLength(1);
  });

  it('are excluded from a transitive step that never leaves the document, and only from that', () => {
    // An obligation handed to its own document goes nowhere. Handed on from
    // there to another document, it has left, and that path is a relationship.
    const { graph } = analyseSources([
      {
        path: 'docs/adr/0001-a.md',
        text: [
          '---',
          'status: accepted',
          'depends-on: ADR-0002',
          '---',
          '',
          '# A',
          '',
          '## Open Questions',
          '',
          '- [ ] Which policy? Deferred to [ADR-0001](0001-a.md).',
        ].join('\n'),
      },
      { path: 'docs/adr/0002-b.md', text: '---\nstatus: accepted\n---\n\n# B\n' },
    ]);
    const reached = (options: { allowReflexive?: boolean }): string[] =>
      execute(graph, parseQuery('item =delegates-to,depends-on=> document'), options)
        .map((m) => m.nodes[1]?.id ?? '')
        .sort();
    expect(reached({})).toEqual(['ADR-0002']);
    expect(reached({ allowReflexive: true })).toEqual(['ADR-0001', 'ADR-0002']);
  });
});
