import { describe, expect, it } from 'vitest';

/**
 * Extraction builds its vocabulary when the module loads.
 *
 * The module is imported inside the test, and nothing at the top of this file
 * reaches it. A vocabulary table that fails to build throws while the module
 * is being imported, which fails every file that imports it before a single
 * test exists - and the mutation runner reads a file with no tests in it as a
 * file with no failures, so a table that could not be built at all was being
 * reported as a survivor. Imported here, the failure lands inside a test.
 */
describe('extraction, loaded', () => {
  it('reads the relation examples the README gives', async () => {
    const { extractDocument } = await import('../src/extract.js');
    const extracted = extractDocument({
      path: 'docs/adr/0003-chunking.md',
      text: [
        '# Chunking',
        '',
        'The chunking scheme is constrained by [ADR-0002](0002-rows.md).',
        'Which policy? Deferred to [ADR-0011](0011-policy.md).',
        'Blocked by [ADR-0009](0009-compliance.md).',
        '',
        '## See also',
        '- [ADR-0001](0001-intro.md)',
      ].join('\n'),
    });
    expect(extracted?.references.map((reference) => [reference.target, reference.kind])).toEqual([
      ['0002-rows.md', 'assumes'],
      ['0011-policy.md', 'delegates-to'],
      ['0009-compliance.md', 'blocked-by'],
      ['0001-intro.md', 'relates-to'],
    ]);
  });
});
