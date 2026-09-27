import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AnalyseSourcesOptions } from '../src/runner.js';
import type { AnyRuleId, Diagnostic } from '../src/types.js';

/**
 * Each built-in rule's finding, as the person who has to fix it reads it: the
 * sentence, the line it points at, the places it names beside that, and the
 * next action. Where the README prints a finding, the expectation is the
 * README's; elsewhere it is the decision the finding carries - which document,
 * how many, retired or frozen, one or several.
 *
 * The pipeline is imported inside each test rather than at the top of the file.
 * `rules.ts` parses its selectors while it loads, and a module that throws while
 * loading fails every file that imports it before any test runs: the suite goes
 * red, but a mutation sweep reads a file that never ran as a file with nothing
 * to say, and scores the mutant survived.
 */

async function analyse(files: Record<string, string>, options: AnalyseSourcesOptions = {}) {
  const { analyseSources } = await import('../src/runner.js');
  return analyseSources(
    Object.entries(files).map(([path, text]) => ({ path, text })),
    options,
  );
}

async function findings(files: Record<string, string>, rule: AnyRuleId, options: AnalyseSourcesOptions = {}) {
  return (await analyse(files, options)).diagnostics.filter((diagnostic) => diagnostic.rule === rule);
}

/** A finding as a reader sees it: where, what, beside what, and what next. */
function read(diagnostic: Diagnostic | undefined) {
  if (!diagnostic) throw new Error('no finding');
  const place = (at: Diagnostic['at']): string => `${at.file}:${at.span.start.line}:${at.span.start.column}`;
  return {
    at: place(diagnostic.at),
    message: diagnostic.message,
    nodes: diagnostic.nodes,
    related: diagnostic.related.map((entry) => `${place(entry.at)} ${entry.note}`),
    hint: diagnostic.hint,
  };
}

const doc = (status: string, body = '', extra = ''): string => `---\nstatus: ${status}\n${extra}---\n\n${body}\n`;

/* -------------------------------------------------------------------------- */

describe('ghost-handover', () => {
  // The README's opening example, line for line where its positions depend on it.
  const readme = {
    'docs/adr/0002-single-node-storage.md': doc('Superseded by ADR-0007', '# ADR-0002: Single-node storage'),
    'docs/adr/0003-event-log.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# ADR-0003: Append-only event log',
      '',
      '## Decision',
      '',
      'All writes go through an append-only log.',
      '',
      '## Open Questions',
      '',
      '- [ ] Which compaction policy do we use? Deferred to [ADR-0002](0002-single-node-storage.md).',
    ].join('\n'),
    'docs/adr/0007-distributed-storage.md': doc('accepted', '# ADR-0007: Distributed storage', 'supersedes: ADR-0002\n'),
  };

  it('reads as the README prints it', async () => {
    const [found] = await findings(readme, 'ghost-handover');
    expect(read(found)).toEqual({
      at: 'docs/adr/0003-event-log.md:13:65',
      message: 'open obligation delegates to ADR-0002, which is retired',
      nodes: ['ADR-0003#open-questions.1', 'ADR-0002'],
      related: [
        'docs/adr/0002-single-node-storage.md:2:9 ADR-0002 is retired ("Superseded by ADR-0007")',
        'docs/adr/0003-event-log.md:13:1 the obligation: Which compaction policy do we use? Deferred to ADR-0002.',
      ],
      hint: 'nothing will be read from ADR-0002 again - re-home this in a live document, or close it here',
    });
  });

  it('calls work a document hands on an obligation, and names no item for it', async () => {
    const [found] = await findings(
      {
        'docs/adr/0002-storage.md': doc('retired', '# Storage'),
        'docs/adr/0004-cache.md': doc('accepted', '# Cache', 'delegates-to: ADR-0002\n'),
      },
      'ghost-handover',
    );
    expect(read(found).message).toBe('obligation delegates to ADR-0002, which is retired');
    expect(read(found).related).toEqual(['docs/adr/0002-storage.md:2:9 ADR-0002 is retired ("retired")']);
  });

  it('tells a frozen target to be amended', async () => {
    const [found] = await findings(
      { ...readme, 'docs/adr/0002-single-node-storage.md': doc('final', '# ADR-0002: Single-node storage') },
      'ghost-handover',
    );
    expect(read(found).message).toBe('open obligation delegates to ADR-0002, which is frozen');
    expect(read(found).hint).toBe(
      'ADR-0002 is frozen and cannot take on new work - open an amendment, or close this here',
    );
  });

  it('quotes no status for a target its directory retired, and points at the document', async () => {
    const [found] = await findings(
      {
        'docs/adr/archive/0002-storage.md': '# ADR-0002: Storage\n',
        'docs/adr/0004-cache.md': doc('accepted', '# Cache', 'delegates-to: ADR-0002\n'),
      },
      'ghost-handover',
    );
    expect(read(found).related).toEqual(['docs/adr/archive/0002-storage.md:1:1 ADR-0002 is retired']);
  });
});

