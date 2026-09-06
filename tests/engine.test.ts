import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';
import { query } from '../src/select.js';
import type { Diagnostic, RuleId } from '../src/types.js';

/** Builds a corpus from `path -> text` pairs. */
function corpus(files: Record<string, string>): Source[] {
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}

function analyse(files: Record<string, string>) {
  return analyseSources(corpus(files));
}

const rules = (diagnostics: readonly Diagnostic[]): RuleId[] => diagnostics.map((d) => d.rule);
const only = (diagnostics: readonly Diagnostic[], rule: RuleId): Diagnostic[] =>
  diagnostics.filter((d) => d.rule === rule);

/* -------------------------------------------------------------------------- */

describe('document identity', () => {
  it('derives an id from the file name and the enclosing family directory', () => {
    const { graph } = analyse({
      'docs/adr/0007-sharding.md': '# Sharding\n',
      'docs/rfcs/0007-transport.md': '# Transport\n',
    });
    expect([...graph.nodes.keys()].sort()).toEqual(['ADR-0007', 'RFC-0007']);
  });

  it('prefers an explicit front-matter id', () => {
    const { graph } = analyse({ 'docs/adr/whatever.md': '---\nid: ADR-0042\n---\n\n# Title\n' });
    expect(graph.document('ADR-0042')).toBeDefined();
  });

  it('preserves the zero-padding the repository already uses', () => {
    const { graph } = analyse({ 'docs/adr/0007-x.md': '# x\n' });
    expect(graph.document('ADR-0007')).toBeDefined();
    expect(graph.document('ADR-7')).toBeUndefined();
  });

  it('resolves a citation written in any spelling', () => {
    const { graph } = analyse({
      'docs/adr/0007-sharding.md': '# Sharding\n',
      'docs/adr/0008-cache.md': [
        '# Cache',
        '',
        'See [ADR-0007](0007-sharding.md), [adr-7](../adr/0007-sharding.md) and [[0007-sharding]].',
      ].join('\n'),
    });
    const edges = graph.out('ADR-0008').filter((edge) => edge.to === 'ADR-0007');
    expect(edges.length).toBeGreaterThan(0);
  });

  it('refuses to resolve a bare number across families', () => {
    // `0007` inside an RFC means RFC-0007, never ADR-0007. Guessing here would
    // silently wire two unrelated documents together.
    const { graph, corpus: resolved } = analyse({
      'docs/adr/0007-sharding.md': '# Sharding\n',
      'docs/rfcs/0001-intro.md': '# Intro\n\nSee 0007 for details.\n',
    });
    expect(graph.out('RFC-0001').map((e) => e.to)).not.toContain('ADR-0007');
    expect(resolved.dangling).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('normalises vocabularies from different ecosystems onto one lattice', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: accepted\n---\n\n# A\n',
      'docs/keps/0002-b.md': '---\nstatus: implementable\n---\n\n# B\n',
      'docs/rfcs/0003-c.md': '---\nstatus: Final\n---\n\n# C\n',
      'docs/adr/0004-d.md': '---\nstatus: Superseded by ADR-0001\n---\n\n# D\n',
      'docs/adr/0005-e.md': '---\nstatus: Proposed\n---\n\n# E\n',
      'docs/adr/0006-f.md': '# F\n',
    });
    expect(graph.document('ADR-0001')?.phase).toBe('active');
    expect(graph.document('KEP-0002')?.phase).toBe('active');
    expect(graph.document('RFC-0003')?.phase).toBe('frozen');
    expect(graph.document('ADR-0004')?.phase).toBe('retired');
    expect(graph.document('ADR-0005')?.phase).toBe('draft');
    expect(graph.document('ADR-0006')?.phase).toBe('unknown');
  });

  it('reads a status written as a section instead of front matter', () => {
    const { graph } = analyse({ 'docs/adr/0001-a.md': '# A\n\n## Status\n\nAccepted\n\n## Context\n' });
    expect(graph.document('ADR-0001')?.phase).toBe('active');
  });

  it('reads a status decorated with emphasis, a badge or a date', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '# A\n\n## Status\n\n**Accepted** (2026-03-01) ✅\n',
    });
    expect(graph.document('ADR-0001')?.phase).toBe('active');
  });

  it('retires everything in an archive directory even without a status', () => {
    const { graph } = analyse({ 'docs/adr/archive/0001-a.md': '# A\n' });
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
  });

  it('lets a terminal word win over an earlier one in the same status', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: Accepted, later superseded by ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n',
    });
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
  });
});

