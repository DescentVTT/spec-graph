import { describe, expect, it } from 'vitest';

import { compileProjectRules } from '../src/project-rules.js';
import { analyseSources, type Source } from '../src/runner.js';
import { EDGE_KINDS, EDGE_TRAITS, type EdgeKind } from '../src/types.js';

/**
 * What the package says of each relation, where no rule of its own says it
 * (`EDGE_TRAITS` in src/types.ts).
 *
 * The built-in rules print the words of the relations they are about: a
 * stale premise `depends on`, a ghost handover `is blocked by`. A rule a
 * repository writes for itself can walk any relation, and its finding says
 * each one after the first in the table's words, so `contains`, `references`
 * and `relates to` reach a report that way and no other. No sweep read the
 * table until 2026-10-14 (ADR-0007), and nothing held those three.
 */

const accepted = (title: string, body: string): string => `---\nstatus: accepted\n---\n\n# ${title}\n\n${body}\n`;

/** What a project rule's finding says of the second relation on its path, where that relation is `kind`. */
function said(kind: EdgeKind): string[] {
  const { rules, problems } = compileProjectRules(
    { walked: { query: `document[id=ADR-0001] -references-> document -${kind}-> *`, message: '{0} reaches {2}' } },
    '.spec-graph.json',
  );
  expect(problems).toEqual([]);
  const second = kind === 'contains' ? '## Open Questions\n\n- [ ] Who owns this?' : `<!-- @spec-edge kind="${kind}" to="ADR-0003" -->`;
  const sources: Source[] = [
    { path: 'docs/adr/0001-a.md', text: accepted('ADR-0001: A', 'See [ADR-0002](0002-b.md).') },
    { path: 'docs/adr/0002-b.md', text: accepted('ADR-0002: B', second) },
    { path: 'docs/adr/0003-c.md', text: accepted('ADR-0003: C', 'Nothing here.') },
  ];
  return analyseSources(sources, { projectRules: rules })
    .diagnostics.filter((diagnostic) => diagnostic.rule === 'project:walked')
    .flatMap((diagnostic) => diagnostic.related.map((entry) => entry.note));
}

describe('the words a finding says a relation in', () => {
  // Each as a reader meets it. Written out, not read from the table: the
  // table is what is held.
  const SAID: Record<EdgeKind, string> = {
    contains: 'ADR-0002 contains ADR-0002#open-questions.1',
    references: 'ADR-0002 references ADR-0003',
    'relates-to': 'ADR-0002 relates to ADR-0003',
    'depends-on': 'ADR-0002 depends on ADR-0003',
    assumes: 'ADR-0002 assumes ADR-0003',
    'delegates-to': 'ADR-0002 delegates to ADR-0003',
    'blocked-by': 'ADR-0002 is blocked by ADR-0003',
    supersedes: 'ADR-0002 supersedes ADR-0003',
    amends: 'ADR-0002 amends ADR-0003',
  };

  it.each(Object.entries(SAID))('are, for %s, "%s"', (kind, sentence) => {
    expect(said(kind as EdgeKind)).toEqual([sentence]);
  });

  it('are there for every relation the package names', () => {
    expect(Object.keys(SAID).sort()).toEqual([...EDGE_KINDS].sort());
  });
});

describe('the relations that speak of the lifecycle of what they point at', () => {
  it('are `supersedes` and `amends`, and no other', () => {
    // No rule here reads the property. It is in the table for a program
    // that imports the package, so the table is what there is to hold: one
    // relation replaces its target and the other changes it, and the other
    // seven say nothing of what becomes of it.
    expect(EDGE_KINDS.filter((kind) => EDGE_TRAITS[kind].lifecycle)).toEqual(['supersedes', 'amends']);
    expect(EDGE_KINDS.filter((kind) => !EDGE_TRAITS[kind].lifecycle)).toHaveLength(7);
  });
});
