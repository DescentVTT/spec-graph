import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildGraph } from '../src/graph.js';
import { formatGraph } from '../src/report.js';
import { analyseSources, type Source } from '../src/runner.js';

/*
 * What `spec-graph graph` hands Graphviz, Mermaid and a downstream tool, and
 * what hiding items must keep. Every corpus is analysed inside its test, never
 * at collection time (ADR-0007).
 */

/**
 * One document for each phase a document can be drawn in, as the README names
 * them: a row of its lifecycle table each, with the first status word the row
 * lists; `archived`, which it says reads as a record; and a document with no
 * status, which it says becomes `unknown`.
 */
function phases(): (readonly [string, string, string | null])[] {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n');
  const header = readme.findIndex((line) => line.startsWith('| Phase | Recognised from |'));
  const rows: [string, string | null][] = [];
  for (const line of readme.slice(header + 2)) {
    const match = /^\| `([a-z]+)` \| `([a-z-]+)`/.exec(line);
    if (match === null) break;
    rows.push([match[1] as string, match[2] as string]);
  }
  expect(rows.map(([phase]) => phase)).toEqual(['draft', 'active', 'frozen', 'retired']);
  expect(readme.join('\n')).toContain('every spec-* tool reads it as a **record**');
  rows.push(['record', 'archived'], ['unknown', null]);
  return rows.map(([phase, status], index) => [`ADR-00${11 + index}`, phase, status] as const);
}

const phaseCorpus = (list: readonly (readonly [string, string, string | null])[]): Source[] =>
  list.map(([id, , status]) => ({
    path: `docs/adr/${id.slice(4)}-x.md`,
    text: status === null ? `# ${id}: X\n` : `---\nstatus: ${status}\n---\n\n# ${id}: X\n`,
  }));

/** Two open questions, one of them written with the characters a Mermaid label cannot hold. */
const QUESTIONS: Source[] = [
  {
    path: 'docs/adr/0001-a.md',
    text: [
      '---',
      'status: accepted',
      '---',
      '# ADR-0001: A',
      '',
      '## Open Questions',
      '',
      '- [ ] Is "eventual" C#sharp enough? Deferred to [ADR-0002](0002-b.md).',
      '- [ ] "Soon" enough? Deferred to [ADR-0002](0002-b.md).',
      '- [ ] Who decides? Deferred to [ADR-0001](0001-a.md).',
    ].join('\n'),
  },
  { path: 'docs/adr/0002-b.md', text: '---\nstatus: proposed\n---\n# ADR-0002: B\n' },
];

/** A document that depends on one item of another, by a directive naming the item. */
const ON_AN_ITEM: Source[] = [
  {
    path: 'docs/adr/0001-a.md',
    text: '---\nstatus: accepted\n---\n# ADR-0001: A\n\n<!-- @spec-edge kind="depends-on" to="ADR-0002#shard-key" -->\n',
  },
  {
    path: 'docs/adr/0002-b.md',
    text: '---\nstatus: proposed\n---\n# ADR-0002: B\n\n## Open Questions\n\n<!-- @spec-item id="shard-key" -->\n- [ ] Which key? Deferred to [ADR-0001](0001-a.md).\n',
  },
];

interface Exported {
  nodes: { id: string; kind: string }[];
  edges: { kind: string; from: string; to: string }[];
}

const fills = (dot: string): Map<string, string> =>
  new Map([...dot.matchAll(/^ {2}"([^"]+)" \[.*fillcolor="([^"]*)"/gm)].map((match) => [match[1] as string, match[2] as string]));

