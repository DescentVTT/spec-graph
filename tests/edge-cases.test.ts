import { describe, expect, it } from 'vitest';

import { scanMarkdown } from '../src/markdown.js';
import { analyseSources, type Source } from '../src/runner.js';
import { DEFAULT_SEVERITIES, resolveStrict, RULE_IDS, sortDiagnostics } from '../src/rules.js';
import type { Diagnostic, RuleId, Severity, SourceRef } from '../src/types.js';

/**
 * Behaviours the design claims but that the happy-path suite never exercises.
 *
 * Each of these was picked out of the surviving-mutant list: a branch the code
 * takes a position on, that no assertion was holding down.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

const rules = (files: Record<string, string>): RuleId[] => analyse(files).diagnostics.map((d) => d.rule);

/* -------------------------------------------------------------------------- */
/* Report ordering                                                            */
/* -------------------------------------------------------------------------- */

function diagnostic(
  overrides: { severity?: Severity; file?: string; line?: number; column?: number; rule?: RuleId; message?: string },
): Diagnostic {
  const at: SourceRef = {
    file: overrides.file ?? 'a.md',
    span: {
      start: { offset: 0, line: overrides.line ?? 1, column: overrides.column ?? 1 },
      end: { offset: 0, line: overrides.line ?? 1, column: overrides.column ?? 1 },
    },
  };
  return {
    rule: overrides.rule ?? 'ghost-handover',
    severity: (overrides.severity ?? 'error') as Exclude<Severity, 'off'>,
    message: overrides.message ?? 'm',
    at,
    nodes: [],
    related: [],
    hint: 'h',
  };
}

describe('report ordering is total', () => {
  // Output that reorders between runs cannot be diffed, and output that cannot
  // be diffed stops being read. Every tier of the comparator matters.
  it('orders by severity first', () => {
    const sorted = sortDiagnostics([
      diagnostic({ severity: 'info' }),
      diagnostic({ severity: 'error' }),
      diagnostic({ severity: 'warn' }),
    ]);
    expect(sorted.map((d) => d.severity)).toEqual(['error', 'warn', 'info']);
  });

  it('then by file', () => {
    const sorted = sortDiagnostics([diagnostic({ file: 'b.md' }), diagnostic({ file: 'a.md' })]);
    expect(sorted.map((d) => d.at.file)).toEqual(['a.md', 'b.md']);
  });

  it('then by line', () => {
    const sorted = sortDiagnostics([diagnostic({ line: 9 }), diagnostic({ line: 2 })]);
    expect(sorted.map((d) => d.at.span.start.line)).toEqual([2, 9]);
  });

  it('then by column', () => {
    const sorted = sortDiagnostics([diagnostic({ column: 40 }), diagnostic({ column: 4 })]);
    expect(sorted.map((d) => d.at.span.start.column)).toEqual([4, 40]);
  });

  it('then by rule name', () => {
    const sorted = sortDiagnostics([
      diagnostic({ rule: 'stale-premise' }),
      diagnostic({ rule: 'broken-reference' }),
    ]);
    expect(sorted.map((d) => d.rule)).toEqual(['broken-reference', 'stale-premise']);
  });

  it('and finally by message, so identical positions never swap', () => {
    const sorted = sortDiagnostics([diagnostic({ message: 'zebra' }), diagnostic({ message: 'aardvark' })]);
    expect(sorted.map((d) => d.message)).toEqual(['aardvark', 'zebra']);
    // Equal in every tier: the sort must be stable, not arbitrary.
    const same = sortDiagnostics([diagnostic({}), diagnostic({})]);
    expect(same).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* How far a governing verb reaches                                           */
/* -------------------------------------------------------------------------- */

describe('verb governance', () => {
  const retired = { 'docs/adr/0002-old.md': '---\nstatus: archived\n---\n\n# Old\n' };

  it('does not reach across a table cell edge', () => {
    // A table row is a list of independent fields. Found on a real index of
    // archived documents whose previous row ended "...before assuming the
    // drift was fixed": every following row's link became an `assumes` edge,
    // and so every archived document it listed became a stale premise.
    const { diagnostics } = analyse({
      ...retired,
      'docs/adr/0003-index.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# Index',
        '',
        '| Ref | Note |',
        '| :-- | :--- |',
        '| a | read the banner before assuming the drift was fixed |',
        '| [ADR-0002](0002-old.md) | executed |',
      ].join('\n'),
    });
    expect(diagnostics.map((d) => d.rule)).not.toContain('stale-premise');
  });

  it('does not reach across a row boundary either', () => {
    const { diagnostics } = analyse({
      ...retired,
      'docs/adr/0003-index.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# Index',
        '',
        '| a | assuming the drift was fixed |',
        '| [ADR-0002](0002-old.md) | executed |',
      ].join('\n'),
    });
    expect(diagnostics.map((d) => d.rule)).not.toContain('stale-premise');
  });

  it('still governs a reference in its own cell', () => {
    // The fix must not cost the legitimate case: a verb and the link it governs
    // inside one cell are still one statement.
    const { graph } = analyse({
      ...retired,
      'docs/adr/0003-index.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# Index',
        '',
        '| Ref | Note |',
        '| :-- | :--- |',
        '| a | assuming [ADR-0002](0002-old.md) still holds |',
      ].join('\n'),
    });
    expect(graph.out('ADR-0003', ['assumes']).map((e) => e.to)).toEqual(['ADR-0002']);
  });

  it('is cancelled by a negation between the verb and the reference', () => {
    // "Owned by nobody today and disclaimed by [138]" was read as a delegation
    // *to* 138. An inference that inverts its own source is worse than none.
    const { diagnostics, graph } = analyse({
      ...retired,
      'docs/adr/0003-c.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# C',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns this? Owned by nobody today and disclaimed by [ADR-0002](0002-old.md).',
      ].join('\n'),
    });
    expect(diagnostics.map((d) => d.rule)).not.toContain('ghost-handover');
    expect(graph.edges.filter((e) => e.kind === 'delegates-to')).toEqual([]);
  });

  it('still governs when nothing negates it', () => {
    const { graph } = analyse({
      ...retired,
      'docs/adr/0003-c.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# C',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns this? Owned by [ADR-0002](0002-old.md).',
      ].join('\n'),
    });
    expect(graph.edges.some((e) => e.kind === 'delegates-to' && e.to === 'ADR-0002')).toBe(true);
  });

  it('lets a wrapped sentence keep governing across a line break', () => {
    // The cell edge is a boundary; an ordinary newline inside a wrapped item is
    // not, or every multi-line obligation would lose its verb.
    const { diagnostics } = analyse({
      ...retired,
      'docs/adr/0003-c.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# C',
        '',
        '## Open Questions',
        '',
        '- [ ] Which policy applies once the migration completes? This is',
        '      deferred to',
        '      [ADR-0002](0002-old.md) for now.',
      ].join('\n'),
    });
    expect(diagnostics.map((d) => d.rule)).toContain('ghost-handover');
  });
});