describe('stale-premise', () => {
  it('names the retired decision, its status line, and what retired it', async () => {
    const [found] = await findings(
      {
        'docs/adr/0002-rows.md': doc('superseded by ADR-0009', '# Row limits'),
        'docs/adr/0009-rows-v2.md': doc('accepted', '# Row limits v2', 'supersedes: ADR-0002\n'),
        'docs/adr/0005-export.md': doc(
          'accepted',
          '# Export\n\nThe chunking scheme is constrained by [ADR-0002](0002-rows.md), which caps rows at 4 KB.',
        ),
      },
      'stale-premise',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0005-export.md:7:50',
      message: 'ADR-0005 assumes ADR-0002, which no longer holds',
      nodes: ['ADR-0005', 'ADR-0002'],
      related: ['docs/adr/0002-rows.md:2:9 ADR-0002 is retired ("superseded by ADR-0009")'],
      hint: 're-check this dependency: the constraint it assumes may have been lifted when ADR-0002 was retired',
    });
  });

  it('names the obviated question, at the question, and shortens a long one', async () => {
    const [found] = await findings(
      {
        'docs/adr/0002-rows.md': doc(
          'accepted',
          [
            '# Row limits',
            '',
            '## Open Questions',
            '',
            '<!-- @spec-item id="row-cap" -->',
            '- [ ] Do we need a 4 KB row cap for the export tables? **Moot** - the engine removed the limit in v9.',
          ].join('\n'),
        ),
        'docs/adr/0005-export.md': doc('accepted', '# Export\n\nChunking assumes [the row cap](0002-rows.md#row-cap) still applies.'),
      },
      'stale-premise',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0005-export.md:7:32',
      message: 'ADR-0005 assumes ADR-0002 "Do we need a 4 KB row cap for the export tabl...", which no longer holds',
      nodes: ['ADR-0005', 'ADR-0002#row-cap'],
      related: ['docs/adr/0002-rows.md:10:1 that question was obviated - its premise no longer holds'],
      hint: 're-check this dependency: the constraint it assumes may have been lifted when the question closed',
    });
  });
});

