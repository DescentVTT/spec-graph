import { describe, expect, it } from 'vitest';

import { applyBaseline, BASELINE_VERSION, formatBaseline, parseBaseline, type Baseline } from '../src/baseline.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * Accepted debt, and the ratchet.
 *
 * The property that matters is not that a baseline suppresses findings - any
 * filter does that. It is that the same finding is still the same finding
 * tomorrow, after somebody reformats a paragraph, moves a section into its own
 * file, or renames the file it lives in. See ADR-0012.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

const LIVE = ['# ADR-0003: Cache', '', '## Status', '', 'accepted', '', 'This depends on ADR-0002.', ''].join('\n');
const RETIRED = ['# ADR-0002: Sharding', '', '## Status', '', 'retired', ''].join('\n');
const BROKEN = ['# ADR-0004: Plans', '', '## Status', '', 'accepted', '', 'See [the plan](docs/plans/x.md).', ''].join('\n');

const CORPUS = {
  'docs/adr/0002-sharding.md': RETIRED,
  'docs/adr/0003-cache.md': LIVE,
  'docs/adr/0004-plans.md': BROKEN,
};

const recorded = (files: Record<string, string>): Baseline => {
  const { graph, diagnostics } = analyse(files);
  return JSON.parse(formatBaseline(graph, diagnostics)) as Baseline;
};

describe('recording what is already wrong', () => {
  it('names the specification and the citation, never the line', () => {
    expect(recorded(CORPUS).findings).toEqual([
      { rule: 'broken-reference', document: 'ADR-0004', subject: 'docs/plans/x.md', count: 1 },
      { rule: 'stale-premise', document: 'ADR-0003', subject: 'ADR-0002', count: 1 },
    ]);
  });

  it('is byte-identical for identical input', () => {
    // It lands in a repository and is read in diffs. A generated timestamp
    // would make every re-record a change even when nothing changed.
    const { graph, diagnostics } = analyse(CORPUS);
    expect(formatBaseline(graph, diagnostics)).toBe(formatBaseline(graph, diagnostics));
    expect(formatBaseline(graph, diagnostics).endsWith('\n')).toBe(true);
  });

  it('sorts, so two machines produce the same file', () => {
    const forward = recorded(CORPUS).findings.map((entry) => `${entry.rule} ${entry.document} ${entry.subject}`);
    expect(forward).toEqual([...forward].sort());
  });

  it('counts repeats rather than inventing a discriminator for them', () => {
    const twice = {
      ...CORPUS,
      'docs/adr/0004-plans.md': BROKEN.replace('See [the plan](docs/plans/x.md).', 'See [one](docs/plans/x.md) and [two](docs/plans/x.md).'),
    };
    const entry = recorded(twice).findings.find((row) => row.rule === 'broken-reference');
    expect(entry?.count).toBe(2);
  });
});

describe('the fingerprint outlives ordinary edits', () => {
  const baseline = recorded(CORPUS);
  const clean = (files: Record<string, string>): number => {
    const { graph, diagnostics } = analyse(files);
    return applyBaseline(graph, diagnostics, baseline).kept.length;
  };

  it('survives lines inserted above the finding', () => {
    const padded = { ...CORPUS, 'docs/adr/0003-cache.md': LIVE.replace('## Status', `${'filler\n'.repeat(40)}\n## Status`) };
    expect(clean(padded)).toBe(0);
  });

  it('survives the file being renamed', () => {
    // The identifier is the decision's name, not its location. That is what
    // ADR-0009 made true, and this is what it buys.
    const moved = {
      'docs/adr/0002-sharding.md': RETIRED,
      'docs/decisions/cache.md': ['# ADR-0003: Cache', '', '## Status', '', 'accepted', '', 'This depends on ADR-0002.'].join('\n'),
      'docs/adr/0004-plans.md': BROKEN,
    };
    expect(clean(moved)).toBe(0);
  });

  it('does not survive a genuinely new finding', () => {
    const worse = { ...CORPUS, 'docs/adr/0005-new.md': ['# ADR-0005: New', '', '## Status', '', 'accepted', '', 'See [gone](docs/nope.md).'].join('\n') };
    const { graph, diagnostics } = analyse(worse);
    const outcome = applyBaseline(graph, diagnostics, baseline);
    expect(outcome.kept.map((finding) => finding.target)).toEqual(['docs/nope.md']);
    expect(outcome.suppressed).toBe(2);
  });

  it('reports one when three exist and two were accepted', () => {
    const three = {
      'docs/adr/0004-plans.md': BROKEN.replace(
        'See [the plan](docs/plans/x.md).',
        'See [a](docs/plans/x.md), [b](docs/plans/x.md) and [c](docs/plans/x.md).',
      ),
    };
    const allowTwo: Baseline = {
      version: BASELINE_VERSION,
      findings: [{ rule: 'broken-reference', document: 'ADR-0004', subject: 'docs/plans/x.md', count: 2 }],
    };
    const { graph, diagnostics } = analyse(three);
    const outcome = applyBaseline(graph, diagnostics, allowTwo);
    expect(outcome.suppressed).toBe(2);
    expect(outcome.kept).toHaveLength(1);
  });
});

