import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  extractDocument,
  OBLIGATION_SECTIONS,
  RELATION_KEYS,
  WEAK_SECTIONS,
  type ExtractedDocument,
} from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { EdgeKind } from '../src/types.js';

/**
 * Extraction's vocabularies, held to what the README says they mean.
 *
 * Every expectation below is read out of the README rather than out of
 * `extract.ts`: a front-matter key means what the relation table says, a
 * heading holds obligations or bookkeeping because the README lists it there,
 * and a prefix is never a citation because the README says so. Where the code
 * exports its table, it is checked in both directions: each documented word
 * does what the README claims, and each word the code knows is documented.
 */

const README = readFileSync('README.md', 'utf8');

/** The backticked terms of the README list that opens with `**label:**`. */
function documented(label: string): string[] {
  const at = README.indexOf(`**${label}:**`);
  if (at === -1) throw new Error(`the README has no "${label}" list`);
  const list = README.slice(at, README.indexOf('`.', at) + 1);
  return [...list.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

/** The rows of the README's front-matter relation table. */
function relationTable(): { kind: EdgeKind; forward: string[]; inverse: string[] }[] {
  const header = '| Relation | ADR-0001 → ADR-0002 | ADR-0002 → ADR-0001 |';
  const at = README.indexOf(header);
  if (at === -1) throw new Error('the README has no relation table');
  const rows = README.slice(at, README.indexOf('\n\n', at)).split('\n').slice(2);
  const terms = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
  return rows.map((row) => {
    const [, kind = '', forward = '', inverse = ''] = row.split('|').map((cell) => cell.trim());
    return { kind: terms(kind)[0] as EdgeKind, forward: terms(forward), inverse: terms(inverse) };
  });
}

const TABLE = relationTable();
const FORWARD = TABLE.flatMap((row) => row.forward.map((key) => [key, row.kind] as const));
const INVERSE = TABLE.flatMap((row) => row.inverse.map((key) => [key, row.kind] as const));

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** The file's own specification. None of these documents opts out. */
function extract(path: string, text: string): ExtractedDocument {
  const extracted = extractDocument({ path, text });
  if (extracted === null) throw new Error(`${path} opted out`);
  return extracted;
}

/** The one relation ADR-0001's front matter produces, as `from -kind-> to`. */
function relationFrom(frontMatter: string): string[] {
  const { graph } = analyse({
    'docs/adr/0001-citing.md': `---\n${frontMatter}\n---\n\n# Citing\n`,
    'docs/adr/0002-cited.md': '# Cited\n',
  });
  return graph.edges
    .filter((edge) => edge.kind !== 'contains')
    .map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`);
}

describe('the README relation table', () => {
  it('documents every front-matter key there is, and none that is not', () => {
    const keys = [...FORWARD, ...INVERSE].map(([key]) => key).sort();
    expect(keys).toEqual(Object.keys(RELATION_KEYS).sort());
  });

  it.each(FORWARD)('reads "%s: ADR-0002" in ADR-0001 as ADR-0001 %s ADR-0002', (key, kind) => {
    expect(relationFrom(`${key}: ADR-0002`)).toEqual([`ADR-0001 -${kind}-> ADR-0002`]);
  });

  it.each(INVERSE)('reads "%s: ADR-0002" in ADR-0001 as ADR-0002 %s ADR-0001', (key, kind) => {
    expect(relationFrom(`${key}: ADR-0002`)).toEqual([`ADR-0002 -${kind}-> ADR-0001`]);
  });
});

/** How the prose around a link to ADR-0002 reads, as the candidate records it. */
function prose(sentence: string, section = 'Decision'): { kind: EdgeKind; inverted: boolean } | undefined {
  const { references } = extract('docs/adr/0001-citing.md', `# Citing\n\n## ${section}\n\n${sentence}\n`);
  const found = references.find((reference) => reference.target === '0002-cited.md');
  return found && { kind: found.kind, inverted: found.inverted };
}

describe('prose reads both directions', () => {
  // "Prose reads both directions too: `supersedes` and `superseded by`,
  // `amends` and `amended by`, `blocked by` and `blocks` or `blocking`,
  // `depends on` and `depended on by` - the second of each pair points back at
  // the document that wrote it."
  const PAIRS: readonly (readonly [string, EdgeKind, boolean])[] = [
    ['This decision supersedes [ADR-0002](0002-cited.md).', 'supersedes', false],
    ['This decision is superseded by [ADR-0002](0002-cited.md).', 'supersedes', true],
    ['This decision amends [ADR-0002](0002-cited.md).', 'amends', false],
    ['This decision is amended by [ADR-0002](0002-cited.md).', 'amends', true],
    ['This rollout is blocked by [ADR-0002](0002-cited.md).', 'blocked-by', false],
    ['This rollout blocks [ADR-0002](0002-cited.md).', 'blocked-by', true],
    ['This rollout is blocking [ADR-0002](0002-cited.md).', 'blocked-by', true],
    ['This decision depends on [ADR-0002](0002-cited.md).', 'depends-on', false],
    ['This decision is depended on by [ADR-0002](0002-cited.md).', 'depends-on', true],
  ];

  it.each(PAIRS)('reads "%s" as %s, inverted: %s', (sentence, kind, inverted) => {
    expect(prose(sentence)).toEqual({ kind, inverted });
  });
});

describe('the README bookkeeping headings', () => {
  const HEADINGS = documented('Bookkeeping headings');

  it('lists every heading that files a link as bookkeeping', () => {
    expect(HEADINGS.map((heading) => heading.toLowerCase()).sort()).toEqual([...WEAK_SECTIONS].sort());
  });

  it.each(HEADINGS)('reads a link under "%s" as relates-to', (heading) => {
    expect(prose('- [ADR-0002](0002-cited.md)', heading)).toEqual({ kind: 'relates-to', inverted: false });
  });

  it('reads a link under any other heading as a neutral citation', () => {
    expect(prose('- [ADR-0002](0002-cited.md)', 'Decision')).toEqual({ kind: 'references', inverted: false });
  });

  it('files a link as bookkeeping from any enclosing heading, not only the nearest', () => {
    expect(prose('- [ADR-0002](0002-cited.md)', 'See also\n\n### Older notes')).toEqual({
      kind: 'relates-to',
      inverted: false,
    });
  });

  it('still lets a phrase beside the link say more', () => {
    expect(prose('- Deferred to [ADR-0002](0002-cited.md)', 'See also')).toEqual({
      kind: 'delegates-to',
      inverted: false,
    });
  });
});

/** The obligations a document with one plain bullet under `heading` holds. */
function obligationsUnder(heading: string): string[] {
  const { items } = extract('docs/adr/0001-a.md', `# A\n\n## ${heading}\n\n- Pick a shard key\n`);
  return items.map((item) => item.text);
}

describe('the README obligation headings', () => {
  const HEADINGS = documented('Headings that hold obligations');

  it('lists every heading that holds obligations', () => {
    expect(HEADINGS.map((heading) => heading.toLowerCase()).sort()).toEqual([...OBLIGATION_SECTIONS].sort());
  });

  it.each(HEADINGS)('makes a plain bullet under "%s" an obligation', (heading) => {
    expect(obligationsUnder(heading)).toEqual(['Pick a shard key']);
  });

  it('leaves a plain bullet under any other heading as prose', () => {
    expect(obligationsUnder('Context')).toEqual([]);
  });

  // "however the heading is cased, spaced, emphasised or punctuated -
  // `## ❓ **Open questions:**` is one."
  it.each(['❓ **Open questions:**', '_Next steps_', 'Open  Questions', 'Follow-ups?', '`TODO`'])(
    'reads "%s" as the heading it decorates',
    (heading) => {
      expect(obligationsUnder(heading)).toEqual(['Pick a shard key']);
    },
  );
});

/** The identifiers found in a line of prose, before any corpus is consulted. */
function citationsIn(line: string): string[] {
  const { references } = extract('docs/adr/0001-a.md', `# A\n\n${line}\n`);
  return references.filter((reference) => reference.origin === 'text').map((reference) => reference.target);
}

describe('the README prefixes that are never a citation', () => {
  const NEVER = documented('Never a citation');

  it.each(NEVER)('reads "%s" as prose', (phrase) => {
    expect(citationsIn(`The service speaks ${phrase} and nothing else.`)).toEqual([]);
  });

  // "A one-letter prefix is never a family - `Q3`, `x86`, `p99`"
  it.each(['Q3', 'x86', 'p99', 'v2'])('reads the one-letter prefix of "%s" as prose', (phrase) => {
    expect(citationsIn(`Planned for ${phrase} at the latest.`)).toEqual([]);
  });

  it('still reads a family of two letters or more', () => {
    expect(citationsIn('Tracked as OI-12 and decided in ADR-0007.')).toEqual(['OI-12', 'ADR-0007']);
  });

  it('reads an identifier written without a separator', () => {
    expect(citationsIn('The keywords are as defined in RFC2119.')).toEqual(['RFC2119']);
  });

  it('keeps them out even where the repository has a family of that name', () => {
    // "even in a repository that has a family of that name": a repository that
    // files its issues as documents still means GitHub's issue 42 when it says
    // so, and an engineering-standards family does not make ES2015 one of them.
    const { diagnostics } = analyse({
      'docs/issue/ISSUE-0001.md': '# ISSUE-0001: Flaky build\n',
      'docs/es/ES-0001.md': '# ES-0001: Naming\n',
      'docs/adr/0001-a.md': '# A\n\nSee GitHub issue 42. The client targets ES2015.\n',
    });
    expect(diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain('broken-reference');
  });
});