describe('the Graphviz export', () => {
  it('gives each phase a colour of its own, so a retired document with arrows into it stands out', () => {
    const list = phases();
    const { graph } = analyseSources(phaseCorpus(list));
    for (const [id, phase] of list) expect(graph.document(id)?.phase, id).toBe(phase);
    const fill = fills(formatGraph(graph, 'dot'));
    const colours = list.map(([id]) => fill.get(id) as string);
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(colours).size).toBe(list.length);
  });

  it('fills its nodes, without which Graphviz draws no fill colour at all, and lays the graph out as Mermaid does', () => {
    const { graph } = analyseSources(phaseCorpus(phases()));
    const dot = formatGraph(graph, 'dot');
    expect(dot).toMatch(/^ {2}node \[[^\]]*style="[^"]*\bfilled\b[^"]*"/m);
    // Left to right in both, so the same corpus reads the same way in either.
    expect(dot).toMatch(/^ {2}rankdir=LR;$/m);
    expect(formatGraph(graph, 'mermaid').split('\n')[0]).toBe('graph LR');
  });

  it('labels an item with its words, in a colour no document is drawn in', () => {
    const { graph } = analyseSources([...phaseCorpus(phases()), ...QUESTIONS]);
    const dot = formatGraph(graph, 'dot');
    const question = graph.items.find((item) => item.text.startsWith('Who decides?'));
    expect(question).toBeDefined();
    const line = dot.split('\n').find((candidate) => candidate.startsWith(`  "${question?.id}" [`)) as string;
    expect(line).toContain(`[label="${question?.text}"`);
    const fill = fills(dot);
    const item = fill.get(question?.id as string) as string;
    expect(item).toMatch(/^#[0-9a-f]{6}$/);
    for (const document of graph.documents) expect(fill.get(document.id), document.id).not.toBe(item);
  });

  it('keeps every node on one line of the file, even one whose title holds a line break', () => {
    // A graph is public API, so a title is whatever its builder put there.
    // Graphviz reads `\n` inside a label as a line break in the drawing.
    const { graph } = analyseSources([{ path: 'docs/adr/0001-a.md', text: '# ADR-0001: A\n' }]);
    const document = graph.document('ADR-0001');
    expect(document).toBeDefined();
    const titled = buildGraph({ nodes: new Map([['ADR-0001', { ...document!, title: 'first\nsecond' }]]), edges: [] });
    const lines = formatGraph(titled, 'dot').split('\n');
    expect(lines).toContain('  "ADR-0001" [label="ADR-0001\\nfirst\\nsecond", fillcolor="#ffffff", shape=box];');
  });
});

