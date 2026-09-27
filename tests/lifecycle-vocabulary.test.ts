import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { phaseFromPath, phaseOf, STATUS_KEYS, supersessionTargetsIn } from '../src/lifecycle.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { Phase } from '../src/types.js';

/**
 * The lifecycle vocabulary, held to the README rather than to `lifecycle.ts`.
 *
 * The README's "Every status word" table is the promise a user reads; each
 * word in it must read as the phase its row names, through a document that
 * declares it. A word the table drops, or one that stops meaning what the
 * table says, fails here. See ADR-0002 and ADR-0011.
 */

interface Vocabulary {
  readonly words: readonly (readonly [Phase, string])[];
  readonly keys: readonly string[];
  readonly headings: readonly string[];
  readonly directories: readonly string[];
}

/** Reads the tables under the README's "Every status word" summary. */
function documented(): Vocabulary {
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf('<summary>Every status word');
  const block = readme.slice(start, readme.indexOf('</details>', start));
  const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  const row = (label: string): string[] => {
    const line = block.split('\n').find((candidate) => candidate.startsWith(`| ${label}`));
    if (!line) throw new Error(`README has no "${label}" row`);
    return ticked(line.split('|')[2] as string);
  };

  const words: [Phase, string][] = [];
  for (const match of block.matchAll(/^\| `([a-z]+)` \| (.*) \|$/gm)) {
    for (const word of ticked(match[2] as string)) words.push([match[1] as Phase, word]);
  }
  return {
    words,
    keys: row('Front matter'),
    headings: row('A section'),
    directories: row('A directory'),
  };
}

const corpus = (files: Record<string, string>): Source[] => Object.entries(files).map(([path, text]) => ({ path, text }));

const number = (index: number): string => String(index + 1).padStart(4, '0');

describe('the documented status words', () => {
  it('are read from the README, all five rows of them', () => {
    const { words } = documented();
    expect(new Set(words.map(([phase]) => phase))).toEqual(new Set(['retired', 'record', 'frozen', 'active', 'draft']));
    // A table that failed to parse would pass every test below vacuously.
    expect(words.length).toBeGreaterThan(80);
  });

  it('each give a document that declares it the phase of its row', () => {
    const { words } = documented();
    const files: Record<string, string> = {};
    words.forEach(([, word], index) => {
      files[`docs/adr/${number(index)}-status.md`] = `---\nstatus: ${word}\n---\n\n# Status ${word}\n`;
    });
    const { graph } = analyseSources(corpus(files));
    const read = words.map(([, word], index) => [graph.document(`ADR-${number(index)}`)?.phase, word]);
    expect(read).toEqual(words.map(([phase, word]) => [phase, word]));
  });

  it('count in any case, and spaced as well as hyphenated', () => {
    for (const [phase, word] of documented().words) {
      expect(phaseOf(word.toUpperCase()), word).toBe(phase);
      expect(phaseOf(word.replace(/-/g, ' ')), word).toBe(phase);
    }
  });

  it('count only whole', () => {
    // `approved` and `live` are in the table; these words only contain them.
    expect(phaseOf('Unapproved')).toBe('unknown');
    expect(phaseOf('Delivered')).toBe('unknown');
    // `inactive` is a word of its own, and not `active`.
    expect(phaseOf('Inactive')).toBe('retired');
  });

  it('take the higher row when a status holds two', () => {
    expect(phaseOf('Final, and accepted by the board')).toBe('frozen');
    expect(phaseOf('Accepted, later superseded by ADR-0009')).toBe('retired');
    // ADR-0011: an archived brief that was superseded is retired, not a record.
    expect(phaseOf('archived, superseded by B-0007')).toBe('retired');
    expect(phaseOf('archived')).toBe('record');
  });

  it('read provisionally accepted as a draft, though it holds accepted', () => {
    expect(phaseOf('Provisionally accepted')).toBe('draft');
    expect(phaseOf('provisionally-accepted (2026-03-01)')).toBe('draft');
    expect(phaseOf('Accepted')).toBe('active');
    const { graph } = analyseSources(corpus({ 'docs/adr/0001-a.md': '---\nstatus: Provisionally accepted\n---\n\n# A\n' }));
    expect(graph.document('ADR-0001')?.phase).toBe('draft');
  });
});

describe('what a status is stripped of before it is read', () => {
  it('reads past a comment, and none of the comment', () => {
    expect(phaseOf('Accepted <!-- TODO: mark superseded once ADR-0009 lands -->')).toBe('active');
  });

  it('reads a line break in a table cell as a break between words', () => {
    expect(phaseOf('Superseded<br>by ADR-0009')).toBe('retired');
  });

  it('reads an emoji between two words as a break between them', () => {
    expect(phaseOf('Proposed➡Accepted')).toBe('active');
  });

  it('reads a run of spaces as one', () => {
    expect(phaseOf('Signed  off')).toBe('active');
    expect(phaseOf('In  progress')).toBe('draft');
  });

  it('finds nothing in a status that is only decoration', () => {
    expect(phaseOf('✅ — 2026-03-01')).toBe('unknown');
    expect(phaseOf('')).toBe('unknown');
  });
});