describe('references', () => {
  it('lists every candidate of an ambiguous citation', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-sharding.md': '---\naliases: [sharding]\n---\n\n# One\n',
        'docs/adr/0002-sharding-v2.md': '---\naliases: [sharding]\n---\n\n# Two\n',
        'docs/adr/0003-c.md': '# Three\n\nWe follow [[sharding]].\n',
      },
      'ambiguous-reference',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0003-c.md:3:13',
      message: '"sharding" matches 2 documents',
      nodes: ['ADR-0003'],
      related: [],
      hint: 'disambiguate it - candidates: ADR-0001, ADR-0002',
    });
    expect(found?.target).toBe('sharding');
  });

  it('offers the three nearest items for an anchor that misses, and a check where none is near', async () => {
    const found = await findings(
      {
        'docs/adr/0001-a.md': doc('accepted', '# A\n\n## Open Questions\n\n- [ ] One?\n- [ ] Two?\n- [ ] Three?\n- [ ] Four?'),
        'docs/adr/0002-b.md': '# B\n\nSee [the questions](0001-a.md#open-question) and [[0001-a#nonexistent]].\n',
      },
      'broken-reference',
    );
    expect(found.map((diagnostic) => [diagnostic.message, diagnostic.hint])).toEqual([
      [
        '"0001-a.md#open-question" points at an anchor that does not exist',
        'did you mean ADR-0001#open-questions.1, ADR-0001#open-questions.2, ADR-0001#open-questions.3?',
      ],
      // A wiki link with an anchor names a document that exists: it is the
      // anchor that is wrong, not a concept tag.
      ['"0001-a#nonexistent" points at an anchor that does not exist', 'check the heading or item id it is meant to address'],
    ]);
  });

  it('tells a missing document to be fixed or written, not ignored as a concept', async () => {
    const [found] = await findings({ 'docs/adr/0002-b.md': '# B\n\nSee [the plan](0099-missing.md).\n' }, 'broken-reference');
    expect(read(found).hint).toBe('fix the identifier, or add the document it names');
  });

  it('suggests for a concept tag a glob that silences it', async () => {
    const { createReferenceFilter } = await import('../src/glob.js');
    const tags = ['trap 55', 'trap-55', 'trap_55', 'trap55', 'Q-17', 'season 2 episode 5', '2024', 'services'];
    const suggested: [string, string, boolean][] = [];
    for (const tag of tags) {
      const files = { 'docs/adr/0001-a.md': `# A\n\nSee [[${tag}]].\n` };
      const [found] = await findings(files, 'broken-reference');
      const glob = /--ignore-ref "(.*)"$/.exec(found?.hint ?? '')?.[1] ?? '';
      const quiet = (await analyse(files, { isIgnoredReference: createReferenceFilter([glob]) })).diagnostics.length === 0;
      suggested.push([tag, glob, quiet]);
    }
    expect(suggested).toEqual([
      ['trap 55', 'trap *', true],
      ['trap-55', 'trap-*', true],
      ['trap_55', 'trap_*', true],
      ['trap55', 'trap*', true],
      ['Q-17', 'Q-*', true],
      ['season 2 episode 5', 'season 2 episode *', true],
      // Nothing numbered after a name: suggested verbatim rather than invented.
      ['2024', '2024', true],
      ['services', 'services', true],
    ]);
  });

  it('includes a file at the root of the repository with the pattern for the root', async () => {
    const [found] = await findings(
      { 'docs/adr/0001-a.md': '# A\n\nSee [notes](../../NOTES.md).\n' },
      'reference-outside-corpus',
      { fileExists: (path) => path === 'NOTES.md' },
    );
    expect(read(found).hint).toBe('include it, for example: spec-graph "**/*.md"');
  });

  it('names a key that declares no relation, and how to spell it', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc('accepted', '# A'),
        'docs/adr/0002-b.md': doc('accepted', '# B', 'depnds-on: ADR-0001\n'),
      },
      'unknown-relation-key',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0002-b.md:3:1',
      message: '"depnds-on" declares no relation',
      nodes: ['ADR-0002'],
      related: [],
      hint: 'spell it depends-on, or move it out of front matter if it is not a relation',
    });
  });

  it('are still reported from a log, ambiguous or outside the corpus', async () => {
    // ADR-0011: a record answers for its citations, whoever wrote them.
    const found = await analyse(
      {
        'docs/adr/0001-sharding.md': '---\naliases: [sharding]\n---\n\n# One\n',
        'docs/adr/0002-sharding-v2.md': '---\naliases: [sharding]\n---\n\n# Two\n',
        'JOURNAL_2026.md': '# Journal\n\nWe followed [[sharding]]; the notes are in [notes](notes.md).\n',
      },
      { isRecord: (path) => path === 'JOURNAL_2026.md', fileExists: (path) => path === 'notes.md' },
    );
    expect(found.diagnostics.map((diagnostic) => diagnostic.rule).sort()).toEqual([
      'ambiguous-reference',
      'reference-outside-corpus',
    ]);
  });
});

