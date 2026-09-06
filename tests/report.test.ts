import { describe, expect, it } from 'vitest';

import { buildGraph } from '../src/graph.js';
import {
  createPainter,
  formatGraph,
  formatJson,
  formatReport,
  shouldUseAscii,
  shouldUseColor,
} from '../src/report.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { AnalysisResult } from '../src/runner.js';

const SOURCES: Source[] = [
  { path: 'docs/adr/0002-old.md', text: '---\nstatus: superseded by ADR-0003\n---\n\n# Old\n' },
  { path: 'docs/adr/0003-new.md', text: '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n' },
  {
    path: 'docs/adr/0004-cache.md',
    text: [
      '---',
      'status: accepted',
      '---',
      '',
      '# Cache',
      '',
      '## Open Questions',
      '',
      '- [ ] Eviction policy? Deferred to [ADR-0002](0002-old.md).',
    ].join('\n'),
  },
];

/** Wraps the pure engine output in the shape the reporters expect. */
function result(sources: Source[] = SOURCES): AnalysisResult {
  const { graph, corpus, diagnostics } = analyseSources(sources);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return {
    graph,
    corpus,
    diagnostics,
    problems: corpus.problems,
    files: sources.map((s) => s.path),
    summary: {
      documents: corpus.documents.length,
      items: corpus.items.length,
      edges: graph.edges.length,
      openObligations: corpus.items.filter((i) => i.openness !== 'closed').length,
      errors: counts.error,
      warnings: counts.warn,
      infos: counts.info,
      durationMs: 1,
    },
    ok: counts.error === 0,
  };
}

/* -------------------------------------------------------------------------- */

describe('colour detection', () => {
  it('honours NO_COLOR above everything else', () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(false);
  });

  it('honours FORCE_COLOR even without a TTY', () => {
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '0' } })).toBe(false);
  });

  it('stays plain for a dumb terminal and in CI', () => {
    expect(shouldUseColor({ isTTY: true, env: { TERM: 'dumb' } })).toBe(false);
    expect(shouldUseColor({ isTTY: true, env: { CI: 'true' } })).toBe(false);
  });

  it('falls back to whether a TTY is attached', () => {
    expect(shouldUseColor({ isTTY: true, env: {} })).toBe(true);
    expect(shouldUseColor({ isTTY: false, env: {} })).toBe(false);
    expect(shouldUseColor({ env: {} })).toBe(false);
  });

  it('honours an explicit ASCII request', () => {
    expect(shouldUseAscii({ env: { SPEC_GRAPH_ASCII: '1' } })).toBe(true);
    expect(shouldUseAscii({ env: { SPEC_GRAPH_ASCII: '' } })).toBe(process.platform === 'win32');
  });
});

describe('painter', () => {
  it('emits escape codes only when colour is on', () => {
    expect(createPainter(true).error('x')).toBe('[31mx[0m');
    expect(createPainter(false).error('x')).toBe('x');
  });

  it('gives every severity a distinct colour', () => {
    const paint = createPainter(true);
    const codes = [paint.error('x'), paint.warn('x'), paint.info('x')];
    expect(new Set(codes).size).toBe(3);
  });
});

