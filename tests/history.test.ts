import { describe, expect, it } from 'vitest';

import { receptivityOf } from '../src/lifecycle.js';
import { analyseSources, createHistoryMatcher, type AnalyseSourcesOptions, type Source } from '../src/runner.js';
import type { RuleId } from '../src/types.js';

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

const rules = (files: Record<string, string>, options: AnalyseSourcesOptions = {}): RuleId[] =>
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