describe('where a status is looked for', () => {
  it('reads each documented front-matter key', () => {
    const { keys } = documented();
    const files: Record<string, string> = {};
    keys.forEach((key, index) => {
      files[`docs/adr/${number(index)}-key.md`] = `---\n${key}: accepted\n---\n\n# Key ${key}\n`;
    });
    const { graph } = analyseSources(corpus(files));
    expect(keys.map((key, index) => [key, graph.document(`ADR-${number(index)}`)?.phase])).toEqual(
      keys.map((key) => [key, 'active']),
    );
  });

  it('documents every key the code exports, in the order it prefers them', () => {
    expect(STATUS_KEYS).toEqual(documented().keys);
  });

  it('prefers the first documented key a document holds', () => {
    const { keys } = documented();
    // Each key over every key after it: `status: accepted` beside `state: draft` is active.
    const files: Record<string, string> = {};
    keys.forEach((_, index) => {
      const lines = keys.slice(index).map((key, offset) => `${key}: ${offset === 0 ? 'accepted' : 'draft'}`);
      files[`docs/adr/${number(index)}-keys.md`] = `---\n${lines.reverse().join('\n')}\n---\n\n# Keys\n`;
    });
    const { graph } = analyseSources(corpus(files));
    expect(keys.map((_, index) => graph.document(`ADR-${number(index)}`)?.phase)).toEqual(keys.map(() => 'active'));
  });

  it('reads the section under each documented heading, however it is decorated', () => {
    const { headings } = documented();
    const written = [...headings, '**Status**', 'Status:', '`Status`', 'Status :'];
    const files: Record<string, string> = {};
    written.forEach((heading, index) => {
      files[`docs/adr/${number(index)}-heading.md`] = `# Heading\n\n## ${heading}\n\nAccepted\n\n## Context\n`;
    });
    const { graph } = analyseSources(corpus(files));
    expect(written.map((heading, index) => [heading, graph.document(`ADR-${number(index)}`)?.phase])).toEqual(
      written.map((heading) => [heading, 'active']),
    );
  });

  it('retires a document beneath each documented directory, and nothing beside one', () => {
    const { directories } = documented();
    const files: Record<string, string> = {};
    directories.forEach((directory, index) => {
      files[`docs/adr/${directory}/${number(index)}-old.md`] = '# Old\n';
    });
    const { graph } = analyseSources(corpus(files));
    expect(directories.map((directory, index) => [directory, graph.document(`ADR-${number(index)}`)?.phase])).toEqual(
      directories.map((directory) => [directory, 'retired']),
    );
    // A file's own name is not a directory, with an extension or without one.
    expect(phaseFromPath('docs/adr/archive')).toBe('unknown');
    expect(phaseFromPath('docs/adr/archive.md')).toBe('unknown');
    expect(phaseFromPath('docs/adr/archive/0001.md')).toBe('retired');
  });
});

describe('the successor a status names', () => {
  it('is read however the supersession is punctuated', () => {
    const written = [
      'Superseded by ADR-0009',
      'Superceded by ADR-0009',
      'Superseded: ADR-0009',
      'Superseded by: ADR-0009',
      'Superseded - ADR-0009',
      'Superseded — ADR-0009',
      'Superseded—ADR-0009',
      'Superseded (ADR-0009)',
      'Superseded by **ADR-0009**',
      'Superseded by [ADR-0009](0009-sharding.md)',
      'Replaced by ADR-0009',
      'Replaced with ADR-0009',
      'Obsoleted by ADR-0009',
      'Superseded by ADR-0009, ',
    ];
    expect(written.map((status) => [status, supersessionTargetsIn(status)])).toEqual(
      written.map((status) => [status, ['ADR-0009']]),
    );
  });

  it('is every one of several', () => {
    expect(supersessionTargetsIn('Replaced with ADR-0009 and ADR-0010; RFC-0003')).toEqual([
      'ADR-0009',
      'ADR-0010',
      'RFC-0003',
    ]);
  });

  it('is none for a status that names no supersession', () => {
    expect(supersessionTargetsIn('Accepted')).toEqual([]);
    expect(supersessionTargetsIn('Superseded')).toEqual([]);
  });

  it('is read from the first line of a status that wraps onto a second', () => {
    expect(supersessionTargetsIn('Superseded by ADR-0009\nsee the migration notes')).toEqual(['ADR-0009']);
    const { graph } = analyseSources(
      corpus({
        'docs/adr/0002-storage.md': [
          '<!-- @spec-node status="Superseded by ADR-0009,',
          'see the migration notes" -->',
          '# Storage',
        ].join('\n'),
        'docs/adr/0009-storage-v2.md': '---\nstatus: accepted\n---\n\n# Storage v2\n',
      }),
    );
    expect(graph.edges.filter((edge) => edge.kind === 'supersedes').map((edge) => `${edge.from} > ${edge.to}`)).toEqual([
      'ADR-0009 > ADR-0002',
    ]);
  });
});