describe('ghost handovers', () => {
  const files = {
    'docs/adr/0002-storage.md': ['---', 'status: Superseded by ADR-0007', '---', '', '# Storage'].join('\n'),
    'docs/adr/0007-storage-v2.md': ['---', 'status: accepted', 'supersedes: ADR-0002', '---', '', '# Storage v2'].join(
      '\n',
    ),
    'docs/adr/0004-cache.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# Cache',
      '',
      '## Open Questions',
      '',
      '- [ ] Which eviction policy do we use? Deferred to [ADR-0002](0002-storage.md).',
    ].join('\n'),
  };

  it('catches an open obligation delegated into a retired document', () => {
    const { diagnostics } = analyse(files);
    const found = only(diagnostics, 'ghost-handover');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('ADR-0002');
    expect(found[0]?.message).toContain('retired');
    expect(found[0]?.at.file).toBe('docs/adr/0004-cache.md');
    expect(found[0]?.severity).toBe('error');
  });

  it('points at the line that declares the delegation', () => {
    const { diagnostics } = analyse(files);
    expect(only(diagnostics, 'ghost-handover')[0]?.at.span.start.line).toBe(9);
  });

  it('stays quiet when the target is still live', () => {
    const live = { ...files };
    live['docs/adr/0002-storage.md'] = '---\nstatus: accepted\n---\n\n# Storage';
    const { diagnostics } = analyse(live);
    expect(rules(diagnostics)).not.toContain('ghost-handover');
  });

  it('stays quiet when the obligation is already closed', () => {
    const closed = { ...files };
    closed['docs/adr/0004-cache.md'] = files['docs/adr/0004-cache.md'].replace('- [ ]', '- [x]');
    expect(rules(analyse(closed).diagnostics)).not.toContain('ghost-handover');
  });

  it('stays quiet when the delegating document is itself retired', () => {
    // History delegating to history is a record, not a defect.
    const archived = { ...files };
    archived['docs/adr/0004-cache.md'] = files['docs/adr/0004-cache.md'].replace(
      'status: accepted',
      'status: superseded by ADR-0007',
    );
    expect(rules(analyse(archived).diagnostics)).not.toContain('ghost-handover');
  });

  it('catches a delegation into a frozen document too', () => {
    const frozen = { ...files };
    frozen['docs/adr/0002-storage.md'] = '---\nstatus: final\n---\n\n# Storage';
    const found = only(analyse(frozen).diagnostics, 'ghost-handover');
    expect(found[0]?.message).toContain('frozen');
  });

  it('does not fire on a neutral citation', () => {
    const neutral = { ...files };
    neutral['docs/adr/0004-cache.md'] = files['docs/adr/0004-cache.md'].replace(
      'Deferred to [ADR-0002](0002-storage.md).',
      'Background is in [ADR-0002](0002-storage.md).',
    );
    expect(rules(analyse(neutral).diagnostics)).not.toContain('ghost-handover');
  });
});