/* -------------------------------------------------------------------------- */
/* A document that declares itself history                                    */
/* -------------------------------------------------------------------------- */

describe('historical documents', () => {
  const files = {
    'archive/0108-front-door.md': '# Front door\n',
    'JOURNAL.md': '# Journal\n\nIt shipped because [108](archive/0108-front-door.md) ran that day.\n',
  };

  it('rest on archived decisions, and say so only in prose', () => {
    // A journal citing an archived brief is a historical record, not a stale
    // premise - but with no declared status the document is `unknown`, and a
    // banner reading "THIS IS HISTORY" is exactly the kind of claim no machine
    // can check. That is the problem this project exists for.
    expect(rules(files)).toContain('stale-premise');
  });

  it('go quiet once the banner is a field the tool can read', () => {
    const marked = {
      ...files,
      'JOURNAL.md': `---\nstatus: historical\n---\n\n${files['JOURNAL.md']}`,
    };
    expect(analyse(marked).diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Cycle detection, both modes                                                */
/* -------------------------------------------------------------------------- */

describe('cycle detection', () => {
  const pingPong = analyse({
    'docs/adr/0001-a.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# A',
      '',
      '## Open Questions',
      '',
      '- [ ] Who owns retention? Deferred to [ADR-0002](0002-b.md).',
    ].join('\n'),
    'docs/adr/0002-b.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# B',
      '',
      '## Open Questions',
      '',
      '- [ ] Who owns retention? Deferred to [ADR-0001](0001-a.md).',
    ].join('\n'),
  }).graph;

  const direct = analyse({
    'docs/adr/0001-a.md': '---\nstatus: accepted\ndelegates-to: ADR-0002\n---\n\n# A\n',
    'docs/adr/0002-b.md': '---\nstatus: accepted\ndelegates-to: ADR-0001\n---\n\n# B\n',
  }).graph;

  it('finds a document-to-document cycle in the raw graph', () => {
    expect(direct.cycles(['delegates-to']).map((c) => [...c].sort())).toEqual([['ADR-0001', 'ADR-0002']]);
  });

  it('misses an item-to-document cycle in the raw graph, by construction', () => {
    // Each delegation runs item -> document, so there is genuinely no cycle
    // among the raw nodes. This is why the projected mode exists, and asserting
    // it keeps the two modes from quietly collapsing into one.
    expect(pingPong.cycles(['delegates-to'])).toEqual([]);
  });

  it('finds it once relations are projected onto their documents', () => {
    expect(pingPong.cycles(['delegates-to'], { byDocument: true }).map((c) => [...c].sort())).toEqual([
      ['ADR-0001', 'ADR-0002'],
    ]);
  });

  it('does not turn a relation that stays inside one document into a cycle', () => {
    const selfDelegating = analyse({
      'docs/adr/0001-a.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# A',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns this? Deferred to [ADR-0001](0001-a.md).',
      ].join('\n'),
    }).graph;
    expect(selfDelegating.cycles(['delegates-to'], { byDocument: true })).toEqual([]);
  });

  it('reports nothing for an acyclic chain in either mode', () => {
    const chain = analyse({
      'docs/adr/0001-a.md': '---\nstatus: accepted\ndelegates-to: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n',
    }).graph;
    expect(chain.cycles(['delegates-to'])).toEqual([]);
    expect(chain.cycles(['delegates-to'], { byDocument: true })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Strict severity resolution                                                 */
/* -------------------------------------------------------------------------- */

describe('strict severity resolution', () => {
  it('changes nothing when it is off', () => {
    expect(resolveStrict({}, false)).toEqual({ severities: {}, escalated: new Set() });
    expect(resolveStrict({ 'self-reference': 'off' }, false).severities).toEqual({ 'self-reference': 'off' });
  });

  it('raises every warn-by-default rule, and only those', () => {
    const { severities, escalated } = resolveStrict({}, true);
    const warnByDefault = RULE_IDS.filter((id) => DEFAULT_SEVERITIES[id] === 'warn');
    expect(warnByDefault.length).toBeGreaterThan(0);
    expect([...escalated].sort()).toEqual([...warnByDefault].sort());
    for (const id of warnByDefault) expect(severities[id], id).toBe('error');
  });

  it('leaves error and info rules alone', () => {
    // `info` is advisory by design - a self-link in a table of contents is a
    // formatting quirk - and promoting it would resurrect exactly the
    // false-positive problem ADR-0006 exists to prevent.
    const { severities, escalated } = resolveStrict({}, true);
    for (const id of RULE_IDS) {
      if (DEFAULT_SEVERITIES[id] === 'warn') continue;
      expect(severities[id], id).toBeUndefined();
      expect(escalated.has(id), id).toBe(false);
    }
  });

  it('lets an explicit override win, in both directions', () => {
    // Exempting one rule is what makes strict adoptable at all.
    const exempted = resolveStrict({ 'state-conflict': 'warn' }, true);
    expect(exempted.severities['state-conflict']).toBe('warn');
    expect(exempted.escalated.has('state-conflict')).toBe(false);

    // And an explicit promotion of a rule strict would not touch still applies.
    const promoted = resolveStrict({ 'self-reference': 'error' }, true);
    expect(promoted.severities['self-reference']).toBe('error');
    expect(promoted.escalated.has('self-reference')).toBe(false);
  });

  it('does not mutate the overrides it was given', () => {
    const overrides: Partial<Record<RuleId, Severity>> = { 'self-reference': 'off' };
    resolveStrict(overrides, true);
    expect(overrides).toEqual({ 'self-reference': 'off' });
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit edge directives                                                   */
/* -------------------------------------------------------------------------- */

describe('@spec-edge', () => {
  const other = { 'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n' };

  it('declares a relation pointing away from this document', () => {
    const { graph } = analyse({
      ...other,
      'docs/adr/0001-a.md': ['# A', '', '<!-- @spec-edge kind="depends-on" to="ADR-0002" -->'].join('\n'),
    });
    expect(graph.out('ADR-0001', ['depends-on']).map((e) => e.to)).toEqual(['ADR-0002']);
  });

  it('declares a relation pointing at this document', () => {
    // `from=` is how a document records that something else depends on it.
    const { graph } = analyse({
      ...other,
      'docs/adr/0001-a.md': ['# A', '', '<!-- @spec-edge kind="depends-on" from="ADR-0002" -->'].join('\n'),
    });
    expect(graph.in('ADR-0001', ['depends-on']).map((e) => e.from)).toEqual(['ADR-0002']);
  });

  it('is ignored when it names no kind', () => {
    const { graph } = analyse({
      ...other,
      'docs/adr/0001-a.md': ['# A', '', '<!-- @spec-edge to="ADR-0002" -->'].join('\n'),
    });
    expect(graph.out('ADR-0001').filter((e) => e.kind !== 'contains')).toHaveLength(0);
  });

  it('attaches to the item it sits inside, not to the document', () => {
    const { graph } = analyse({
      ...other,
      'docs/adr/0001-a.md': [
        '# A',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns this?',
        '      <!-- @spec-edge kind="delegates-to" to="ADR-0002" -->',
      ].join('\n'),
    });
    expect(graph.out('ADR-0001', ['delegates-to'])).toHaveLength(0);
    expect(graph.out('ADR-0001#open-questions.1', ['delegates-to']).map((e) => e.to)).toEqual(['ADR-0002']);
  });
});

/* -------------------------------------------------------------------------- */
/* Which bullets become obligations                                           */
/* -------------------------------------------------------------------------- */

describe('obligation promotion', () => {
  it('promotes only top-level bullets in an obligation section', () => {
    // A nested bullet is detail belonging to its parent. Promoting it would
    // double-count the question and inflate every open-obligation total.
    const { corpus } = analyse({
      'docs/adr/0001-a.md': [
        '# A',
        '',
        '## Open Questions',
        '',
        '- Which shard key?',
        '  - We considered tenant id',
        '  - We considered region',
        '- Which eviction policy?',
      ].join('\n'),
    });
    expect(corpus.items.map((i) => i.text)).toEqual(['Which shard key?', 'Which eviction policy?']);
  });

  it('promotes a nested bullet anyway when it carries its own checkbox', () => {
    const { corpus } = analyse({
      'docs/adr/0001-a.md': ['# A', '', '## Open Questions', '', '- Which shard key?', '  - [ ] Benchmark it'].join(
        '\n',
      ),
    });
    expect(corpus.items).toHaveLength(2);
  });

  it('quotes the obligation back as prose, not as Markdown source', () => {
    // A finding that echoes the item should read like the sentence the author
    // wrote. Link syntax in a report is noise the reader has to parse past.
    const { corpus } = analyse({
      'docs/adr/0002-b.md': '# B\n',
      'docs/adr/0001-a.md': [
        '# A',
        '',
        '## Open Questions',
        '',
        '- [ ] Which policy? Deferred to [ADR-0002](0002-b.md), and see [[0002-b|the notes]].',
      ].join('\n'),
    });
    expect(corpus.items[0]?.text).toBe('Which policy? Deferred to ADR-0002, and see the notes.');
  });

  it('truncates a very long obligation rather than flooding the report', () => {
    const { corpus } = analyse({
      'docs/adr/0001-a.md': ['# A', '', '## Open Questions', '', `- [ ] ${'word '.repeat(60)}`].join('\n'),
    });
    expect(corpus.items[0]?.text).toHaveLength(120);
    expect(corpus.items[0]?.text.endsWith('...')).toBe(true);
  });

  it('promotes nothing from an ordinary section', () => {
    const { corpus } = analyse({
      'docs/adr/0001-a.md': ['# A', '', '## Considered Options', '', '* PostgreSQL', '* MySQL'].join('\n'),
    });
    expect(corpus.items).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Reverse-verb classification                                                */
/* -------------------------------------------------------------------------- */

describe('a reference that is the subject of its sentence', () => {
  it('inverts a lifecycle relation', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': ['---', 'status: superseded', '---', '', '# A', '', '[ADR-0002](0002-b.md) supersedes this decision.'].join('\n'),
      'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n',
    });
    expect(graph.in('ADR-0001', ['supersedes']).map((e) => e.from)).toEqual(['ADR-0002']);
  });

  it('never inverts a premise relation', () => {
    // "[ADR-0002] assumes ..." would make ADR-0002 depend on this document,
    // which is the opposite of what the sentence says about the citing one.
    const { graph } = analyse({
      'docs/adr/0001-a.md': ['---', 'status: accepted', '---', '', '# A', '', '[ADR-0002](0002-b.md) assumes a single writer.'].join('\n'),
      'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n',
    });
    expect(graph.in('ADR-0001', ['assumes'])).toHaveLength(0);
    expect(graph.out('ADR-0001', ['references']).map((e) => e.to)).toEqual(['ADR-0002']);
  });
});

/* -------------------------------------------------------------------------- */
/* Scanner boundaries                                                         */
/* -------------------------------------------------------------------------- */

describe('fence boundaries', () => {
  it('is not closed by a fence of the other character', () => {
    const md = ['```', 'a [hidden](h.md)', '~~~', 'still code [also-hidden](h2.md)', '```', '[shown](s.md)'].join('\n');
    expect(scanMarkdown(md).links.map((l) => l.target)).toEqual(['s.md']);
  });

  it('is not closed by a fence carrying an info string', () => {
    const md = ['```', 'a [hidden](h.md)', '``` js', '[still-hidden](h2.md)', '```', '[shown](s.md)'].join('\n');
    expect(scanMarkdown(md).links.map((l) => l.target)).toEqual(['s.md']);
  });

  it('is not closed by a shorter run', () => {
    const md = ['````', '```', '[hidden](h.md)', '````', '[shown](s.md)'].join('\n');
    expect(scanMarkdown(md).links.map((l) => l.target)).toEqual(['s.md']);
  });
});

describe('block quotes', () => {
  it('reads a marker with no space after it', () => {
    expect(scanMarkdown('>- [ ] quoted').listItems.map((i) => i.firstLine)).toEqual(['quoted']);
  });

  it('reads nested quote markers', () => {
    expect(scanMarkdown('> > - [ ] deeply quoted').listItems.map((i) => i.firstLine)).toEqual(['deeply quoted']);
  });

  it('records the quote depth', () => {
    const doc = scanMarkdown('> quoted\n>> deeper\nplain');
    expect(doc.lines.map((l) => l.quoteDepth)).toEqual([1, 2, 0]);
  });
});

describe('thematic breaks', () => {
  it('end a list item', () => {
    const md = ['- An item', '', '---', '', 'Prose after the rule.'].join('\n');
    expect(scanMarkdown(md).listItems[0]?.body.trim()).toBe('An item');
  });

  it('are not setext underlines', () => {
    // `---` under a blank line is a rule; under a paragraph it is a heading.
    expect(scanMarkdown('Para\n\n---\n').headings).toHaveLength(0);
    expect(scanMarkdown('Para\n---\n').headings.map((h) => h.text)).toEqual(['Para']);
  });
});

/* -------------------------------------------------------------------------- */
/* Severity handling                                                          */
/* -------------------------------------------------------------------------- */

describe('severity overrides', () => {
  const files = {
    'docs/adr/0002-old.md': '---\nstatus: archived\n---\n\n# Old\n\n## Open Questions\n\n- [ ] Who owns this?\n',
  };

  it('turning a rule off removes its findings entirely', () => {
    expect(rules(files)).toContain('orphaned-obligation');
    const quiet = analyseSources(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { severities: { 'orphaned-obligation': 'off' } },
    );
    expect(quiet.diagnostics.map((d) => d.rule)).not.toContain('orphaned-obligation');
  });

  it('downgrading a rule keeps the finding but changes its severity', () => {
    const soft = analyseSources(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { severities: { 'orphaned-obligation': 'info' } },
    );
    expect(soft.diagnostics.find((d) => d.rule === 'orphaned-obligation')?.severity).toBe('info');
  });

  it('caps the related locations attached to one finding', () => {
    const many = analyseSources(
      [
        {
          path: 'docs/adr/0002-old.md',
          text: [
            '---',
            'status: archived',
            '---',
            '',
            '# Old',
            '',
            '## Open Questions',
            '',
            ...Array.from({ length: 12 }, (_, i) => `- [ ] Question ${i + 1}?`),
          ].join('\n'),
        },
      ],
      { maxRelated: 3 },
    );
    const found = many.diagnostics.find((d) => d.rule === 'orphaned-obligation');
    expect(found?.message).toContain('12 open obligations');
    expect(found?.related).toHaveLength(3);
  });
});
