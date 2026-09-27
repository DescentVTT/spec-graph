import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * Where a status section ends.
 *
 * The README reads a status "under the heading": the first line beneath
 * `## Status`, unless a heading comes first, in which case the section says
 * nothing. A setext heading is a heading, though its text line starts with no
 * `#`; read as the status, it made a register's own status the title of the
 * decision after it.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every document, as `id phase "raw status"`. */
function statuses(files: Record<string, string>): string[] {
  return analyse(files).graph.documents.map((document) => `${document.id} ${document.phase} ${JSON.stringify(document.rawStatus)}`);
}

describe('a status section followed at once by a heading', () => {
  it.each([
    ['a setext heading underlined with dashes', 'ADR-0002: Two writers\n---------------------'],
    ['a setext heading underlined with equals signs', 'ADR-0002: Two writers\n====================='],
    ['an ATX heading', '## ADR-0002: Two writers'],
  ])('says nothing, when it is %s', (_, heading) => {
    expect(
      statuses({ 'docs/register.md': `# Register\n\n### Status\n\n${heading}\n\n**Status:** Accepted\n` }),
    ).toEqual(['register unknown null', 'ADR-0002 active "Accepted"']);
  });

  it('leaves a section that is only a setext heading beneath its status to be no specification', () => {
    expect(
      statuses({
        'docs/register.md': '---\nid: REG-1\n---\n\n# Register\n\n# ADR-0001: One writer\n\n### Status\n\nContext\n-------\n\nWe keep one writer.\n',
      }),
    ).toEqual(['REG-1 unknown null']);
  });
});

describe('a status section with a value', () => {
  it('reads it, whatever heading follows', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## Status\n\nAccepted\n\nContext\n-------\n\nWe keep one writer.\n' })).toEqual([
      'ADR-0001 active "Accepted"',
    ]);
  });

  it('reads it for a section of a register, under a setext heading that follows it', () => {
    expect(
      statuses({
        'docs/register.md':
          '---\nid: REG-1\n---\n\n# Register\n\n# ADR-0001: One writer\n\n### Status\n\nSuperseded\n\nContext\n-------\n\nWe keep one writer.\n',
      }),
    ).toEqual(['REG-1 unknown null', 'ADR-0001 retired "Superseded"']);
  });

  it('reads a line that starts with a hash and is not a heading', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## Status\n\n#accepted\n' })).toEqual(['ADR-0001 active "#accepted"']);
  });
});