describe('the ratchet', () => {
  it('reports debt that has been paid', () => {
    const baseline = recorded(CORPUS);
    const fixed = { ...CORPUS, 'docs/adr/0004-plans.md': BROKEN.replace('See [the plan](docs/plans/x.md).', 'Nothing to see.') };
    const { graph, diagnostics } = analyse(fixed);
    const outcome = applyBaseline(graph, diagnostics, baseline);
    expect(outcome.stale).toEqual([
      { rule: 'broken-reference', document: 'ADR-0004', subject: 'docs/plans/x.md', count: 1 },
    ]);
  });

  it('reports a partial payment as the part that is left over', () => {
    const allowThree: Baseline = {
      version: BASELINE_VERSION,
      findings: [{ rule: 'broken-reference', document: 'ADR-0004', subject: 'docs/plans/x.md', count: 3 }],
    };
    const { graph, diagnostics } = analyse({ 'docs/adr/0004-plans.md': BROKEN });
    expect(applyBaseline(graph, diagnostics, allowThree).stale[0]?.count).toBe(2);
  });

  it('says nothing when the debt is exactly as recorded', () => {
    const baseline = recorded(CORPUS);
    const { graph, diagnostics } = analyse(CORPUS);
    expect(applyBaseline(graph, diagnostics, baseline).stale).toEqual([]);
  });
});

describe('reading a baseline file', () => {
  const parse = (text: string) => parseBaseline(text, 'b.json');

  it('round-trips what it wrote', () => {
    const { graph, diagnostics } = analyse(CORPUS);
    const text = formatBaseline(graph, diagnostics);
    expect(parse(text).problems).toEqual([]);
    expect(parse(text).baseline.findings).toHaveLength(2);
  });

  it('reads a file a Windows editor saved with a byte-order mark', () => {
    const marked = String.fromCharCode(0xfeff) + JSON.stringify({ version: BASELINE_VERSION, findings: [] });
    expect(parse(marked).problems).toEqual([]);
  });

  it('accepts nothing rather than guessing, and says why', () => {
    // A baseline nobody can read is worse than none: it would suppress findings
    // the reader cannot account for.
    expect(parse('{').baseline.findings).toEqual([]);
    expect(parse('{').problems[0]).toContain('not valid JSON');
    expect(parse('[]').problems[0]).toContain('must contain a JSON object');
    expect(parse(JSON.stringify({ version: 99, findings: [] })).problems[0]).toContain('version 99');
    expect(parse(JSON.stringify({ version: BASELINE_VERSION, findings: {} })).problems[0]).toContain('must be an array');
  });

  it('drops an unusable row and keeps the rest', () => {
    const mixed = JSON.stringify({
      version: BASELINE_VERSION,
      findings: [
        { rule: 'not-a-rule', document: 'ADR-0001', subject: '' },
        { rule: 'broken-reference', document: 'ADR-0004', subject: 'x', count: 0 },
        { rule: 'broken-reference', document: 'ADR-0004', subject: 'x' },
      ],
    });
    const parsed = parse(mixed);
    expect(parsed.baseline.findings).toHaveLength(1);
    expect(parsed.baseline.findings[0]?.count).toBe(1);
    expect(parsed.problems).toHaveLength(2);
  });
});

describe('a document-level rule', () => {
  it('does not repeat the document as its own subject', () => {
    // orphaned-obligation lists the document's own open items as the rest of
    // `nodes`, so the other end resolves back to where it started. Writing it
    // twice would invite a reader to look for a distinction that is not there.
    const files = {
      'docs/adr/0002-sharding.md': ['---', 'status: retired', '---', '', '# ADR-0002: Sharding', '', '- [ ] never closed'].join('\n'),
    };
    const { graph, diagnostics } = analyse(files);
    expect(diagnostics.map((finding) => finding.rule)).toContain('orphaned-obligation');
    expect((JSON.parse(formatBaseline(graph, diagnostics)) as Baseline).findings).toEqual([
      { rule: 'orphaned-obligation', document: 'ADR-0002', subject: '', count: 1 },
    ]);
  });
});
