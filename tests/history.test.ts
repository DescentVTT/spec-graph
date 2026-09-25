import { describe, expect, it } from 'vitest';

import { phaseOf, receptivityOf } from '../src/lifecycle.js';
import { analyseSources, createHistoryMatcher, type AnalyseSourcesOptions, type Source } from '../src/runner.js';
import type { AnyRuleId } from '../src/types.js';

/**
 * Historical records: files that say what was decided, not what is decided.
 *
 * A journal noting "deferred to ADR-0002" in 2024 is not delegating anything.
 * It is reporting that somebody once did. When ADR-0002 retires in 2026 the
 * note does not become a defect, because there is nothing in it for anyone to
 * fix. See ADR-0011.
 */

const analyse = (files: Record<string, string>, options: AnalyseSourcesOptions = {}) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    options,
  );

const asHistory = (...paths: string[]): AnalyseSourcesOptions => ({ isRecord: (path) => paths.includes(path) });

const rules = (files: Record<string, string>, options: AnalyseSourcesOptions = {}): AnyRuleId[] =>
  analyse(files, options).diagnostics.map((diagnostic) => diagnostic.rule);

const RETIRED = ['# ADR-0002: Sharding', '', '## Status', '', 'retired'].join('\n');

const JOURNAL = [
  '# Engineering Journal 2024',
  '',
  '## March',
  '',
  'Decision deferred to ADR-0002. Sharding would land in Q3.',
  '',
  '- [ ] Follow up with the storage team',
  '',
  'See the [migration plan](docs/plans/migration.md) for the sequence.',
].join('\n');

const CORPUS = { 'docs/adr/0002-sharding.md': RETIRED, 'docs/journal/JOURNAL_2024.md': JOURNAL };
const HISTORY = asHistory('docs/journal/JOURNAL_2024.md');

describe('a log is not a specification', () => {
  it('reports the journal as a defect until it is declared a record', () => {
    // The friction this exists to remove, stated as a test so it cannot come
    // back: a 2024 note about a decision retired in 2026 is not a handover.
    expect(rules(CORPUS)).toContain('ghost-handover');
  });

  it('stops indicting it once it is', () => {
    expect(rules(CORPUS, HISTORY)).not.toContain('ghost-handover');
  });

  it('still checks where its links go', () => {
    // The whole reason not to solve this by excluding the file: a journal full
    // of links that 404 is exactly what this tool is for.
    expect(rules(CORPUS, HISTORY)).toContain('broken-reference');
  });

  it('keeps its checkboxes as items, and stops calling them obligations', () => {
    // The text is still what it is, and still queryable. What changes is
    // whether anybody is held to it. The headline count is asserted end to end
    // in the CLI tests, where the summary is actually built.
    const { corpus, graph } = analyse(CORPUS, HISTORY);
    expect(corpus.items.filter((item) => item.openness !== 'closed')).toHaveLength(1);
    expect(graph.document('JOURNAL-2024')?.phase).toBe('record');
  });

  it('leaves the specifications around it exactly as they were', () => {
    const live = {
      ...CORPUS,
      'docs/adr/0003-cache.md': ['# ADR-0003: Cache', '', '## Status', '', 'accepted', '', 'This depends on ADR-0002.'].join(
        '\n',
      ),
    };
    expect(rules(live, HISTORY)).toContain('stale-premise');
  });
});

describe('what a record still answers for', () => {
  it('is sealed, so live work handed into one is still a ghost handover', () => {
    // A record will never act. Delegating to it is the failure this tool was
    // built to find, and being a record is what makes it certain.
    const files = {
      'docs/journal/JOURNAL_2024.md': ['# Journal', '', 'Notes from the year.'].join('\n'),
      'docs/adr/0005-live.md': [
        '# ADR-0005: Live',
        '',
        '## Status',
        '',
        'accepted',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns rollout? Deferred to JOURNAL-2024.',
      ].join('\n'),
    };
    const found = analyse(files, asHistory('docs/journal/JOURNAL_2024.md')).diagnostics;
    const ghost = found.find((diagnostic) => diagnostic.rule === 'ghost-handover');
    expect(ghost?.message).toContain('a historical record');
    expect(ghost?.hint).toContain('will never act');
  });

  it('cannot absorb an obligation, by the same rule as anything else sealed', () => {
    expect(receptivityOf('record')).toBe('sealed');
  });
});

