import { describe, expect, it } from 'vitest';

import { extractSpecifications, type ExtractedDocument } from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';

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