describe('circular-delegation', () => {
  const loop = {
    'docs/adr/0001-a.md': doc('accepted', '# A', 'delegates-to: ADR-0002\n'),
    'docs/adr/0002-b.md': doc('accepted', '# B\n\nBackground is in [ADR-0001](0001-a.md).', 'delegates-to: ADR-0003\n'),
    'docs/adr/0003-c.md': doc('accepted', '# C', 'delegates-to: ADR-0001\n'),
  };

  it('points at the first delegation and names each one in the loop', async () => {
    const [found] = await findings(loop, 'circular-delegation');
    expect(read(found)).toEqual({
      at: 'docs/adr/0001-a.md:3:15',
      message: 'delegation cycle across 3 documents: nothing in it can ever land',
      nodes: ['ADR-0001', 'ADR-0002', 'ADR-0003'],
      related: [
        'docs/adr/0001-a.md:3:15 ADR-0001 delegates to ADR-0002',
        'docs/adr/0002-b.md:3:15 ADR-0002 delegates to ADR-0003',
        'docs/adr/0003-c.md:3:15 ADR-0003 delegates to ADR-0001',
      ],
      hint: 'break the loop: one of these must own the work outright, or be closed',
    });
  });

  it('names only the relations that make the loop', async () => {
    // Not work handed into it from outside, nor a question one of its documents
    // defers to a later section of itself.
    const [found] = await findings(
      {
        ...loop,
        'docs/adr/0001-a.md': doc(
          'accepted',
          '# A\n\n## Open Questions\n\n- [ ] Who owns retention? Deferred to [the decision](#decision).\n\n## Decision\n\nTo follow.',
          'delegates-to: ADR-0002\n',
        ),
        'docs/adr/0004-d.md': doc('accepted', '# D', 'delegates-to: ADR-0001\n'),
      },
      'circular-delegation',
    );
    expect(read(found).related.map((entry) => entry.replace(/^\S+ /, ''))).toEqual([
      'ADR-0001 delegates to ADR-0002',
      'ADR-0002 delegates to ADR-0003',
      'ADR-0003 delegates to ADR-0001',
    ]);
  });

  it('is a supersession cycle when every relation in it is one, whatever else the documents cite', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc('superseded', '# A\n\nSee [ADR-0002](0002-b.md).', 'supersedes: ADR-0002\n'),
        'docs/adr/0002-b.md': doc('superseded', '# B', 'supersedes: ADR-0001\n'),
      },
      'circular-delegation',
    );
    expect(read(found).message).toBe('supersession cycle across 2 documents');
    expect(read(found).related.map((entry) => entry.replace(/^\S+ /, ''))).toEqual([
      'ADR-0001 supersedes ADR-0002',
      'ADR-0002 supersedes ADR-0001',
    ]);
  });

  it('is not reported through a log, and is through an archived round', async () => {
    const withLog = await findings(loop, 'circular-delegation', { isRecord: (path) => path === 'docs/adr/0002-b.md' });
    expect(withLog).toEqual([]);
    const archived = { ...loop, 'docs/adr/0002-b.md': loop['docs/adr/0002-b.md'].replace('status: accepted', 'status: archived') };
    expect(await findings(archived, 'circular-delegation')).toHaveLength(1);
  });
});

