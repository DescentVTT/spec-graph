import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';
import { query } from '../src/select.js';
import type { AnyRuleId } from '../src/types.js';

/**
 * End-to-end checks against the shapes real open-source repositories use.
 *
 * The vocabulary tables are unit-tested elsewhere. What these assert is the
 * thing that actually decides whether spec-graph is droppable into a repository
 * nobody prepared for it: that a whole document written in each house style
 * yields the right identity, the right phase, the right obligations and - above
 * all - no findings that are not really there.
 */

const rules = (sources: Source[]): AnyRuleId[] => analyseSources(sources).diagnostics.map((d) => d.rule);

/* -------------------------------------------------------------------------- */
/* MADR                                                                       */
/* -------------------------------------------------------------------------- */

const MADR: Source[] = [
  {
    path: 'docs/decisions/0001-use-postgresql.md',
    text: [
      '---',
      'status: "superseded by ADR-0003"',
      'date: 2026-01-14',
      'deciders: [alice, bob]',
      'consulted: [carol]',
      'informed: []',
      '---',
      '',
      '# Use PostgreSQL for primary storage',
      '',
      '## Context and Problem Statement',
      '',
      'We need a primary datastore. Which one?',
      '',
      '## Decision Drivers',
      '',
      '* Operational familiarity',
      '* Transactional guarantees',
      '',
      '## Considered Options',
      '',
      '* PostgreSQL',
      '* MySQL',
      '* DynamoDB',
      '',
      '## Decision Outcome',
      '',
      'Chosen option: "PostgreSQL", because the team already runs it.',
      '',
      '### Consequences',
      '',
      '* Good, because one fewer technology to learn.',
      '* Bad, because horizontal scaling is harder.',
      '',
      '## More Information',
      '',
      'See [ADR-0002](0002-connection-pooling.md).',
    ].join('\n'),
  },
  {
    path: 'docs/decisions/0002-connection-pooling.md',
    text: [
      '---',
      'status: accepted',
      'date: 2026-02-01',
      '---',
      '',
      '# Pool connections with PgBouncer',
      '',
      '## Context and Problem Statement',
      '',
      'Connection churn is expensive.',
      '',
      '## Decision Outcome',
      '',
      'Chosen option: "PgBouncer in transaction mode".',
    ].join('\n'),
  },
  {
    path: 'docs/decisions/0003-distributed-storage.md',
    text: [
      '---',
      'status: accepted',
      'date: 2026-06-01',
      '---',
      '',
      '# Move to distributed storage',
      '',
      '## Context and Problem Statement',
      '',
      'PostgreSQL stopped scaling. This supersedes [ADR-0001](0001-use-postgresql.md).',
      '',
      '## Decision Outcome',
      '',
      'Chosen option: "CockroachDB".',
    ].join('\n'),
  },
];

