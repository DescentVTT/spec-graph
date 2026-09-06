import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HELP } from '../src/cli.js';
import { DEFAULT_SEVERITIES, RULE_IDS } from '../src/rules.js';
import { attributesOf } from '../src/select.js';
import { EDGE_KINDS, OPENNESS_OF, type Disposition, type DocumentNode, type ItemNode } from '../src/types.js';

/**
 * The documentation is held to the same standard as the graph.
 *
 * A tool whose whole premise is that prose drifts away from the thing it
 * describes has no business shipping a README that has drifted away from its
 * own code. These tests are the vertical check spec-graph cannot perform on
 * itself: they compare what the documents claim against what the code exports.
 */

const README = readFileSync('README.md', 'utf8');

describe('the README rule table', () => {
  const rows = [...README.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*(error|warn|info)\s*\|/gm)].map((row) => ({
    id: row[1] as string,
    severity: row[2] as string,
  }));

  it('documents every rule', () => {
    expect(rows.map((row) => row.id).sort()).toEqual([...RULE_IDS].sort());
  });

  it('documents each default severity correctly', () => {
    for (const row of rows) {
      expect(row.severity, row.id).toBe(DEFAULT_SEVERITIES[row.id as keyof typeof DEFAULT_SEVERITIES]);
    }
  });

  it('documents no rule that does not exist', () => {
    for (const row of rows) expect(RULE_IDS, row.id).toContain(row.id);
  });
});

describe('the README disposition table', () => {
  const rows = [...README.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*(open|partial|closed)\s*\|/gm)].map((row) => ({
    disposition: row[1] as Disposition,
    openness: row[2] as string,
  }));

  it('lists every disposition', () => {
    expect(rows.map((row) => row.disposition).sort()).toEqual(Object.keys(OPENNESS_OF).sort());
  });

  it('states the right openness for each', () => {
    for (const row of rows) expect(row.openness, row.disposition).toBe(OPENNESS_OF[row.disposition]);
  });
});

describe('the documented selector vocabulary', () => {
  /** Every attribute key the engine answers to, checked against both nodes. */
  const SUPPORTED = [
    'id',
    'kind',
    'title',
    'file',
    'line',
    'document',
    'path',
    'phase',
    'status',
    'receptivity',
    'alias',
    'state',
    'disposition',
    'openness',
    'section',
    'text',
    'body',
    'evidence',
    'conflicted',
  ];

  const documentNode: DocumentNode = {
    id: 'ADR-0001',
    kind: 'document',
    title: 'T',
    at: { file: 'a.md', span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } } },
    path: 'a.md',
    aliases: ['adr0001'],
    phase: 'active',
    rawStatus: 'accepted',
    statusAt: null,
    frontMatter: { owner: 'platform' },
  };

  const itemNode: ItemNode = {
    id: 'ADR-0001#q.1',
    kind: 'item',
    title: 'Q',
    at: { file: 'a.md', span: { start: { offset: 0, line: 5, column: 1 }, end: { offset: 0, line: 5, column: 1 } } },
    document: 'ADR-0001',
    section: ['Open Questions'],
    text: 'Q',
    body: 'Q',
    disposition: 'unresolved',
    openness: 'open',
    evidence: {
      source: 'checkbox',
      disposition: 'unresolved',
      raw: '[ ]',
      at: { file: 'a.md', span: { start: { offset: 0, line: 5, column: 1 }, end: { offset: 0, line: 5, column: 1 } } },
    },
    conflicts: [],
  };

  it('is listed in the CLI help', () => {
    for (const key of SUPPORTED) expect(HELP, key).toContain(key);
    expect(HELP).toContain('fm.<front-matter-key>');
  });

  it('is listed in the README', () => {
    for (const key of SUPPORTED) expect(README, key).toContain(key);
  });

  it('is answered by the engine on one node kind or the other', () => {
    for (const key of SUPPORTED) {
      const answered =
        attributesOf(documentNode, key).length > 0 || attributesOf(itemNode, key).length > 0;
      expect(answered, `no node answers to "${key}"`).toBe(true);
    }
  });

  it('answers front-matter keys', () => {
    expect(attributesOf(documentNode, 'fm.owner')).toEqual(['platform']);
  });
});

describe('the documented relation vocabulary', () => {
  it('names every edge kind in the CLI help or the README', () => {
    for (const kind of EDGE_KINDS) {
      expect(`${HELP}\n${README}`, kind).toContain(kind);
    }
  });
});

describe('the CLI help and the README agree on the interface', () => {
  const flags = [
    '--root',
    '--ignore',
    '--format',
    '--graph-format',
    '--documents-only',
    '--rule',
    '--max',
    '--max-warnings',
    '--no-color',
    '--ascii',
    '--verbose',
  ];

  it('documents the same flags in both places', () => {
    for (const flag of flags) {
      expect(HELP, flag).toContain(flag);
      expect(README, flag).toContain(flag);
    }
  });

  it('documents the same commands in both places', () => {
    // `check` is the default, so both texts write it as `spec-graph [check]`.
    for (const command of ['check', 'query', 'graph', 'rules']) {
      const usage = new RegExp(`spec-graph \\[?${command}\\]?\\b`);
      expect(HELP, command).toMatch(usage);
      expect(README, command).toMatch(usage);
    }
  });

  it('documents the same exit codes', () => {
    expect(HELP).toContain('0  clean');
    expect(README).toContain('`0` clean');
  });
});
