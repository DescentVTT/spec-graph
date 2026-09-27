import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * Which links are citations of a specification and which are links to a file.
 *
 * "Some things are not references at all. A link to source code, an image, or
 * a directory is ordinary in a design document" (ADR-0006), and the README says
 * source links are not spec links. A link to a file that is not a document is
 * never reported as a document that does not resolve.
 */

const analyse = (files: Record<string, string>, fileExists?: (path: string) => boolean) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    fileExists === undefined ? {} : { fileExists },
  );

/** The rule and target of every finding about a reference, in order. */
function referenceFindings(files: Record<string, string>, fileExists?: (path: string) => boolean): string[] {
  return analyse(files, fileExists)
    .diagnostics.filter((diagnostic) => diagnostic.rule.includes('reference'))
    .map((diagnostic) => `${diagnostic.rule} ${diagnostic.message}`);
}

const citing = (body: string): Record<string, string> => ({
  'docs/adr/0001-a.md': `---\nstatus: accepted\n---\n\n# A\n\n${body}\n`,
});

describe('a link to a dotfile', () => {
  it.each(['../../.nvmrc', '.env.example', '../../.github/.editorconfig', '../../.nvmrc#L1'])(
    'is not a broken reference: %s',
    (target) => {
      expect(referenceFindings(citing(`Pinned in [the version file](${target}).`))).toEqual([]);
    },
  );

  it('is not a reference outside the corpus when the file is there', () => {
    expect(referenceFindings(citing('Pinned in [the version file](../../.nvmrc).'), () => true)).toEqual([]);
  });

  it('is no relation in front matter either', () => {
    const { diagnostics, graph } = analyse({ 'docs/adr/0001-a.md': '---\ndepends-on: ../../.nvmrc\n---\n\n# A\n' });
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([]);
    expect(graph.edges.filter((edge) => edge.kind !== 'contains')).toEqual([]);
  });

  it('does not make a misspelt relation key look like a citation', () => {
    // `supercedes-by` is one edit from `superceded-by`; what it carries decides.
    const rules = (value: string) =>
      analyse({ 'docs/adr/0001-a.md': `---\nsupercedes-by: ${value}\n---\n\n# A\n` }).diagnostics.map((d) => d.rule);
    expect(rules('../../.nvmrc')).toEqual([]);
    expect(rules('0002-b.md')).toEqual(['unknown-relation-key']);
  });
});

describe('a link to a file whose extension is long', () => {
  it.each(['arch.excalidraw', './diagrams/arch.excalidraw', '../model.drawio.svg', 'flows/checkout.bpmn2diagram'])(
    'is not a broken reference: %s',
    (target) => {
      expect(referenceFindings(citing(`The picture is [the diagram](${target}).`))).toEqual([]);
    },
  );

  it('binds to no document that shares its name', () => {
    const { graph } = analyse({
      ...citing('The picture is [the diagram](arch.excalidraw).'),
      'docs/adr/arch.md': '---\nstatus: accepted\n---\n\n# Architecture\n',
    });
    expect(graph.edges.filter((edge) => edge.kind === 'references')).toEqual([]);
  });
});

describe('a link to a document', () => {
  it('that does not exist is still a broken reference', () => {
    expect(referenceFindings(citing('See [the old design](0009-missing.md) and [notes](notes.markdown).'))).toEqual([
      'broken-reference "0009-missing.md" does not resolve to any document',
      'broken-reference "notes.markdown" does not resolve to any document',
    ]);
  });

  it('with no extension, or a dotted identifier, is still resolved as one', () => {
    expect(referenceFindings(citing('See [RFC 7](../rfcs/0007) and [[ADR-0009.1]].'))).toEqual([
      'broken-reference "../rfcs/0007" does not resolve to any document',
      'broken-reference "ADR-0009.1" does not resolve to any document',
    ]);
  });
});
