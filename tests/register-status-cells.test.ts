import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * What a register row's status cell says about other documents.
 *
 * "A register kept as a table works the same way" as one kept under headings
 * (README), and `Superseded by ADR-0002` is "the single most common way a
 * supersession is ever recorded" (lifecycle.ts). Written in a row's status
 * cell it names the row's successor exactly as it does on a status line under
 * a heading (ADR-0009).
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every relation but containment, as `from kind to @line`. */
function relations(files: Record<string, string>): string[] {
  return analyse(files)
    .graph.edges.filter((edge) => edge.kind !== 'contains')
    .map((edge) => `${edge.from} ${edge.kind} ${edge.to} @${edge.declaredAt.span.start.line}`);
}

const table = (...rows: string[]): string =>
  ['# Register', '', '| ID | Title | Status |', '| --- | --- | --- |', ...rows].join('\n');

const headings = (...sections: [string, string][]): string =>
  ['# Register', ...sections.flatMap(([heading, status]) => ['', `## ${heading}`, '', `**Status:** ${status}`])].join(
    '\n',
  );

describe('a status cell that names a successor', () => {
  it('records the supersession, at the row', () => {
    expect(
      relations({
        'docs/register.md': table('| ADR-0001 | One writer | Superseded by ADR-0002 |', '| ADR-0002 | Two writers | Accepted |'),
      }),
    ).toEqual(['ADR-0002 supersedes ADR-0001 @5']);
  });

  it('records what the same words under a heading record', () => {
    const asTable = relations({
      'docs/register.md': table('| ADR-0001 | One writer | Superseded by ADR-0002 |', '| ADR-0002 | Two writers | Accepted |'),
    });
    const asHeadings = relations({
      'docs/register.md': headings(['ADR-0001: One writer', 'Superseded by ADR-0002'], ['ADR-0002: Two writers', 'Accepted']),
    });
    expect(asTable.map((edge) => edge.replace(/ @\d+$/, ''))).toEqual(asHeadings.map((edge) => edge.replace(/ @\d+$/, '')));
  });

  it('reads a linked successor by where the link goes', () => {
    expect(
      relations({
        'docs/register.md': table('| ADR-0001 | One writer | Superseded by [the new design](adr/0002-two.md) |'),
        'docs/adr/0002-two.md': '---\nstatus: accepted\n---\n\n# Two writers\n',
      }),
    ).toEqual(['ADR-0002 supersedes ADR-0001 @5']);
  });

  it('retires the row, and leaves nothing for unreciprocated-supersession to say', () => {
    const { graph, diagnostics } = analyse({
      'docs/register.md': table('| ADR-0001 | One writer | Superseded by ADR-0002 |', '| ADR-0002 | Two writers | Accepted |'),
    });
    expect(graph.document('ADR-0001')?.phase).toBe('retired');
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([]);
  });

  it('is a broken reference when the successor does not exist, as under a heading', () => {
    const findings = (files: Record<string, string>) =>
      analyse(files).diagnostics.map((diagnostic) => `${diagnostic.rule} ${diagnostic.message} @${diagnostic.at.span.start.line}`);
    expect(findings({ 'docs/register.md': table('| ADR-0001 | One writer | Superseded by ADR-0009 |') })).toEqual([
      'broken-reference "ADR-0009" does not resolve to any document @5',
    ]);
    expect(findings({ 'docs/register.md': headings(['ADR-0001: One writer', 'Superseded by ADR-0009']) })).toEqual([
      'broken-reference "ADR-0009" does not resolve to any document @5',
    ]);
  });

  it('is one relation beside a column that says the same', () => {
    const { graph } = analyse({
      'docs/register.md': [
        '# Register',
        '',
        '| ID | Status | Superseded by |',
        '| --- | --- | --- |',
        '| ADR-0001 | Superseded by ADR-0002 | ADR-0002 |',
        '| ADR-0002 | Accepted | - |',
      ].join('\n'),
    });
    expect(graph.edges.filter((edge) => edge.kind === 'supersedes').map((edge) => `${edge.from} > ${edge.to}`)).toEqual([
      'ADR-0002 > ADR-0001',
    ]);
  });
});

describe('a status cell that names nobody', () => {
  it.each(['Accepted', 'Superseded', 'Superseded (2026-03-01)', '-'])('records no relation: %s', (status) => {
    expect(relations({ 'docs/register.md': table(`| ADR-0001 | One writer | ${status} |`, '| ADR-0002 | Two writers | Accepted |') })).toEqual(
      [],
    );
  });

  it('still names its own row by the ID cell alone', () => {
    // The ID cell is the row's name, not a citation of it.
    expect(analyse({ 'docs/register.md': table('| ADR-0001 | One writer | Accepted |') }).diagnostics).toEqual([]);
  });
});