describe('the Mermaid export', () => {
  it('puts each document in the class of its phase, and defines exactly those classes', () => {
    const list = phases();
    const { graph } = analyseSources([...phaseCorpus(list), ...QUESTIONS]);
    const lines = formatGraph(graph, 'mermaid').split('\n');
    const alias = new Map([...graph.nodes.keys()].map((id, index) => [id, `n${index}`]));
    const classes = new Map(
      lines.flatMap((line) => {
        const match = /^ {2}class (n\d+) (\S+);$/.exec(line);
        return match ? [[match[1] as string, match[2] as string]] : [];
      }),
    );
    for (const [id, phase] of list) {
      expect(classes.get(alias.get(id) as string), id).toBe(phase === 'unknown' ? undefined : phase);
    }
    // An item is not in a lifecycle, and neither is a document nobody could place.
    for (const item of graph.items) expect(classes.has(alias.get(item.id) as string), item.id).toBe(false);

    const defined = lines.flatMap((line) => {
      const match = /^ {2}classDef (\S+) fill:(#[0-9a-f]{6}),/.exec(line);
      return match ? [match[1] as string] : [];
    });
    expect(defined.sort()).toEqual(list.flatMap(([, phase]) => (phase === 'unknown' ? [] : [phase])).sort());
  });

  it('draws an item in its own shape, labelled with its words', () => {
    const { graph } = analyseSources(QUESTIONS);
    const lines = formatGraph(graph, 'mermaid').split('\n');
    const alias = new Map([...graph.nodes.keys()].map((id, index) => [id, `n${index}`]));
    expect(lines).toContain(`  ${alias.get('ADR-0002')}["ADR-0002"]`);
    const question = graph.items.find((item) => item.text.startsWith('Who decides?'));
    expect(lines).toContain(`  ${alias.get(question?.id as string)}(["${question?.text}"])`);
  });

  it('keeps a label to the words a Mermaid label can hold, one space between each', () => {
    // A quote would end the label and a hash starts an entity, so both become
    // a space - and a space, not nothing, so the words either side stay two.
    const { graph } = analyseSources(QUESTIONS);
    const lines = formatGraph(graph, 'mermaid').split('\n');
    expect(lines.some((line) => line.endsWith('(["Is eventual C sharp enough? Deferred to ADR-0002."])'))).toBe(true);
    expect(lines.some((line) => line.endsWith('(["Soon enough? Deferred to ADR-0002."])'))).toBe(true);
  });

  it('draws every relation as an arrow labelled with its kind, one statement to a line', () => {
    const { graph } = analyseSources(QUESTIONS);
    const lines = formatGraph(graph, 'mermaid').split('\n');
    const alias = new Map([...graph.nodes.keys()].map((id, index) => [id, `n${index}`]));
    expect(graph.edges.length).toBeGreaterThan(3);
    const arrows = lines.filter((line) => line.includes('-->'));
    expect(arrows).toEqual(graph.edges.map((edge) => `  ${alias.get(edge.from)} -->|${edge.kind}| ${alias.get(edge.to)}`));
  });
});

describe('the export with items hidden', () => {
  it('draws no document pointing at itself, though an item may hand work to its own document', () => {
    const { graph } = analyseSources(QUESTIONS);
    const full = JSON.parse(formatGraph(graph, 'json')) as Exported;
    const owners = new Map(graph.items.map((item) => [item.id, item.document]));
    expect(full.edges.some((edge) => edge.kind === 'delegates-to' && owners.get(edge.from) === edge.to)).toBe(true);
    const hidden = JSON.parse(formatGraph(graph, 'json', { documentsOnly: true })) as Exported;
    expect(hidden.edges.length).toBeGreaterThan(0);
    for (const edge of hidden.edges) expect(edge.from, JSON.stringify(edge)).not.toBe(edge.to);
  });

  it('draws one relation where several items make the same one', () => {
    const { graph } = analyseSources(QUESTIONS);
    const hidden = JSON.parse(formatGraph(graph, 'json', { documentsOnly: true })) as Exported;
    expect(hidden.edges.filter((edge) => edge.kind === 'delegates-to')).toEqual([
      expect.objectContaining({ kind: 'delegates-to', from: 'ADR-0001', to: 'ADR-0002' }),
    ]);
  });

  it('lifts a relation that ends on an item onto the document holding it', () => {
    const { graph } = analyseSources(ON_AN_ITEM);
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'depends-on', from: 'ADR-0001', to: 'ADR-0002#shard-key' }));
    const hidden = JSON.parse(formatGraph(graph, 'json', { documentsOnly: true })) as Exported;
    expect(hidden.edges).toContainEqual(expect.objectContaining({ kind: 'depends-on', from: 'ADR-0001', to: 'ADR-0002' }));
  });

  it('hides an item whose document the graph does not hold, rather than drawing it bare', () => {
    // A caller can build a graph of some documents and not others. An item
    // whose document was left out has nowhere to be lifted to, and an arrow to
    // it would make Graphviz draw an undeclared node in a documents-only view.
    const { graph } = analyseSources(ON_AN_ITEM);
    const partial = buildGraph({ nodes: new Map([...graph.nodes].filter(([id]) => id !== 'ADR-0002')), edges: graph.edges });
    expect(partial.edges.some((edge) => edge.from === 'ADR-0002#shard-key')).toBe(true);
    expect(partial.edges.some((edge) => edge.to === 'ADR-0002#shard-key')).toBe(true);
    const hidden = JSON.parse(formatGraph(partial, 'json', { documentsOnly: true })) as Exported;
    expect(hidden.nodes.map((node) => node.id)).toEqual(['ADR-0001']);
    expect(hidden.edges).toEqual([]);
    expect(formatGraph(partial, 'dot', { documentsOnly: true })).not.toContain('shard-key');
  });
});