describe('stale premises', () => {
  const files = {
    'docs/adr/0002-rows.md': '---\nstatus: superseded by ADR-0009\n---\n\n# Row limits\n',
    'docs/adr/0009-rows-v2.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# Row limits v2\n',
    'docs/adr/0005-export.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# Export',
      '',
      'The chunking scheme is constrained by [ADR-0002](0002-rows.md), which caps rows at 4 KB.',
    ].join('\n'),
  };

  it('catches a live document resting on a retired decision', () => {
    const found = only(analyse(files).diagnostics, 'stale-premise');
    expect(found).toHaveLength(1);
    expect(found[0]?.nodes).toContain('ADR-0002');
    expect(found[0]?.at.file).toBe('docs/adr/0005-export.md');
  });

  it('ignores a non-load-bearing citation of the same document', () => {
    const weak = { ...files };
    weak['docs/adr/0005-export.md'] = [
      '---',
      'status: accepted',
      '---',
      '',
      '# Export',
      '',
      '## See also',
      '',
      '- [ADR-0002](0002-rows.md)',
    ].join('\n');
    expect(rules(analyse(weak).diagnostics)).not.toContain('stale-premise');
  });

  it('catches a dependency on a question that was obviated', () => {
    const files2 = {
      'docs/adr/0002-rows.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# Row limits',
        '',
        '## Open Questions',
        '',
        '<!-- @spec-item id="row-cap" -->',
        '- [ ] Do we need a 4 KB row cap? **Moot** - the engine removed the limit in v9.',
      ].join('\n'),
      'docs/adr/0005-export.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# Export',
        '',
        'Chunking assumes [the row cap](0002-rows.md#row-cap) still applies.',
      ].join('\n'),
    };
    const found = only(analyse(files2).diagnostics, 'stale-premise');
    expect(found).toHaveLength(1);
    expect(found[0]?.nodes).toContain('ADR-0002#row-cap');
  });
});

describe('reference integrity', () => {
  it('reports a link to a document that does not exist', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '# A\n\nSee [ADR-0099](0099-missing.md).\n',
    });
    const found = only(diagnostics, 'broken-reference');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('0099-missing.md');
  });

  it('reports a bare identifier whose family exists but whose number does not', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '# A\n\nAs decided in ADR-0099, we shard early.\n',
    });
    expect(rules(diagnostics)).toContain('broken-reference');
  });

  it('says nothing about a token that merely looks like an identifier', () => {
    // The corpus has no `SHA` family, so `SHA-256` is a sentence, not a citation.
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '# A\n\nWe hash with SHA-256 over UTF-8 on port 8080, per RFC-9999.\n',
    });
    expect(rules(diagnostics)).not.toContain('broken-reference');
  });

  it('never harvests a reference out of a URL', () => {
    const { corpus: resolved } = analyse({
      'docs/adr/0001-a.md': '# A\n\nBackground: <https://example.com/adr-0099/notes>.\n',
    });
    expect(resolved.dangling).toHaveLength(0);
  });

  it('reports an anchor that does not exist', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '# A\n\n## Decision\n',
      'docs/adr/0002-b.md': '# B\n\nSee [the decision](0001-a.md#nonexistent).\n',
    });
    const found = only(diagnostics, 'broken-reference');
    expect(found[0]?.message).toContain('anchor');
  });

  it('accepts an anchor that names a heading', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '# A\n\n## Decision\n',
      'docs/adr/0002-b.md': '# B\n\nSee [the decision](0001-a.md#decision).\n',
    });
    expect(rules(diagnostics)).not.toContain('broken-reference');
  });

  it('reports an ambiguous citation rather than picking a winner', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-sharding.md': '---\naliases: [sharding]\n---\n\n# One\n',
      'docs/adr/0002-sharding-v2.md': '---\naliases: [sharding]\n---\n\n# Two\n',
      'docs/adr/0003-c.md': '# Three\n\nWe follow [[sharding]].\n',
    });
    const found = only(diagnostics, 'ambiguous-reference');
    expect(found).toHaveLength(1);
    expect(found[0]?.hint).toContain('ADR-0001');
    expect(found[0]?.hint).toContain('ADR-0002');
  });

  it('ignores links inside code samples', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': ['# A', '', '```md', 'See [ADR-0099](0099-missing.md).', '```'].join('\n'),
    });
    expect(diagnostics).toHaveLength(0);
  });
});

