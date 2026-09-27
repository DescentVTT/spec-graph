import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * A sealed document whose open question went on to a document still taking work.
 *
 * `orphaned-obligation` is "a retired or frozen document still holding open
 * work" (README), and its hint says to move each item to a live document or
 * close it. An item delegated to a live document has been moved: the question
 * lives on there. Delegated into another sealed document, it disappears all
 * the same, and no ghost handover says so - that rule leaves a retired source
 * out.
 */

const analyse = (files: Record<string, string>, isRecord?: (path: string) => boolean) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    isRecord === undefined ? {} : { isRecord },
  );

/** Each orphaned-obligation finding, as its message and the items it names. */
function orphans(files: Record<string, string>, isRecord?: (path: string) => boolean): { message: string; items: string[] }[] {
  return analyse(files, isRecord)
    .diagnostics.filter((diagnostic) => diagnostic.rule === 'orphaned-obligation')
    .map((diagnostic) => ({ message: diagnostic.message, items: diagnostic.nodes.slice(1) }));
}

const doc = (frontMatter: string, body: string): string => `---\n${frontMatter}\n---\n\n${body}\n`;

const questions = (title: string, ...lines: string[]): string => `# ${title}\n\n## Open Questions\n\n${lines.join('\n')}`;

const handed = (target: string, path: string): string => `- [ ] Who owns retention? Deferred to [${target}](${path}).`;

describe('an open question delegated out of a sealed document', () => {
  it.each([
    ['to the successor', 'status: superseded', doc('status: accepted\nsupersedes: ADR-0001', '# New')],
    ['to a live document that replaced nothing', 'status: superseded', doc('status: accepted', '# New')],
    ['to a draft', 'status: superseded', doc('status: proposed', '# New')],
    ['to a document that says nothing of its status', 'status: superseded', '# ADR-0002: New\n'],
    ['out of a frozen document', 'status: final', doc('status: accepted', '# New')],
  ])('is not orphaned when handed %s', (_, status, target) => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc(status, questions('Old', handed('ADR-0002', '0002-new.md'))),
        'docs/adr/0002-new.md': target,
      }),
    ).toEqual([]);
  });

  it('is not orphaned when handed to one of a live document’s items', () => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc('status: superseded', questions('Old', handed('retention', '0002-new.md#retention'))),
        'docs/adr/0002-new.md': doc(
          'status: accepted',
          '# New\n\n## Open Questions\n\n<!-- @spec-item id="retention" -->\n- [ ] Who owns retention?',
        ),
      }),
    ).toEqual([]);
  });

  it.each([
    ['another retired document', doc('status: deprecated', '# Other')],
    ['a frozen document', doc('status: final', '# Other')],
  ])('is still orphaned when handed to %s', (_, target) => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc('status: superseded', questions('Old', handed('ADR-0002', '0002-other.md'))),
        'docs/adr/0002-other.md': target,
      }),
    ).toEqual([{ message: 'retired document still holds 1 open obligation', items: ['ADR-0001#open-questions.1'] }]);
  });

  it('is still orphaned when handed to a record', () => {
    expect(
      orphans(
        {
          'docs/adr/0001-old.md': doc('status: superseded', questions('Old', handed('the journal', '../journal.md'))),
          'docs/journal.md': '# Journal\n',
        },
        (path) => path === 'docs/journal.md',
      ),
    ).toEqual([{ message: 'retired document still holds 1 open obligation', items: ['ADR-0001#open-questions.1'] }]);
  });

  it('is still orphaned when it is blocked by a live document rather than handed to one', () => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc('status: superseded', questions('Old', '- [ ] Who owns retention? Blocked by [ADR-0002](0002-new.md).')),
        'docs/adr/0002-new.md': doc('status: accepted', '# New'),
      }),
    ).toEqual([{ message: 'retired document still holds 1 open obligation', items: ['ADR-0001#open-questions.1'] }]);
  });

  it('counts only the questions that were not handed on, beside one that was', () => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc(
          'status: superseded',
          questions('Old', handed('ADR-0002', '0002-new.md'), '- [ ] Who owns backups?', '- [ ] Who owns restores?'),
        ),
        'docs/adr/0002-new.md': doc('status: accepted', '# New'),
      }),
    ).toEqual([
      {
        message: 'retired document still holds 2 open obligations',
        items: ['ADR-0001#open-questions.2', 'ADR-0001#open-questions.3'],
      },
    ]);
  });

  it('is handed on when one of its delegations lands in a live document and another does not', () => {
    expect(
      orphans({
        'docs/adr/0001-old.md': doc(
          'status: superseded',
          questions('Old', '- [ ] Who owns retention? Deferred to [ADR-0002](0002-other.md) and [ADR-0003](0003-new.md).'),
        ),
        'docs/adr/0002-other.md': doc('status: deprecated', '# Other'),
        'docs/adr/0003-new.md': doc('status: accepted', '# New'),
      }),
    ).toEqual([]);
  });
});