describe('orphaned-obligation', () => {
  it('says frozen, and one, for a frozen document holding one open item', async () => {
    const [found] = await findings(
      {
        'docs/rfcs/0002-wire.md': doc(
          'final',
          '# Wire format\n\n## Open Questions\n\n- [ ] Who owns the migration?\n- [x] Is the index needed? Yes.',
        ),
      },
      'orphaned-obligation',
    );
    expect(read(found)).toEqual({
      at: 'docs/rfcs/0002-wire.md:2:9',
      message: 'frozen document still holds 1 open obligation',
      nodes: ['RFC-0002', 'RFC-0002#open-questions.1'],
      related: ['docs/rfcs/0002-wire.md:9:1 unresolved: Who owns the migration?'],
      hint: 'move each one to a live document or close it - as it stands, it disappears with RFC-0002',
    });
  });

  it('says retired, and how many, for several, and names as many as the cap allows', async () => {
    const questions = Array.from({ length: 10 }, (_, index) => `- [ ] Question ${index + 1}?`).join('\n');
    const files = { 'docs/adr/0002-old.md': doc('retired', `# Old\n\n## Open Questions\n\n${questions}`) };
    const [found] = await findings(files, 'orphaned-obligation');
    expect(read(found).message).toBe('retired document still holds 10 open obligations');
    expect(read(found).hint).toBe('move each one to a live document or close it - as it stands, they disappear with ADR-0002');
    expect(found?.nodes).toHaveLength(11);
    // Eight related locations by default, and what the configuration says otherwise.
    expect(found?.related).toHaveLength(8);
    const [capped] = await findings(files, 'orphaned-obligation', { maxRelated: 3 });
    expect(capped?.related.map((entry) => entry.note)).toEqual([
      'unresolved: Question 1?',
      'unresolved: Question 2?',
      'unresolved: Question 3?',
    ]);
  });

  it('caps the related locations of every rule, not only its own', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc('accepted', '# A', 'delegates-to: ADR-0002\n'),
        'docs/adr/0002-b.md': doc('accepted', '# B', 'delegates-to: ADR-0003\n'),
        'docs/adr/0003-c.md': doc('accepted', '# C', 'delegates-to: ADR-0001\n'),
      },
      'circular-delegation',
      { maxRelated: 1 },
    );
    expect(found?.related).toHaveLength(1);
  });
});

describe('supersession', () => {
  it('points a live supersession at the status of the document that has to change', async () => {
    const [found] = await findings(
      {
        'docs/adr/0002-old.md': doc('accepted', '# Old'),
        'docs/adr/0003-new.md': doc('accepted', '# New', 'supersedes: ADR-0002\n'),
      },
      'live-supersession',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0002-old.md:2:9',
      message: 'ADR-0002 is superseded by ADR-0003 but still reads as active',
      nodes: ['ADR-0002', 'ADR-0003'],
      related: ['docs/adr/0003-new.md:3:13 the supersession is declared here'],
      hint: 'mark ADR-0002 as superseded, or drop the claim in ADR-0003',
    });
  });

  it('reads an unreciprocated supersession as the README prints it', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-single-writer.md': doc('retired', '# ADR-0001: Single writer'),
        'docs/adr/0002-multi-writer.md': doc('accepted', '# ADR-0002: Multi-writer', 'supersedes: ADR-0001\n'),
      },
      'unreciprocated-supersession',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0001-single-writer.md:2:9',
      message: 'ADR-0001 is retired but never says that ADR-0002 replaced it',
      nodes: ['ADR-0001', 'ADR-0002'],
      related: ['docs/adr/0002-multi-writer.md:3:13 only ADR-0002 records the relationship'],
      hint: 'add "superseded-by: ADR-0002" to docs/adr/0001-single-writer.md so a reader who lands there is redirected',
    });
  });

  it('says nothing about a superseded document with no status of its own', async () => {
    // An unrecognised status is unknown, and rules treat unknown permissively.
    const found = await analyse({
      'docs/adr/0002-old.md': '# Old\n',
      'docs/adr/0003-new.md': doc('accepted', '# New', 'supersedes: ADR-0002\n'),
    });
    expect(found.diagnostics).toEqual([]);
  });

  it('says nothing, and does not fail, for a supersession that names a question', async () => {
    const found = await analyse({
      'docs/adr/0002-rows.md': doc('accepted', '# Rows\n\n## Open Questions\n\n<!-- @spec-item id="row-cap" -->\n- [ ] Do we need a row cap?'),
      'docs/adr/0005-export.md': doc('accepted', '# Export\n\n<!-- @spec-edge kind="supersedes" to="ADR-0002#row-cap" -->'),
    });
    expect(found.diagnostics.filter((diagnostic) => diagnostic.rule.includes('supersession'))).toEqual([]);
  });
});