describe('orphaned obligations', () => {
  it('reports open work stranded in a retired document', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': [
        '---',
        'status: superseded by ADR-0003',
        '---',
        '',
        '# Old',
        '',
        '## Open Questions',
        '',
        '- [ ] Do we still need the shim?',
        '- [ ] Who owns the migration?',
        '- [x] Is the index needed? Yes.',
      ].join('\n'),
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    const found = only(diagnostics, 'orphaned-obligation');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('2 open obligations');
    expect(found[0]?.related).toHaveLength(2);
  });

  it('says nothing when every obligation in the retired document is closed', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': [
        '---',
        'status: superseded by ADR-0003',
        '---',
        '',
        '# Old',
        '',
        '## Open Questions',
        '',
        '- [x] Do we still need the shim? No.',
      ].join('\n'),
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    expect(rules(diagnostics)).not.toContain('orphaned-obligation');
  });
});

describe('supersession consistency', () => {
  it('reports a superseded document that still reads as current', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': '---\nstatus: accepted\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    const found = only(diagnostics, 'live-supersession');
    expect(found).toHaveLength(1);
    // The fix belongs in the superseded document, so that is where it points.
    expect(found[0]?.at.file).toBe('docs/adr/0002-old.md');
  });

  it('reports a retired document that never says what replaced it', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': '---\nstatus: archived\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    const found = only(diagnostics, 'unreciprocated-supersession');
    expect(found).toHaveLength(1);
    expect(found[0]?.hint).toContain('superseded-by: ADR-0003');
  });

  it('stays quiet when both documents record the relationship', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': '---\nstatus: superseded\nsuperseded-by: ADR-0003\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    expect(rules(diagnostics)).not.toContain('unreciprocated-supersession');
    expect(rules(diagnostics)).not.toContain('live-supersession');
  });
});

describe('cycles', () => {
  it('finds a circular delegation', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: accepted\ndelegates-to: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: accepted\ndelegates-to: ADR-0003\n---\n\n# B\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\ndelegates-to: ADR-0001\n---\n\n# C\n',
    });
    const found = only(diagnostics, 'circular-delegation');
    expect(found).toHaveLength(1);
    expect(found[0]?.nodes.sort()).toEqual(['ADR-0001', 'ADR-0002', 'ADR-0003']);
  });

  it('finds a supersession cycle and names it as one', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: superseded\nsupersedes: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: superseded\nsupersedes: ADR-0001\n---\n\n# B\n',
    });
    const found = only(diagnostics, 'circular-delegation');
    expect(found[0]?.message).toContain('supersession cycle');
  });

  it('does not mistake a chain for a cycle', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: accepted\ndelegates-to: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: accepted\ndelegates-to: ADR-0003\n---\n\n# B\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\n---\n\n# C\n',
    });
    expect(rules(diagnostics)).not.toContain('circular-delegation');
  });
});

describe('self references', () => {
  it('reports a document that delegates to itself', () => {
    const { diagnostics } = analyse({
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
    });
    const found = only(diagnostics, 'self-reference');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('info');
  });

  it('does not treat a self-link as a ghost handover', () => {
    // A self-matching link target is a formatting quirk, not a handover into a
    // sealed document, and conflating the two produces a confident wrong answer.
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': [
        '---',
        'status: superseded by ADR-0002',
        '---',
        '',
        '# A',
        '',
        'Superseded by [ADR-0001](0001-a.md).',
      ].join('\n'),
      'docs/adr/0002-b.md': '---\nstatus: accepted\n---\n\n# B\n',
    });
    expect(rules(diagnostics)).not.toContain('ghost-handover');
  });
});

describe('item state conflicts', () => {
  it('reports a checkbox that disagrees with its own body', () => {
    const { diagnostics } = analyse({
      'docs/adr/0001-a.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# A',
        '',
        '## Open Questions',
        '',
        '- [ ] Should we shard the write path',
        '      before the migration lands?',
        '      **Resolved (2026-03):** no, one node holds three years of growth.',
      ].join('\n'),
    });
    const found = only(diagnostics, 'state-conflict');
    expect(found).toHaveLength(1);
    expect(found[0]?.hint).toContain('closed');
  });
});

