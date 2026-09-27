import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildGraph, LOAD_BEARING_EDGES, OBLIGATION_EDGES } from '../src/graph.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * What the graph keeps, the cycles it finds, and which relations carry which
 * property.
 *
 * `cycles` is Tarjan's search, written iteratively, and each of its cases is a
 * shape of corpus: a loop the search enters part-way along, a relation into a
 * document it has already finished with, a document that delegates to itself.
 * A search that gets one of them wrong still finds the plain two-document loop
 * the other tests use.
 */

/** An accepted decision, delegating to the documents named. */
const decision = (number: string, ...delegates: string[]): Source => ({
  path: `docs/adr/${number}-x.md`,
  text: [
    '---',
    'status: accepted',
    ...(delegates.length > 0 ? [`delegates-to: [${delegates.map((to) => `ADR-${to}`).join(', ')}]`] : []),
    '---',
    '',
    `# ADR-${number}: X`,
    '',
  ].join('\n'),
});

const graphOf = (...sources: Source[]) => analyseSources(sources).graph;

/** Each cycle's members in order, so a test does not depend on where the search entered. */
const members = (cycles: readonly (readonly string[])[]): string[][] => cycles.map((cycle) => [...cycle].sort());

describe('cycles', () => {
  it('finds a loop the search entered part-way along', () => {
    // ADR-0001 leads into the loop and is not in it.
    const graph = graphOf(decision('0001', '0002'), decision('0002', '0003'), decision('0003', '0002'));
    expect(members(graph.cycles(['delegates-to']))).toEqual([['ADR-0002', 'ADR-0003']]);
  });

  it('is not misled by a relation into a document the search has finished with', () => {
    // ADR-0002 is searched, and settled on its own, before the loop between
    // ADR-0003 and ADR-0004 is reached; ADR-0004 also delegates to it.
    const graph = graphOf(decision('0001', '0002'), decision('0002'), decision('0003', '0004'), decision('0004', '0003', '0002'));
    expect(members(graph.cycles(['delegates-to']))).toEqual([['ADR-0003', 'ADR-0004']]);
  });

  it('counts a document that delegates to itself as a loop of one, once', () => {
    // Reached first from ADR-0001, and then again as a starting point of its own.
    const graph = graphOf(decision('0001', '0002'), decision('0002', '0002'));
    expect(graph.cycles(['delegates-to'])).toEqual([['ADR-0002']]);
    // Projected onto documents, a relation that stays inside one is no loop.
    expect(graph.cycles(['delegates-to'], { byDocument: true })).toEqual([]);
  });
});

describe('a graph built from some documents and not others', () => {
  it('keeps no relation that names a node it does not hold, at either end', () => {
    const { nodes, edges } = graphOf(decision('0001', '0002'), decision('0002'), decision('0003', '0001'));
    expect(edges.map((edge) => `${edge.from} ${edge.to}`)).toEqual(['ADR-0001 ADR-0002', 'ADR-0003 ADR-0001']);
    const partial = buildGraph({
      nodes: new Map([...nodes].filter(([id]) => id === 'ADR-0001')),
      edges,
    });
    expect(partial.edges).toEqual([]);
    expect(partial.out('ADR-0001')).toEqual([]);
    expect(partial.in('ADR-0001')).toEqual([]);
  });

  it("projects cycles past an item whose document it does not hold", () => {
    // An item left without its document stands for itself in the projection,
    // rather than taking the search down with it.
    const question = (own: string, other: string): Source => ({
      path: `docs/adr/${own}-x.md`,
      text: ['---', 'status: accepted', '---', '', `# ADR-${own}: X`, '', '## Open Questions', '', `- [ ] Who owns retention? Deferred to [ADR-${other}](${other}-x.md).`, ''].join('\n'),
    });
    const { nodes, edges } = graphOf(question('0001', '0002'), question('0002', '0001'));
    expect(members(buildGraph({ nodes, edges }).cycles(['delegates-to'], { byDocument: true }))).toEqual([['ADR-0001', 'ADR-0002']]);

    const partial = buildGraph({ nodes: new Map([...nodes].filter(([id]) => id !== 'ADR-0002')), edges });
    const orphan = [...partial.nodes.keys()].find((id) => id.startsWith('ADR-0002#'));
    expect(orphan).toBeDefined();
    expect(partial.owningDocument(orphan as string)).toBeUndefined();
    expect(partial.cycles(['delegates-to'], { byDocument: true })).toEqual([]);
  });
});

describe('the relation properties the README names', () => {
  // "`loadBearing` relations (...) make the source's validity depend on the
  // target", and "`transfersObligation` relations (...) move work". The
  // exported lists are those, read out of the README rather than restated.
  const README = (): string => readFileSync('README.md', 'utf8');
  const named = (property: string): string[] => {
    const listed = new RegExp(`\`${property}\` relations \\(([^)]*)\\)`).exec(README())?.[1];
    expect(listed, property).toBeDefined();
    return [...(listed as string).matchAll(/`([a-z-]+)`/g)].map((match) => match[1] as string).sort();
  };

  it('are the ones LOAD_BEARING_EDGES and OBLIGATION_EDGES hold', () => {
    expect([...LOAD_BEARING_EDGES].sort()).toEqual(named('loadBearing'));
    expect([...OBLIGATION_EDGES].sort()).toEqual(named('transfersObligation'));
    expect(named('loadBearing').length).toBeGreaterThan(0);
  });
});