describe('declaring a record', () => {
  it('takes a directive, for one file', () => {
    const files = { ...CORPUS, 'docs/journal/JOURNAL_2024.md': `<!-- @spec-history -->\n\n${JOURNAL}` };
    expect(rules(files)).not.toContain('ghost-handover');
    expect(rules(files)).toContain('broken-reference');
  });

  it('takes a glob, for a class of them', () => {
    const matcher = createHistoryMatcher(['**/JOURNAL_*.md']);
    expect(matcher?.('docs/journal/JOURNAL_2024.md')).toBe(true);
    expect(matcher?.('docs/adr/0002-sharding.md')).toBe(false);
    expect(createHistoryMatcher([])).toBeUndefined();
    expect(createHistoryMatcher(undefined)).toBeUndefined();
  });

  it('outranks a status word written inside the file', () => {
    // Being a record is a statement about what the file is, made deliberately
    // from outside it. A `Status: accepted` line in a changelog is describing
    // something else entirely.
    const files = {
      'docs/log.md': ['---', 'status: accepted', '---', '', '# Log', '', 'Things that happened.'].join('\n'),
    };
    expect(analyse(files).graph.document('log')?.phase).toBe('active');
    expect(analyse(files, asHistory('docs/log.md')).graph.document('log')?.phase).toBe('record');
  });

  it('carries into the sections of a register kept as a journal', () => {
    const files = {
      'docs/log.md': [
        '# Decision Log',
        '',
        '## ADR-0100: What we chose in March',
        '',
        '**Status:** accepted',
        '',
        '- [ ] never closed',
      ].join('\n'),
    };
    expect(analyse(files, asHistory('docs/log.md')).graph.document('ADR-0100')?.phase).toBe('record');
    expect(rules(files, asHistory('docs/log.md'))).not.toContain('orphaned-obligation');
  });
});

describe('the exemption is stated once, so every rule inherits it', () => {
  const openInside = (path: string): Record<string, string> => ({
    [path]: ['---', 'status: retired', '---', '', '# Log', '', '- [ ] never closed'].join('\n'),
    'docs/adr/0002-sharding.md': RETIRED,
  });

  it('covers orphaned obligations', () => {
    expect(rules(openInside('docs/log.md'))).toContain('orphaned-obligation');
    expect(rules(openInside('docs/log.md'), asHistory('docs/log.md'))).not.toContain('orphaned-obligation');
  });

  it('covers a delegation cycle that runs through a record', () => {
    // A cycle is a set, not a subject, so it cannot be exempted where the
    // others are. One record in the loop means the loop is partly a report.
    const files = {
      'docs/journal/JOURNAL_2024.md': ['# Journal', '', 'Blocked by ADR-0007.'].join('\n'),
      'docs/adr/0007-a.md': ['# ADR-0007: A', '', '## Status', '', 'accepted', '', 'Blocked by JOURNAL-2024.'].join('\n'),
    };
    expect(rules(files)).toContain('circular-delegation');
    expect(rules(files, asHistory('docs/journal/JOURNAL_2024.md'))).not.toContain('circular-delegation');
  });
});

