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
  it('treats an empty variable as unset, which is what the convention means', () => {
    // `NO_COLOR=` in a shell script is how a variable gets cleared. Reading it
    // as "set" would turn colour off for anyone who tried to turn it back on.
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '' } })).toBe(true);
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '' } })).toBe(false);
    expect(shouldUseColor({ isTTY: true, env: { CI: '' } })).toBe(true);
  });

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

  it('honours an explicit ASCII request whatever the platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(shouldUseAscii({ env: { SPEC_GRAPH_ASCII: '1' }, platform }), platform).toBe(true);
    }
  });

  it('treats an empty ASCII variable as unset', () => {
    expect(shouldUseAscii({ env: { SPEC_GRAPH_ASCII: '' }, platform: 'linux' })).toBe(false);
  });

  it('assumes a capable terminal everywhere but Windows', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      expect(shouldUseAscii({ env: {}, platform }), platform).toBe(false);
    }
  });

  it('degrades on Windows only for the legacy console', () => {
    // Windows Terminal and modern shells announce themselves; the old
    // conhost.exe does not, and it renders box-drawing as mojibake.
    expect(shouldUseAscii({ env: {}, platform: 'win32' })).toBe(true);
    expect(shouldUseAscii({ env: { WT_SESSION: 'x' }, platform: 'win32' })).toBe(false);
    expect(shouldUseAscii({ env: { TERM_PROGRAM: 'vscode' }, platform: 'win32' })).toBe(false);
    // Either marker is enough on its own.
    expect(shouldUseAscii({ env: { WT_SESSION: 'x', TERM_PROGRAM: 'vscode' }, platform: 'win32' })).toBe(false);
  });

  it('defaults to the real platform when none is given', () => {
    expect(shouldUseAscii({ env: {} })).toBe(process.platform === 'win32');
  });
});

const ROLES = ['error', 'warn', 'info', 'dim', 'bold', 'hint', 'location'] as const;

