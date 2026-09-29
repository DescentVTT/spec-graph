import { describe, expect, it } from 'vitest';

import { analyseSources, type Source } from '../src/runner.js';

/**
 * A status given by a table at the top of a document.
 *
 * `| 狀態 | 已接受 |` under the title is where many teams put a document's
 * fields. The README reads it narrowly (ADR-0002): a table of exactly two
 * columns, above the first heading below the title, whose left cell is a
 * status key, the header row included. A legend, a register and a table of
 * anything else are not the document's own status. Every document is made up
 * for the test.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every document, as `id phase "raw status"`. */
function statuses(files: Record<string, string>): string[] {
  return analyse(files).graph.documents.map((document) => `${document.id} ${document.phase} ${JSON.stringify(document.rawStatus)}`);
}

const one = (text: string): string[] => statuses({ 'docs/adr/0001-a.md': text });

describe('a two-column table above the first section', () => {
  it('gives the right cell of the header row when its left cell is a status key', () => {
    expect(one('# ADR-0001 A\n\n| 狀態 | 已接受 |\n| --- | --- |\n| 日期 | 2026-09-30 |\n\n## 背景\n')).toEqual(['ADR-0001 active "已接受"']);
  });

  it('gives the right cell of a row below the header', () => {
    expect(one('# A\n\n| Field | Value |\n| --- | --- |\n| Owner | Platform |\n| Status | Superseded |\n')).toEqual([
      'ADR-0001 retired "Superseded"',
    ]);
  });

  it('reads a key in any case and with emphasis, and nothing that only contains one', () => {
    expect(one('# A\n\n| **STATUS** | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 active "Accepted"']);
    expect(one('# A\n\n| _状态_ | 草案 |\n| --- | --- |\n')).toEqual(['ADR-0001 draft "草案"']);
    expect(one('# A\n\n| Status: | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n| Current status | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n| Stage | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
  });

  it('points a finding about the status at the cell', () => {
    const { diagnostics } = analyse({
      'docs/adr/0002-b.md': '# B\n\n| Status | Accepted |\n| --- | --- |\n\n## Context\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# C\n',
    });
    expect(diagnostics.map((d) => `${d.rule} ${d.at.file}:${d.at.span.start.line}:${d.at.span.start.column}`)).toEqual([
      'live-supersession docs/adr/0002-b.md:3:12',
    ]);
  });

  it('names the successor a supersession in the cell gives', () => {
    const { graph, diagnostics } = analyse({
      'docs/adr/0002-b.md': '# B\n\n| 狀態 | 已被 ADR-0003 取代 |\n| --- | --- |\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# C\n',
    });
    expect(graph.document('ADR-0002')?.phase).toBe('retired');
    expect(diagnostics.map((d) => d.rule)).toEqual([]);
  });

  it('skips a row that says nothing on the right, and one written short', () => {
    expect(one('# A\n\n| Status | |\n| --- | --- |\n| State | Draft |\n')).toEqual(['ADR-0001 draft "Draft"']);
    expect(one('# A\n\n| Field | Value |\n| --- | --- |\n| Status |\n| State | Draft |\n')).toEqual(['ADR-0001 draft "Draft"']);
    expect(one('# A\n\n| Status | |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
  });
});

describe('what ranks above a table', () => {
  it('is front matter', () => {
    expect(one('---\nstatus: draft\n---\n\n# A\n\n| Status | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 draft "draft"']);
  });

  it('is a status section, which a document with both is read from', () => {
    expect(one('# A\n\n| Status | Draft |\n| --- | --- |\n\n## Status\n\nAccepted\n')).toEqual(['ADR-0001 active "Accepted"']);
    // A section with nothing in it gives nothing, and the table is read.
    expect(one('# A\n\n| Status | Draft |\n| --- | --- |\n\n## Status\n\n## Context\n')).toEqual(['ADR-0001 draft "Draft"']);
  });
});

describe('a table that is never read for the status', () => {
  it('is one under a section heading, such as a legend', () => {
    expect(
      one('# A\n\n## Legend\n\n| Status | Meaning |\n| --- | --- |\n| Accepted | in force |\n| Status | Accepted |\n'),
    ).toEqual(['ADR-0001 unknown null']);
  });

  it('is one under any heading below the title, `###` included', () => {
    expect(one('# A\n\n### Fields\n\n| Status | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
  });

  it('is one of three columns', () => {
    expect(one('# A\n\n| 欄位 | 值 | 備註 |\n| --- | --- | --- |\n| 狀態 | 已接受 | 無 |\n\n## 背景\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n| Status | Accepted | 2026-09-30 |\n| --- | --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
  });

  it('is a register, whose rows keep their own statuses', () => {
    // Two columns, and the left header a status key: a register all the same.
    expect(
      statuses({ 'docs/register.md': '---\nid: REG-1\n---\n\n# Register\n\n| Status | ID |\n| --- | --- |\n| Accepted | ADR-0001 |\n' }),
    ).toEqual(['REG-1 unknown null', 'ADR-0001 active "Accepted"']);
    expect(
      statuses({
        'docs/register.md':
          '---\nid: REG-1\n---\n\n# Register\n\n| ID | Title | Status |\n| --- | --- | --- |\n| ADR-0001 | One writer | Superseded |\n',
      }),
    ).toEqual(['REG-1 unknown null', 'ADR-0001 retired "Superseded"']);
  });

  it('is one after the first table that gives a status', () => {
    expect(one('# A\n\n| State | Draft |\n| --- | --- |\n\n| Status | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 draft "Draft"']);
  });
});