describe('human report', () => {
  it('leads with a summary and ends with a verdict', () => {
    const text = formatReport(result(), { ascii: true });
    expect(text).toContain('spec-graph');
    expect(text).toContain('3 documents');
    expect(text).toContain('the specification graph is inconsistent');
  });

  it('shows the location, the message, the evidence and the fix', () => {
    const text = formatReport(result(), { ascii: true });
    expect(text).toContain('docs/adr/0004-cache.md:9:');
    expect(text).toContain('ghost-handover');
    expect(text).toContain('which is retired');
    // The hint is what makes a finding actionable.
    expect(text).toContain('re-home this in a live document');
  });

  it('reports success when there is nothing to report', () => {
    const clean = formatReport(result([{ path: 'docs/adr/0001-a.md', text: '# A\n' }]), { ascii: true });
    expect(clean).toContain('the specification graph is consistent');
    expect(clean).not.toContain('inconsistent');
  });

  it('caps the findings shown and says how many were hidden', () => {
    const many = result([
      ...SOURCES,
      { path: 'docs/adr/0005-x.md', text: '# X\n\nSee [ADR-0099](0099-missing.md).\n' },
    ]);
    expect(many.diagnostics.length).toBeGreaterThan(1);
    const text = formatReport(many, { ascii: true, max: 1 });
    expect(text).toContain(`... and ${many.diagnostics.length - 1} more`);
  });

  it('degrades to ASCII glyphs when asked', () => {
    const ascii = formatReport(result(), { ascii: true });
    const unicode = formatReport(result(), { ascii: false });
    expect(ascii).not.toMatch(/[✖⚠↳→]/);
    expect(unicode).toMatch(/[✖↳→]/);
  });

  it('colours the output only when asked', () => {
    expect(formatReport(result(), { color: true })).toContain('[');
    expect(formatReport(result(), { color: false })).not.toContain('[');
  });

  it('lists parse problems only in verbose mode', () => {
    const withProblem = result([
      { path: 'docs/adr/0001-a.md', text: '<!-- @spec-node id="ADR-0001" colour="red" -->\n\n# A\n' },
    ]);
    expect(formatReport(withProblem, { ascii: true, verbose: true })).toContain('unknown attribute "colour"');
    expect(formatReport(withProblem, { ascii: true, verbose: false })).not.toContain('unknown attribute');
  });

  it('pluralises counts correctly', () => {
    const one = formatReport(result([{ path: 'docs/adr/0001-a.md', text: '# A\n' }]), { ascii: true });
    expect(one).toContain('1 document');
    expect(one).not.toContain('1 documents');
  });
});

describe('json report', () => {
  it('is versioned, and carries positions for every finding', () => {
    const parsed: {
      version: number;
      ok: boolean;
      diagnostics: { line: number; endLine: number; related: { line: number }[] }[];
    } = JSON.parse(formatJson(result()));
    expect(parsed.version).toBe(1);
    expect(parsed.ok).toBe(false);
    for (const diagnostic of parsed.diagnostics) {
      expect(diagnostic.line).toBeGreaterThan(0);
      expect(diagnostic.endLine).toBeGreaterThanOrEqual(diagnostic.line);
    }
  });

  it('ends with a newline so it concatenates cleanly', () => {
    expect(formatJson(result()).endsWith('\n')).toBe(true);
  });
});

describe('graph export', () => {
  const { graph } = analyseSources(SOURCES);

  it('emits valid Graphviz with a node per document', () => {
    const dot = formatGraph(graph, 'dot');
    expect(dot).toContain('digraph spec {');
    expect(dot.trimEnd().endsWith('}')).toBe(true);
    expect(dot).toContain('"ADR-0002"');
    expect(dot).toContain('-> "ADR-0002" [label="supersedes"]');
  });

  it('colours documents by phase', () => {
    const dot = formatGraph(graph, 'dot');
    // Retired and active must not look the same.
    expect(dot).toMatch(/"ADR-0002".*fillcolor="#fce8e6"/);
    expect(dot).toMatch(/"ADR-0003".*fillcolor="#e6f4ea"/);
  });

  it('emits Mermaid with safe identifiers', () => {
    const mermaid = formatGraph(graph, 'mermaid');
    expect(mermaid).toMatch(/^graph LR/);
    expect(mermaid).toContain('classDef retired');
    // Mermaid ids must not be the document ids, which contain hyphens and hashes.
    expect(mermaid).toMatch(/n\d+\["ADR-0002"\]/);
  });

  it('escapes quotes so a title cannot break the output', () => {
    const quoted = analyseSources([
      { path: 'docs/adr/0001-a.md', text: '---\ntitle: A "quoted" title\n---\n\n# A\n' },
    ]).graph;
    expect(formatGraph(quoted, 'dot')).toContain('\\"quoted\\"');
    expect(formatGraph(quoted, 'mermaid')).not.toContain('"quoted"');
  });

  it('emits JSON with declaration sites intact', () => {
    const parsed: { nodes: unknown[]; edges: { declaredIn: string[] }[] } = JSON.parse(formatGraph(graph, 'json'));
    expect(parsed.nodes.length).toBe(graph.nodes.size);
    expect(parsed.edges.every((edge) => edge.declaredIn.length > 0)).toBe(true);
  });

  it('handles an empty graph', () => {
    const empty = buildGraph({ nodes: new Map(), edges: [] });
    expect(formatGraph(empty, 'dot')).toContain('digraph spec {');
    expect(formatGraph(empty, 'mermaid')).toMatch(/^graph LR/);
    expect(JSON.parse(formatGraph(empty, 'json')).nodes).toEqual([]);
  });
});