describe('MADR', () => {
  const { graph, diagnostics } = analyseSources(MADR);

  it('identifies decisions from a decisions/ directory', () => {
    expect([...graph.nodes.keys()].filter((id) => id.startsWith('ADR')).sort()).toEqual([
      'ADR-0001',
      'ADR-0002',
      'ADR-0003',
    ]);
  });

  it('reads the MADR status vocabulary, quoted values included', () => {
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
    expect(graph.document('ADR-0002')?.phase).toBe('active');
    expect(graph.document('ADR-0003')?.phase).toBe('active');
  });

  it('records the supersession from both the status field and the prose', () => {
    const edges = graph.in('ADR-0001', ['supersedes']);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe('ADR-0003');
    expect([...(edges[0]?.declaredIn ?? [])].sort()).toEqual([
      'docs/decisions/0001-use-postgresql.md',
      'docs/decisions/0003-distributed-storage.md',
    ]);
  });

  it('does not mistake Decision Drivers or Considered Options for obligations', () => {
    // MADR uses `*` bullets throughout. Promoting them would bury real findings
    // under every option any decision ever considered.
    expect(graph.items).toHaveLength(0);
  });

  it('treats a More Information link as bookkeeping, not a dependency', () => {
    expect(graph.out('ADR-0001', ['relates-to']).map((e) => e.to)).toEqual(['ADR-0002']);
  });

  it('reports nothing, because nothing is wrong', () => {
    expect(diagnostics).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Kubernetes KEP                                                             */
/* -------------------------------------------------------------------------- */

const KEP: Source[] = [
  {
    path: 'keps/sig-node/1234-pod-overhead/README.md',
    text: [
      '---',
      'title: Pod Overhead',
      'kep-number: 1234',
      'authors:',
      '  - "@alice"',
      '  - "@bob"',
      'owning-sig: sig-node',
      'participating-sigs:',
      '  - sig-scheduling',
      'status: implementable',
      'creation-date: 2026-01-09',
      'stage: beta',
      'latest-milestone: "v1.31"',
      '---',
      '',
      '# KEP-1234: Pod Overhead',
      '',
      '<!-- toc -->',
      '<!-- /toc -->',
      '',
      '## Summary',
      '',
      'Account for the resources a pod consumes beyond its containers.',
      '',
      '## Motivation',
      '',
      '### Goals',
      '',
      '- Charge overhead to the pod',
      '',
      '### Non-Goals',
      '',
      '- Changing the scheduler API',
      '',
      '## Design Details',
      '',
      '### Test Plan',
      '',
      '- [x] Unit tests for the admission plugin',
      '- [ ] e2e coverage for eviction',
      '',
      '## Unresolved Questions',
      '',
      '- [ ] How does overhead interact with in-place resize? Deferred to',
      '      [KEP-2000](../2000-in-place-resize/README.md).',
      '- [ ] Should overhead be visible in `kubectl describe`?',
      '      **Resolved:** yes, behind the existing verbosity flag.',
    ].join('\n'),
  },
  {
    path: 'keps/sig-node/2000-in-place-resize/README.md',
    text: [
      '---',
      'title: In-place Pod Resize',
      'kep-number: 2000',
      'status: withdrawn',
      'stage: alpha',
      '---',
      '',
      '# KEP-2000: In-place Pod Resize',
      '',
      '## Summary',
      '',
      'Withdrawn in favour of a different approach.',
    ].join('\n'),
  },
];

describe('Kubernetes KEPs', () => {
  const { graph, diagnostics } = analyseSources(KEP);

  it('identifies a KEP from its directory-style layout and kep-number', () => {
    expect(graph.document('KEP-1234')).toBeDefined();
    expect(graph.document('KEP-2000')).toBeDefined();
  });

  it('reads the KEP status vocabulary', () => {
    expect(graph.document('KEP-1234')?.phase).toBe('active');
    expect(graph.document('KEP-2000')?.phase).toBe('retired');
  });

  it('reads nested and sequence front matter without tripping over it', () => {
    expect(graph.document('KEP-1234')?.frontMatter['owning-sig']).toBe('sig-node');
    expect(graph.document('KEP-1234')?.frontMatter['authors']).toEqual(['@alice', '@bob']);
    expect(graph.document('KEP-1234')?.frontMatter['latest-milestone']).toBe('v1.31');
  });

  it('finds obligations in the Test Plan and Unresolved Questions', () => {
    const open = graph.items.filter((item) => item.openness !== 'closed');
    expect(open.map((item) => item.text)).toEqual([
      'e2e coverage for eviction',
      'How does overhead interact with in-place resize? Deferred to',
    ]);
  });

  it('closes a question answered on its continuation line', () => {
    const resolved = graph.items.find((item) => item.text.includes('kubectl describe'));
    expect(resolved?.disposition).toBe('satisfied');
  });

  it('catches the handover into the withdrawn KEP', () => {
    const found = diagnostics.filter((d) => d.rule === 'ghost-handover');
    expect(found).toHaveLength(1);
    expect(found[0]?.nodes).toContain('KEP-2000');
  });

  it('flags the unchecked box that its own body answered', () => {
    expect(diagnostics.some((d) => d.rule === 'state-conflict')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Rust RFC                                                                   */
/* -------------------------------------------------------------------------- */

const RUST_RFC: Source[] = [
  {
    path: 'text/0001-private-fields.md',
    text: [
      '- Feature Name: `private_fields`',
      '- Start Date: 2026-01-05',
      '- RFC PR: [rust-lang/rfcs#0001](https://github.com/rust-lang/rfcs/pull/1)',
      '- Rust Issue: [rust-lang/rust#5678](https://github.com/rust-lang/rust/issues/5678)',
      '',
      '# Summary',
      '[summary]: #summary',
      '',
      'Make struct fields private by default.',
      '',
      '# Motivation',
      '[motivation]: #motivation',
      '',
      'Encapsulation.',
      '',
      '# Unresolved questions',
      '[unresolved-questions]: #unresolved-questions',
      '',
      '- How does this interact with derive macros?',
      '- What is the migration path? Tracked in [0002](0002-migration.md).',
    ].join('\n'),
  },
  {
    path: 'text/0002-migration.md',
    text: [
      '- Feature Name: `field_migration`',
      '- Start Date: 2026-02-01',
      '',
      '# Summary',
      '[summary]: #summary',
      '',
      'A migration lint.',
    ].join('\n'),
  },
];

describe('Rust RFCs', () => {
  const { graph, corpus, diagnostics } = analyseSources(RUST_RFC);

  it('identifies an RFC by its file stem when the directory names no family', () => {
    // `text/` is not a family name, and a bare "1" would be a useless id.
    expect([...graph.nodes.keys()].filter((id) => !id.includes('#')).sort()).toEqual([
      '0001-private-fields',
      '0002-migration',
    ]);
  });

  it('resolves a bare number, which is unambiguous with only one number space', () => {
    expect(corpus.dangling).toHaveLength(0);
    // The handover belongs to the question, not to the whole RFC.
    const matches = query(graph, 'item -delegates-to-> document');
    expect(matches.map((m) => m.nodes.map((n) => n.id))).toEqual([
      ['0001-private-fields#unresolved-questions.2', '0002-migration'],
    ]);
  });

  it('finds obligations under Unresolved questions without any checkboxes', () => {
    expect(graph.items.map((item) => item.openness)).toEqual(['open', 'open']);
  });

  it('never harvests a reference out of a GitHub URL', () => {
    // `rust-lang/rfcs#0001` inside a URL is a pull request, not a citation.
    expect(corpus.dangling).toHaveLength(0);
    expect(graph.edges.filter((edge) => edge.reflexive)).toHaveLength(0);
  });

  it('does not treat the link-definition footers as references', () => {
    expect(graph.edges.every((edge) => edge.kind !== 'references' || edge.to !== edge.from)).toBe(true);
  });

  it('has no status, and says unknown rather than guessing', () => {
    expect(graph.document('0001-private-fields')?.phase).toBe('unknown');
    // A document with no declared phase must not trigger lifecycle rules.
    expect(diagnostics.map((d) => d.rule)).not.toContain('ghost-handover');
    expect(diagnostics.map((d) => d.rule)).not.toContain('stale-premise');
  });
});

/* -------------------------------------------------------------------------- */
/* Mixed corpus                                                               */
/* -------------------------------------------------------------------------- */

describe('a repository using several conventions at once', () => {
  it('keeps the families apart', () => {
    const mixed = [...MADR, ...KEP];
    const { graph } = analyseSources(mixed);
    expect(graph.document('ADR-0001')).toBeDefined();
    expect(graph.document('KEP-1234')).toBeDefined();
    // ADR-0001 and KEP-1234 share no identity despite living in one corpus.
    expect(graph.document('ADR-1234')).toBeUndefined();
  });

  it('reports nothing new that neither corpus reported alone', () => {
    const separately = [...rules(MADR), ...rules(KEP)].sort();
    const together = rules([...MADR, ...KEP]).sort();
    expect(together).toEqual(separately);
  });
});