describe('painter', () => {
  it('emits escape codes only when colour is on', () => {
    expect(createPainter(true).error('x')).toBe('\u001b[31mx\u001b[0m');
    expect(createPainter(false).error('x')).toBe('x');
  });

  it('uses the conventional colour for each role', () => {
    // These are the SGR codes a reader's eye is trained on: red for an error,
    // yellow for a warning, cyan for a note, green for the way out.
    const paint = createPainter(true);
    const code = (painted: string): string => /\u001b\[(\d+)m/.exec(painted)?.[1] ?? '';
    expect(code(paint.error('x'))).toBe('31');
    expect(code(paint.warn('x'))).toBe('33');
    expect(code(paint.info('x'))).toBe('36');
    expect(code(paint.hint('x'))).toBe('32');
    expect(code(paint.dim('x'))).toBe('2');
    expect(code(paint.bold('x'))).toBe('1');
    expect(code(paint.location('x'))).toBe('4');
  });

  it('gives every role a distinct code, so none is silently the same as another', () => {
    const paint = createPainter(true);
    const painted = ROLES.map((role) => paint[role]('x'));
    expect(new Set(painted).size).toBe(ROLES.length);
  });

  it('always closes what it opens', () => {
    const paint = createPainter(true);
    for (const role of ROLES) expect(paint[role]('x'), role).toMatch(/^\u001b\[\d+mx\u001b\[0m$/);
  });

  it('passes text through untouched when colour is off', () => {
    const paint = createPainter(false);
    for (const role of ROLES) expect(paint[role]('unchanged'), role).toBe('unchanged');
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

describe('every severity reaches the report', () => {
  // A self-link is an `info`; an unacknowledged supersession is a `warn`. The
  // error path is exercised everywhere else, so between them all three
  // severities and all three glyphs are covered.
  const mixed = (): AnalysisResult =>
    result([
      { path: 'docs/adr/0001-old.md', text: '---\nstatus: archived\n---\n\n# Old\n' },
      {
        path: 'docs/adr/0002-new.md',
        text: [
          '---',
          'status: accepted',
          'supersedes: ADR-0001',
          '---',
          '',
          '# New',
          '',
          '## Open Questions',
          '',
          '- [ ] Who owns this? Deferred to [ADR-0002](0002-new.md).',
        ].join('\n'),
      },
    ]);

  it('marks a note distinctly from a warning and an error', () => {
    const text = formatReport(mixed(), { ascii: true });
    expect(text).toContain('self-reference');
    expect(text).toContain('unreciprocated-supersession');
    // ASCII glyphs: `i` for a note, `!` for a warning.
    expect(text).toMatch(/^i .*self-reference/m);
    expect(text).toMatch(/^! .*unreciprocated-supersession/m);
  });

  it('tallies notes alongside warnings', () => {
    const report = mixed();
    expect(report.summary.infos).toBeGreaterThan(0);
    const text = formatReport(report, { ascii: true });
    expect(text).toMatch(/\d+ notes?/);
    expect(text).toMatch(/\d+ warnings?/);
  });

  it('still passes the build, because neither is an error', () => {
    const report = mixed();
    expect(report.summary.errors).toBe(0);
    expect(formatReport(report, { ascii: true })).toContain('no errors - the specification graph holds');
  });

  it('uses a tick for success in unicode and a word in ASCII', () => {
    const clean = result([{ path: 'docs/adr/0001-a.md', text: '# A\n' }]);
    expect(formatReport(clean, { ascii: false })).toContain('\u2714');
    expect(formatReport(clean, { ascii: true })).toMatch(/^ok /m);
    expect(formatReport(clean, { ascii: true })).not.toContain('\u2714');
  });

  it('pluralises each tally on its own', () => {
    const one = mixed();
    const text = formatReport(one, { ascii: true });
    // One of each here: neither may be rendered as a plural.
    expect(text).toContain('1 warning ');
    expect(text).toContain('1 note');
    expect(text).not.toContain('1 warnings');
    expect(text).not.toContain('1 notes');
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

  it('carries parse problems, not only findings', () => {
    // A malformed directive is a problem with the input rather than a defect in
    // the graph, and a bot annotating a diff still needs to see it.
    const withProblem = result([
      { path: 'docs/adr/0001-a.md', text: '<!-- @spec-node id="ADR-0001" colour="red" -->\n\n# A\n' },
    ]);
    const parsed: { problems: { message: string; file: string; line: number }[] } = JSON.parse(
      formatJson(withProblem),
    );
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.message).toContain('colour');
    expect(parsed.problems[0]?.file).toBe('docs/adr/0001-a.md');
    expect(parsed.problems[0]?.line).toBeGreaterThan(0);
  });

  it('carries the related locations of each finding', () => {
    const parsed: { diagnostics: { related: { file: string; line: number; note: string }[] }[] } = JSON.parse(
      formatJson(result()),
    );
    const withRelated = parsed.diagnostics.find((d) => d.related.length > 0);
    expect(withRelated).toBeDefined();
    for (const entry of withRelated?.related ?? []) {
      expect(entry.file.length).toBeGreaterThan(0);
      expect(entry.line).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('lists the files it read', () => {
    const parsed: { files: string[] } = JSON.parse(formatJson(result()));
    expect(parsed.files).toEqual(SOURCES.map((s) => s.path));
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

  it('draws items differently from documents', () => {
    // An obligation is not a decision, and a reader scanning the graph should
    // not have to read the label to tell them apart.
    const dot = formatGraph(graph, 'dot');
    const item = dot.split('\n').find((line) => line.includes('#open-questions'));
    const document = dot.split('\n').find((line) => line.includes('"ADR-0003" ['));
    expect(item).toContain('shape=note');
    expect(document).toContain('shape=box');
    expect(item).not.toContain(document?.match(/fillcolor="(#[0-9a-f]+)"/)?.[1] ?? 'unreachable');
  });

  it('gives a document with no declared phase a neutral fill rather than none', () => {
    const unknown = analyseSources([{ path: 'docs/adr/0009-x.md', text: '# X\n' }]).graph;
    expect(formatGraph(unknown, 'dot')).toContain('fillcolor="#ffffff"');
  });

  it('draws contains edges differently from relations', () => {
    const dot = formatGraph(graph, 'dot');
    expect(dot).toMatch(/label="contains", style=dotted/);
    expect(dot).toMatch(/label="delegates-to"\]/);
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