describe('state-conflict', () => {
  it('names the one signal that disagrees, as written', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc('accepted', '# A\n\n## Open Questions\n\n- [ ] Should we shard?\n  **Resolved:** no.'),
      },
      'state-conflict',
    );
    expect(read(found)).toEqual({
      at: 'docs/adr/0001-a.md:10:5',
      message: 'item reads as satisfied but also carries a checkbox saying unresolved',
      nodes: ['ADR-0001#open-questions.1'],
      related: ['docs/adr/0001-a.md:9:3 checkbox says unresolved: [ ]'],
      hint: 'make the two agree - spec-graph is treating it as closed',
    });
  });

  it('lists several in the order they were written', async () => {
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc(
          'accepted',
          '# A\n\n## Open Questions\n\n<!-- @spec-item state="open" -->\n- [x] ~~Ship the export~~\n  **Resolved:** in #412.',
        ),
      },
      'state-conflict',
    );
    expect(read(found).message).toBe(
      'item reads as unresolved but also carries a marker saying satisfied, a strikethrough saying satisfied and a checkbox saying satisfied',
    );
    expect(read(found).related.map((entry) => entry.replace(/^\S+ /, ''))).toEqual([
      'marker says satisfied: Resolved',
      'strikethrough says satisfied: ~~Ship the export~~',
      'checkbox says satisfied: [x]',
    ]);
  });
});

describe('self-reference', () => {
  const files = {
    'docs/adr/0001-a.md': doc(
      'accepted',
      [
        '# A',
        '',
        'See [this document](0001-a.md) for the terms used here.',
        '',
        '## Open Questions',
        '',
        '- [ ] Who owns this? Deferred to [ADR-0001](0001-a.md).',
      ].join('\n'),
      'depends-on: ADR-0001\n',
    ),
  };

  it('tells a delegation to keep the work, and a dependency to go, and ignores a plain link', async () => {
    // A dependency on another document is not one on itself.
    const found = await findings(
      { ...files, 'docs/adr/0002-b.md': doc('accepted', '# B', 'depends-on: ADR-0001\n') },
      'self-reference',
    );
    expect(found.map((diagnostic) => [diagnostic.message, diagnostic.hint])).toEqual([
      ['ADR-0001 depends on itself', 'a document cannot depend on itself - repoint or remove the reference'],
      [
        'ADR-0001 "Who owns this? Deferred to ADR-0001." delegates to itself',
        'this obligation looks delegated but never left - point it at another document, or own it here',
      ],
    ]);
  });

  it('shortens a long obligation to what fits', async () => {
    const long = files['docs/adr/0001-a.md'].replace(
      'Who owns this?',
      'Who owns the retention policy for the export tables once they move?',
    );
    const found = await findings({ 'docs/adr/0001-a.md': long }, 'self-reference');
    expect(found[1]?.message).toBe('ADR-0001 "Who owns the retention policy for the export ..." delegates to itself');
  });
});

describe('a project rule', () => {
  it('names each relation after the first in a path, where it was declared', async () => {
    const { compileProjectRules } = await import('../src/project-rules.js');
    const { rules } = compileProjectRules(
      {
        'no-chain': {
          query: 'document -depends-on-> document -depends-on-> document',
          message: '{0} rests on {2} through {1}',
        },
      },
      '.spec-graph.json',
    );
    const [found] = await findings(
      {
        'docs/adr/0001-a.md': doc('accepted', '# A', 'depends-on: ADR-0002\n'),
        'docs/adr/0002-b.md': doc('accepted', '# B', 'depends-on: ADR-0003\n'),
        'docs/adr/0003-c.md': doc('accepted', '# C'),
      },
      'project:no-chain',
      { projectRules: rules },
    );
    expect(read(found)).toMatchObject({
      at: 'docs/adr/0001-a.md:3:13',
      message: 'ADR-0001 rests on ADR-0003 through ADR-0002',
      related: ['docs/adr/0002-b.md:3:13 ADR-0002 depends on ADR-0003'],
    });
  });
});

/* -------------------------------------------------------------------------- */