describe('multiline pathologies', () => {
  it('reads a delegation split across wrapped lines', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-old.md': '---\nstatus: archived\n---\n\n# Old\n',
      'docs/adr/0004-new.md': [
        '---',
        'status: accepted',
        '---',
        '',
        '# New',
        '',
        '## Open Questions',
        '',
        '- [ ] Which eviction policy should the cache use once the',
        '      migration completes? This is deferred to',
        '      [ADR-0002](0002-old.md) for now.',
      ].join('\n'),
    });
    expect(rules(diagnostics)).toContain('ghost-handover');
  });

  it('keeps an item and its neighbour apart', () => {
    const { corpus: resolved } = analyse({
      'docs/adr/0001-a.md': [
        '# A',
        '',
        '## Open Questions',
        '',
        '- [ ] First question',
        '      wrapped onto a second line.',
        '- [x] Second question. Answered.',
      ].join('\n'),
    });
    expect(resolved.items).toHaveLength(2);
    expect(resolved.items[0]?.openness).toBe('open');
    expect(resolved.items[1]?.openness).toBe('closed');
  });
});

describe('the query language', () => {
  const files = {
    'docs/adr/0002-old.md': '---\nstatus: superseded by ADR-0003\n---\n\n# Old\n',
    'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    'docs/adr/0004-cache.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# Cache',
      '',
      '## Open Questions',
      '',
      '- [ ] Eviction policy? Deferred to [ADR-0002](0002-old.md).',
      '- [x] Cache size? Fixed at 2 GB.',
    ].join('\n'),
  };

  it('answers the ghost-handover question directly', () => {
    const { graph } = analyse(files);
    const matches = query(graph, 'item[openness=open] -delegates-to-> document[phase=retired]');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.nodes.map((n) => n.id)).toEqual(['ADR-0004#open-questions.1', 'ADR-0002']);
  });

  it('filters on document attributes', () => {
    const { graph } = analyse(files);
    expect(query(graph, 'document[phase=accepted]')).toHaveLength(0);
    expect(query(graph, 'document[phase=active]')).toHaveLength(2);
    expect(query(graph, '*[path^=docs/adr]')).not.toHaveLength(0);
  });

  it('lets an item inherit its document phase', () => {
    const { graph } = analyse(files);
    expect(query(graph, 'item[phase=active]')).toHaveLength(2);
  });

  it('walks relations backwards', () => {
    const { graph } = analyse(files);
    const matches = query(graph, 'document[phase=retired] <-supersedes- document');
    expect(matches[0]?.nodes.map((n) => n.id)).toEqual(['ADR-0002', 'ADR-0003']);
  });

  it('walks relations transitively', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: superseded\nsuperseded-by: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\nstatus: superseded\nsuperseded-by: ADR-0003\n---\n\n# B\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\n---\n\n# C\n',
    });
    const matches = query(graph, 'document[id=ADR-0003] =supersedes=> document');
    expect(matches.map((m) => m.nodes[m.nodes.length - 1]?.id).sort()).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('supports every comparison operator', () => {
    const { graph } = analyse(files);
    expect(query(graph, 'document[id^=ADR]')).toHaveLength(3);
    expect(query(graph, 'document[id$=0002]')).toHaveLength(1);
    expect(query(graph, 'document[title*=cache]')).toHaveLength(1);
    // A regex containing `]` has to be quoted, or it would close the predicate.
    expect(query(graph, 'document[id~="000[23]"]')).toHaveLength(2);
    expect(query(graph, 'document[id~=adr-000.]')).toHaveLength(3);
    expect(query(graph, 'document[phase!=retired]')).toHaveLength(2);
    expect(query(graph, 'document[status]')).toHaveLength(3);
  });

  it('reads front-matter fields', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': '---\nstatus: accepted\nowner: platform\n---\n\n# A\n',
    });
    expect(query(graph, 'document[fm.owner=platform]')).toHaveLength(1);
  });
});
