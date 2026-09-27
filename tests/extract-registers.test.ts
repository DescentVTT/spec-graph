import { describe, expect, it } from 'vitest';

import { extractSpecifications, type ExtractedDocument } from '../src/extract.js';
import { query } from '../src/select.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { SourceRef, SpecNode } from '../src/types.js';

/**
 * What extraction decides for each specification a register holds: its name,
 * its lifecycle, where it is anchored, the anchors it answers to, and which of
 * the file's relations and obligations are its own. See ADR-0009.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

const specsOf = (path: string, text: string): ExtractedDocument[] => extractSpecifications({ path, text });

const byId = (specs: readonly ExtractedDocument[], id: string): ExtractedDocument => {
  const found = specs.find((spec) => spec.document.id === id);
  if (!found) throw new Error(`no specification ${id} in ${specs.map((spec) => spec.document.id).join(', ')}`);
  return found;
};

const covered = (text: string, at: SourceRef): string => text.slice(at.span.start.offset, at.span.end.offset);

const REGISTER = [
  '# Decision register',
  '',
  'The register cites [ADR-0100](0100-charter.md) on its own behalf.',
  '',
  '## ADR-0007: Shard the write path',
  '',
  '**Status:** accepted',
  '',
  'This depends on [ADR-0101](0101-storage.md).',
  '',
  '### Rationale',
  '',
  'Tenants never share a shard.',
  '',
  '## ADR-0008: Cache eviction',
  '',
  '**Status:** accepted',
  '',
  '### Alternatives',
  '',
  'LRU and LFU were both measured.',
].join('\n');

describe('a section of a register', () => {
  it('is anchored at its heading, and at nothing below it', () => {
    // A finding about the section points at the heading line, start and end,
    // as a SARIF region reads it.
    const spec = byId(specsOf('docs/register.md', REGISTER), 'ADR-0007');
    expect(covered(REGISTER, spec.document.at)).toBe('## ADR-0007: Shard the write path');
  });

  it('keeps the relations written inside it, and the file keeps the ones written above every section', () => {
    const specs = specsOf('docs/register.md', REGISTER);
    // Links only: each section's heading also names it, which is a bare
    // mention of itself and not a relation.
    const targets = (id: string) =>
      byId(specs, id)
        .references.filter((reference) => reference.origin === 'link')
        .map((reference) => reference.target);
    expect(targets('register')).toEqual(['0100-charter.md']);
    expect(targets('ADR-0007')).toEqual(['0101-storage.md']);
    expect(targets('ADR-0008')).toEqual([]);
  });

  it('holds no specification of its own: every section is listed at the file', () => {
    const specs = specsOf('docs/register.md', REGISTER);
    expect(specs.map((spec) => spec.document.id)).toEqual(['register', 'ADR-0007', 'ADR-0008']);
    expect(specs.slice(1).map((spec) => spec.subSpecifications)).toEqual([[], []]);
  });
});

describe('a status section inside a section of a register', () => {
  const HEADED = [
    '# Decision register',
    '',
    '## Open Questions',
    '',
    '- [ ] Who owns the register?',
    '',
    '## ADR-0007: Shard the write path',
    '',
    '### Status',
    '',
    'Superseded by ADR-0009',
    '',
    '## ADR-0009: Many writers',
    '',
    '### Status',
    '',
    'Accepted',
  ].join('\n');

  it('is the status of that section', () => {
    const specs = specsOf('docs/register.md', HEADED);
    expect(byId(specs, 'ADR-0007').document.phase).toBe('retired');
    expect(byId(specs, 'ADR-0009').document.phase).toBe('active');
  });

  it('is not the status of the file, which a decision inside it cannot retire', () => {
    const file = byId(specsOf('docs/register.md', HEADED), 'register');
    expect([file.document.rawStatus, file.document.phase]).toEqual([null, 'unknown']);
    const { graph, diagnostics } = analyse({ 'docs/register.md': HEADED });
    const supersessions = graph.edges.filter((edge) => edge.kind === 'supersedes');
    expect(supersessions.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(['ADR-0009 -> ADR-0007']);
    // The register's own open question was an orphaned obligation while the
    // register read as retired.
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([]);
  });

  it('leaves the file its own status section, written above every section', () => {
    const text = HEADED.replace('# Decision register\n', '# Decision register\n\n## Status\n\nAccepted\n');
    expect(byId(specsOf('docs/register.md', text), 'register').document.phase).toBe('active');
  });
});

describe('the anchors a section answers to', () => {
  // A citation of `ADR-0007#rationale` names a heading inside ADR-0007, which a
  // register holds as a region rather than a file.
  const citing = (anchor: string, section = 'ADR-0007') =>
    analyse({
      'docs/register.md': REGISTER,
      'docs/adr/0001-citing.md': `# Citing\n\nSee [[${section}#${anchor}]].\n`,
    })
      .corpus.dangling.filter((ref) => ref.from === 'ADR-0001')
      .map((ref) => ref.reason);

  it('include its own heading and every heading inside it', () => {
    expect(citing('adr-0007-shard-the-write-path')).toEqual([]);
    expect(citing('rationale')).toEqual([]);
  });

  it('exclude the headings of the file above it, and of the section after it', () => {
    expect(citing('decision-register')).toEqual(['unknown-anchor']);
    expect(citing('adr-0008-cache-eviction')).toEqual(['unknown-anchor']);
    expect(citing('alternatives')).toEqual(['unknown-anchor']);
  });

  it('exclude the headings of the section before it', () => {
    expect(citing('rationale', 'ADR-0008')).toEqual(['unknown-anchor']);
  });
});

describe('a section a @spec-node declares', () => {
  const NOTES = (directive: string) =>
    ['# Notes', '', '## ADR-0009: Something', '', directive, '', 'Words.'].join('\n');

  it('takes its title from the directive', () => {
    const spec = byId(specsOf('docs/notes.md', NOTES('<!-- @spec-node title="Sharding" -->')), 'ADR-0009');
    expect(spec.document.title).toBe('Sharding');
  });

  it('answers to the aliases the directive gives it', () => {
    const { graph } = analyse({
      'docs/notes.md': NOTES('<!-- @spec-node aliases="sharding" -->'),
      'docs/adr/0001-citing.md': '# Citing\n\nSee [[sharding]].\n',
    });
    expect(graph.out('ADR-0001').map((edge) => edge.to)).toEqual(['ADR-0009']);
  });

  it('with no status of its own takes its phase from where the file is kept', () => {
    // "a document under an `archive/` directory that says nothing about itself
    // is still retired" (README) - and a section is a document.
    const spec = byId(specsOf('docs/adr/archive/notes.md', NOTES('<!-- @spec-node title="Sharding" -->')), 'ADR-0009');
    expect([spec.document.rawStatus, spec.document.phase]).toEqual([null, 'retired']);
  });

  it('with a status nobody recognises takes its phase from where the file is kept, too', () => {
    const spec = byId(specsOf('docs/adr/archive/notes.md', NOTES('<!-- @spec-node status="parked" -->')), 'ADR-0009');
    expect([spec.document.rawStatus, spec.document.phase]).toEqual(['parked', 'retired']);
  });
});

describe('a register kept as a table', () => {
  const TABLE = [
    '# Decision table',
    '',
    'Before the table, the file cites [ADR-0100](0100-charter.md).',
    '',
    '| ID | Status | Depends on |',
    '| :- | :----- | :--------- |',
    '| ADR-0001 | accepted | [ADR-0099](0099-missing.md) |',
    '| ADR-0002 | accepted | ADR-0098 |',
    '',
    'After it, the file cites [ADR-0101](0101-storage.md).',
  ].join('\n');

  it('reports a relation column naming nothing, because the header made it deliberate', () => {
    // "Deliberate references are validated" (README), and a typed column is as
    // deliberate as front matter: its targets are not opportunistic prose.
    const { corpus } = analyse({ 'docs/register.md': TABLE });
    expect(corpus.dangling.map((ref) => `${ref.from} ${ref.kind} ${ref.target}`).sort()).toEqual([
      'ADR-0001 depends-on 0099-missing.md',
      'ADR-0002 depends-on ADR-0098',
      'register references 0100-charter.md',
      'register references 0101-storage.md',
    ]);
  });

  it('reads a link in a relation column once, as the relation, and a link beside the table as prose', () => {
    const specs = specsOf('docs/register.md', TABLE);
    const kinds = (id: string) =>
      byId(specs, id).references.map((reference) => `${reference.kind} ${reference.target}`);
    expect(kinds('ADR-0001')).toEqual(['depends-on 0099-missing.md']);
    expect(kinds('register')).toEqual(['references 0100-charter.md', 'references 0101-storage.md']);
  });

  it('records the column and the target as the text that declared a column relation', () => {
    const [relation] = byId(specsOf('docs/register.md', TABLE), 'ADR-0002').references;
    expect(relation?.raw).toBe('Depends on: ADR-0098');
  });
});

describe('the front matter a section does not inherit', () => {
  it('leaves the file its aliases, which name the file and not the decisions in it', () => {
    const files = {
      'docs/register.md': [
        '---',
        'alias: decision-log',
        'aliases: [decisions]',
        'owner: platform',
        '---',
        '',
        '# Register',
        '',
        '## DEC-0001 Use Postgres',
        '',
        'Status: accepted',
      ].join('\n'),
    };
    const { graph } = analyse(files);
    const matching = (selector: string) =>
      query(graph, selector)
        .map((match) => (match.nodes[0] as SpecNode).id)
        .sort();
    expect(matching('document[fm.alias]')).toEqual(['register']);
    expect(matching('document[fm.aliases]')).toEqual(['register']);
    expect(matching('document[fm.owner=platform]')).toEqual(['DEC-0001', 'register']);
  });
});

describe('what a file keeps when no section holds it', () => {
  it('keeps the obligations and relations written outside every section', () => {
    const text = [
      '# Register',
      '',
      '## Open Questions',
      '',
      '- [ ] Who owns the register? Deferred to [ADR-0102](0102-owners.md).',
      '',
      '## ADR-0007: Shard the write path',
      '',
      '**Status:** accepted',
      '',
      '- [ ] Which shard key?',
    ].join('\n');
    const specs = specsOf('docs/register.md', text);
    const file = byId(specs, 'register');
    expect(file.items.map((item) => item.text)).toEqual(['Who owns the register? Deferred to ADR-0102.']);
    expect(file.references.map((reference) => [reference.from, reference.target])).toEqual([
      ['register#open-questions.1', '0102-owners.md'],
    ]);
    expect(byId(specs, 'ADR-0007').items.map((item) => item.text)).toEqual(['Which shard key?']);
  });
});
