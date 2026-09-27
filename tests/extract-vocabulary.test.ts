import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractDocument, type ExtractedDocument } from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * Extraction's vocabularies, held to what the README says they mean.
 *
 * Every expectation below is read out of the README rather than out of
 * `extract.ts`: a prefix is never a citation because the README says so.
 */

const README = readFileSync('README.md', 'utf8');

/** The backticked terms of the README list that opens with `**label:**`. */
function documented(label: string): string[] {
  const at = README.indexOf(`**${label}:**`);
  if (at === -1) throw new Error(`the README has no "${label}" list`);
  const list = README.slice(at, README.indexOf('`.', at) + 1);
  return [...list.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** The file's own specification. None of these documents opts out. */
function extract(path: string, text: string): ExtractedDocument {
  const extracted = extractDocument({ path, text });
  if (extracted === null) throw new Error(`${path} opted out`);
  return extracted;
}

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
