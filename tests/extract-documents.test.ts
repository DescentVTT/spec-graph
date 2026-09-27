import { describe, expect, it } from 'vitest';

import { extractDocument, extractSpecifications, type ExtractedDocument } from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { SourceRef } from '../src/types.js';

/**
 * What extraction decides about a whole file: its name, its status, its title,
 * and the problems with its text a reader should hear about.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** The file's own specification. None of these documents opts out. */
function extract(path: string, text: string): ExtractedDocument {
  const extracted = extractDocument({ path, text });
  if (extracted === null) throw new Error(`${path} opted out`);
  return extracted;
}

/** The text a source reference covers. */
const covered = (text: string, at: SourceRef | null | undefined): string | undefined =>
  at ? text.slice(at.span.start.offset, at.span.end.offset) : undefined;

/** Where every citation of ADR-0042's aliases, written in another file, lands. */
function citationsLand(target: string, files: Record<string, string>): string[] {
  const { graph } = analyse({ ...files, 'docs/adr/0001-citing.md': `# Citing\n\nSee [[${target}]].\n` });
  return graph.out('ADR-0001').map((edge) => edge.to);
}

describe('a @spec-node written for the whole file', () => {
  // "A directive always wins" (README, Directives).
  const TEXT = [
    '---',
    'status: proposed',
    'title: A title the directive replaces',
    '---',
    '',
    '<!-- @spec-node id="ADR-0042" status="accepted" title="Shard the write path" -->',
    '',
    '# Notes on sharding',
    '',
    'Words.',
  ].join('\n');

  it('names the file', () => {
    expect(extract('docs/notes/sharding.md', TEXT).document.id).toBe('ADR-0042');
  });

  it('gives it a status that outranks its front matter', () => {
    const { document } = extract('docs/notes/sharding.md', TEXT);
    expect([document.rawStatus, document.phase]).toEqual(['accepted', 'active']);
    expect(covered(TEXT, document.statusAt)).toBe('accepted');
  });

  it('gives it a title that outranks its front matter', () => {
    expect(extract('docs/notes/sharding.md', TEXT).document.title).toBe('Shard the write path');
  });

  it('can carry a status and no id', () => {
    const { document } = extract('docs/adr/0042-shard.md', '<!-- @spec-node status="accepted" -->\n\n# Shard\n');
    expect([document.id, document.phase]).toEqual(['ADR-0042', 'active']);
  });

  it('can carry aliases and no id, and a citation of one lands on the file', () => {
    const files = { 'docs/adr/0042-shard.md': '<!-- @spec-node aliases="sharding" -->\n\n# Shard\n' };
    expect(citationsLand('sharding', files)).toEqual(['ADR-0042']);
  });

  it('can rename a file whose H1 then names what it renamed it to', () => {
    // The file name says ADR-0007 and the directive says ADR-0042. Once the
    // directive has spoken, the H1 names the file - it is the file's title, and
    // not a section of the file declaring a second ADR-0042.
    const specs = extractSpecifications({
      path: 'docs/adr/0007-sharding.md',
      text: '<!-- @spec-node id="ADR-0042" -->\n\n# ADR-0042: Shard the write path\n\n**Status:** accepted\n',
    });
    expect(specs.map((spec) => spec.document.id)).toEqual(['ADR-0042']);
  });

  it('is found wherever outside the sections of a register it is written', () => {
    const before = [
      '<!-- @spec-node id="REG-0001" -->',
      '',
      '# Decision register',
      '',
      '## ADR-0007: Shard the write path',
      '',
      '**Status:** accepted',
    ].join('\n');
    const after = [
      '# Decision register',
      '',
      '## ADR-0007: Shard the write path',
      '',
      '**Status:** accepted',
      '',
      '## Appendix',
      '',
      '<!-- @spec-node id="REG-0001" -->',
    ].join('\n');
    for (const text of [before, after]) {
      const ids = extractSpecifications({ path: 'docs/register.md', text }).map((spec) => spec.document.id);
      expect(ids).toEqual(['REG-0001', 'ADR-0007']);
    }
  });

  it('does not name the file from inside a row of a register', () => {
    const text = [
      '# Register',
      '',
      '| ID | Status | Note |',
      '| :- | :----- | :--- |',
      '| ADR-0001 | accepted | <!-- @spec-node id="REG-0009" --> reviewed |',
    ].join('\n');
    expect(extractSpecifications({ path: 'docs/register.md', text }).map((spec) => spec.document.id)).toEqual([
      'register',
      'ADR-0001',
    ]);
  });
});

describe('a directive that is not a @spec-node', () => {
  it('does not name the file, even when it carries an id', () => {
    const text = '# Plan\n\n## Open Questions\n\n<!-- @spec-item id="shard-key" -->\n- [ ] Which shard key?\n';
    expect(extract('docs/notes/plan.md', text).document.id).toBe('plan');
  });
});

describe('a file named by its front matter', () => {
  it('answers to an alias written singular, as well as a list of them', () => {
    const files = { 'docs/adr/0042-shard.md': '---\nalias: blueprint\naliases: [roadmap]\n---\n\n# Shard\n' };
    expect(citationsLand('blueprint', files)).toEqual(['ADR-0042']);
    expect(citationsLand('roadmap', files)).toEqual(['ADR-0042']);
  });
});