describe('the selector a rule is', () => {
  async function explain(rule: string): Promise<string> {
    const { main } = await import('../src/cli.js');
    let out = '';
    await main({
      argv: ['rules', rule, '--explain'],
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
      env: { NO_COLOR: '1' },
      isTTY: false,
    });
    return out;
  }

  it('is printed for stale-premise as ADR-0005 writes it, and finds what the rule finds', async () => {
    const adr = readFileSync('docs/adr/0005-rules-are-queries.md', 'utf8');
    const selector = /^stale-premise\s+(.+)$/m.exec(adr)?.[1] as string;
    expect(await explain('stale-premise')).toContain(selector);

    const { query } = await import('../src/select.js');
    const result = await analyse({
      'docs/adr/0002-old.md': doc('retired', '# Old'),
      'docs/adr/0004-new.md': doc('accepted', '# New', 'depends-on: ADR-0002\n'),
    });
    const found = result.diagnostics.filter((diagnostic) => diagnostic.rule === 'stale-premise');
    expect(query(result.graph, selector).map((match) => match.nodes.map((node) => node.id))).toEqual(
      found.map((diagnostic) => diagnostic.nodes),
    );
  });

  it('is printed for orphaned-obligation as the README asks the question', async () => {
    const readme = readFileSync('README.md', 'utf8');
    const selector = /# What open work is stranded in documents nobody reads\?\nspec-graph query '([^']+)'/.exec(readme)?.[1];
    expect(selector).toBeDefined();
    expect(await explain('orphaned-obligation')).toContain(selector as string);
  });

  it('is replaced for self-reference by why it is not one', async () => {
    // ADR-0005: reflexive edges are excluded from traversal by default.
    expect(await explain('self-reference')).toContain('reflexive edges are excluded from traversal by default');
  });
});

describe('strict', () => {
  it('raises nothing unless it is asked to', async () => {
    const { resolveStrict } = await import('../src/rules.js');
    const unasked = resolveStrict({ 'self-reference': 'off' });
    expect([unasked.severities, [...unasked.escalated]]).toEqual([{ 'self-reference': 'off' }, []]);
    expect(resolveStrict({}, true).escalated).toContain('state-conflict');
  });
});

describe('the order findings are reported in', () => {
  it('is the same whatever order they were found in', async () => {
    const { sortDiagnostics } = await import('../src/rules.js');
    const at = (file: string, line: number, column: number): Diagnostic['at'] =>
      ({ file, span: { start: { line, column, offset: 0 }, end: { line, column, offset: 0 } } }) as Diagnostic['at'];
    const finding = (rule: AnyRuleId, file: string, message: string, line = 3): Diagnostic => ({
      rule,
      severity: 'error',
      message,
      at: at(file, line, 1),
      nodes: [],
      related: [],
      hint: '',
      target: null,
    });
    const found = [
      finding('stale-premise', 'docs/adr/0002-b.md', 'b'),
      finding('ghost-handover', 'docs/adr/0002-b.md', 'b'),
      finding('ghost-handover', 'docs/adr/0002-b.md', 'a'),
      finding('ghost-handover', 'docs/adr/0001-a.md', 'z'),
      finding('ghost-handover', 'docs/adr/0001-a.md', 'z', 9),
    ];
    const expected = ['0001-a.md:3 ghost-handover z', '0001-a.md:9 ghost-handover z', '0002-b.md:3 ghost-handover a', '0002-b.md:3 ghost-handover b', '0002-b.md:3 stale-premise b'];
    const label = (diagnostic: Diagnostic): string =>
      `${diagnostic.at.file.slice('docs/adr/'.length)}:${diagnostic.at.span.start.line} ${diagnostic.rule} ${diagnostic.message}`;
    // Every rotation and its reverse: a comparator that is not total fails one.
    for (let shift = 0; shift < found.length; shift += 1) {
      const rotated = [...found.slice(shift), ...found.slice(0, shift)];
      expect(sortDiagnostics(rotated).map(label)).toEqual(expected);
      expect(sortDiagnostics([...rotated].reverse()).map(label)).toEqual(expected);
    }
  });
});