describe('an archived round of work is a record', () => {
  // spec-brief archives a finished round by writing `status: archived` and
  // moving the brief into an archive directory, and every spec-* tool reads
  // that word the same way: a closed round, kept as it was left, which it is
  // normal to depend on. It used to read here as a retired decision. ADR-0011.
  const ARCHIVED = [
    '---',
    'id: B-0001',
    'status: archived',
    '---',
    '',
    '# B-0001: Sign-in',
    '',
    '## Tasks',
    '',
    '- [x] Store the session',
    '- [ ] Rotate the key',
    '',
    'The steps were in [the plan](plans/sign-in.md).',
  ].join('\n');
  const LIVE = ['---', 'id: B-0002', 'status: active', 'dependsOn: [B-0001]', '---', '', '# B-0002: Sessions'].join('\n');
  const BRIEFS = { 'briefs/archive/0001-sign-in.md': ARCHIVED, 'briefs/0002-sessions.md': LIVE };

  it('reads the word as a record, however it is written', () => {
    expect(phaseOf('archived')).toBe('record');
    expect(phaseOf('Archived (2026-09-01)')).toBe('record');
    expect(phaseOf('archive')).toBe('record');
    expect(analyse(BRIEFS).graph.document('B-0001')?.phase).toBe('record');
  });

  it('is a premise a live brief may rest on', () => {
    // Before, B-0002 rested on a "retired" decision and was stale-premise.
    const { graph } = analyse(BRIEFS);
    expect(graph.edges.some((edge) => edge.kind === 'depends-on' && edge.from === 'B-0002' && edge.to === 'B-0001')).toBe(true);
    expect(rules(BRIEFS)).not.toContain('stale-premise');
  });

  it('still has its links checked, and nothing else', () => {
    // An unticked box in a closed round was never going to be ticked, so it is
    // not an orphaned obligation. The link to a plan that is not there is
    // still broken.
    expect(rules(BRIEFS)).toEqual(['broken-reference']);
    const { corpus } = analyse(BRIEFS);
    expect(corpus.items.filter((item) => item.document === 'B-0001' && item.openness === 'open')).toHaveLength(1);
  });

  it('still cannot take on new work', () => {
    // Sealed, as any record is: handing live work to a closed round is the
    // ghost handover this tool exists to find.
    const handed = {
      ...BRIEFS,
      'briefs/0002-sessions.md': `${LIVE}\n\n## Tasks\n\n- [ ] Expire idle sessions? Deferred to [B-0001](archive/0001-sign-in.md).\n`,
    };
    const ghost = analyse(handed).diagnostics.find((diagnostic) => diagnostic.rule === 'ghost-handover');
    expect(ghost?.message).toContain('a historical record');
  });

  it('leaves a retirement word retiring, archived or not', () => {
    // Retirement is terminal and wins wherever it is written (ADR-0002).
    expect(phaseOf('archived, superseded by B-0003')).toBe('retired');
    const superseded = { ...BRIEFS, 'briefs/archive/0001-sign-in.md': ARCHIVED.replace('status: archived', 'status: superseded') };
    expect(rules(superseded)).toContain('stale-premise');
    expect(rules(superseded)).toContain('orphaned-obligation');
  });

  it('leaves the archive directory retiring a document that declares nothing', () => {
    // Moving an ADR into archive/ is how a team retires one without editing it,
    // and that reading is unchanged. A brief spec-brief archives says so itself.
    const silent = { ...BRIEFS, 'briefs/archive/0001-sign-in.md': ARCHIVED.replace('status: archived\n', '') };
    expect(analyse(silent).graph.document('B-0001')?.phase).toBe('retired');
    expect(rules(silent)).toContain('stale-premise');
  });

  it('is what historyPatterns declares, as before, whatever the status says', () => {
    const accepted = { ...BRIEFS, 'briefs/archive/0001-sign-in.md': ARCHIVED.replace('status: archived', 'status: accepted') };
    expect(analyse(accepted).graph.document('B-0001')?.phase).toBe('active');
    const declared = analyse(accepted, { isRecord: createHistoryMatcher(['briefs/archive/**']) });
    expect(declared.graph.document('B-0001')?.phase).toBe('record');
    expect(declared.graph.document('B-0002')?.phase).toBe('active');
  });
});

describe('a record still answers for its citations', () => {
  it('is reported for a front-matter key that declares no relation', () => {
    // ADR-0011 keeps a record's obligations and lifecycle out of the report,
    // not its references - and a key that declares nothing is a citation that
    // did not happen.
    const found = analyse(
      {
        'docs/adr/0001-a.md': '---\nid: ADR-0001\nstatus: accepted\n---\n\n# ADR-0001: A\n',
        'JOURNAL_2026.md': '---\nid: JOURNAL-1\nsupercedes-by: ADR-0001\n---\n\n# Journal\n',
      },
      asHistory('JOURNAL_2026.md'),
    ).diagnostics;
    expect(found.map((d) => d.rule)).toEqual(['unknown-relation-key']);
  });
});