describe('a front-matter value read as a name or a title', () => {
  it('is the first entry of a list', () => {
    const text = '---\nid: [ADR-0042]\ntitle: [Shard the write path]\n---\n\n# Notes\n';
    const { document } = extract('docs/notes/sharding.md', text);
    expect([document.id, document.title]).toEqual(['ADR-0042', 'Shard the write path']);
  });

  it('is nothing when the list is empty, and the next place is asked', () => {
    const { document } = extract('docs/adr/0042-shard.md', '---\nid: []\ntitle: []\n---\n\n# Shard\n');
    expect([document.id, document.title]).toEqual(['ADR-0042', 'Shard']);
  });

  it('is nothing when it is blank, and the next key is asked', () => {
    const text = '---\nid: ""\nadr: ADR-0042\ntitle: "  "\n---\n\n# Shard\n';
    const { document } = extract('docs/notes/sharding.md', text);
    expect([document.id, document.title]).toEqual(['ADR-0042', 'Shard']);
  });

  it('is read without the spaces its quotes kept', () => {
    const { document } = extract('docs/adr/0042-shard.md', '---\ntitle: "  Shard the write path  "\n---\n');
    expect(document.title).toBe('Shard the write path');
  });
});

describe('a title', () => {
  it('comes from the H1 and from no other heading', () => {
    const { document } = extract('docs/notes/plan.md', '## Background\n\nWords.\n\n# Plan for the migration\n');
    expect(document.title).toBe('Plan for the migration');
  });

  it('falls back to the id when the file has no H1', () => {
    expect(extract('docs/notes/plan.md', '## Background\n\nWords.\n').document.title).toBe('plan');
  });
});

describe('a status', () => {
  it('reads every entry of a list, so a retirement word among them retires the file', () => {
    // "retirement is terminal, so a retirement word anywhere wins" (README).
    const { document } = extract('docs/adr/0001-a.md', '---\nstatus: [accepted, superseded]\n---\n\n# A\n');
    expect([document.rawStatus, document.phase]).toEqual(['accepted, superseded', 'retired']);
  });

  it('is not read from a front-matter field left blank, but from where the document does say it', () => {
    for (const blank of ['""', '"   "']) {
      const text = `---\nstatus: ${blank}\n---\n\n# A\n\n## Status\n\nAccepted\n`;
      expect(extract('docs/adr/0001-a.md', text).document.phase, blank).toBe('active');
    }
  });

  it('is the first line of a status section, pointed at where it is written', () => {
    const text = '# A\n\n## Status\n\n   Accepted\n';
    const { document } = extract('docs/adr/0001-a.md', text);
    expect(document.rawStatus).toBe('Accepted');
    expect(covered(text, document.statusAt)).toBe('Accepted');
  });

  it('is the first entry of a status history kept as a list, without its bullet', () => {
    for (const bullet of ['-', '*', '+', '-  ']) {
      const text = `# A\n\n## Status\n\n${bullet} Accepted (2026-03-01)\n- Proposed (2026-02-01)\n`;
      const { document } = extract('docs/adr/0001-a.md', text);
      expect(document.rawStatus, bullet).toBe('Accepted (2026-03-01)');
      expect(covered(text, document.statusAt), bullet).toBe('Accepted (2026-03-01)');
    }
  });

  it('keeps a dash that is part of the status rather than a bullet', () => {
    const { document } = extract('docs/adr/0001-a.md', '# A\n\n## Status\n\nAccepted - 2026-03-01\n');
    expect(document.rawStatus).toBe('Accepted - 2026-03-01');
  });
});

describe('the problems a file reports about its own text', () => {
  it('points at the NUL byte itself', () => {
    const text = '# A\n\nSaved as \u0000UTF-16.\n';
    const [problem] = extract('docs/adr/0001-a.md', text).problems;
    expect(covered(text, problem?.at)).toBe('\u0000');
  });

  it('points at the comment that never closes', () => {
    const text = '# A\n\nWords.\n\n<!-- a note that never closes\n\n## Decision\n';
    const [problem] = extract('docs/adr/0001-a.md', text).problems;
    expect(covered(text, problem?.at)).toBe('<!--');
  });

  it('counts an alias it could not read as a value the graph lost, and a title as one it did not', () => {
    // An alias left unread is a name citations no longer reach; a title left
    // unread changes a label. Only the first is counted on a default run.
    const text = '---\nalias: ADR-7: sharding\ntitle: ADR-7: sharding\n---\n\n# A\n';
    const lost = extract('docs/adr/0001-a.md', text).problems.map((problem) => problem.unread === true);
    expect(lost).toEqual([true, false]);
    const aliases = extract('docs/adr/0001-a.md', '---\naliases: ADR-7: sharding\n---\n\n# A\n').problems;
    expect(aliases.map((problem) => problem.unread)).toEqual([true]);
  });
});

describe('where a file is anchored', () => {
  it('is its first line, which is where a finding about the whole file points', () => {
    const { document } = extract('docs/adr/0001-a.md', '# A\n\nWords.\n\nMore words.\n');
    expect([document.at.span.start.line, document.at.span.end.line]).toEqual([1, 1]);
  });
});
