import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { attr, attrList, parseDirectives, type Directive } from '../src/directives.js';
import { scanMarkdown } from '../src/markdown.js';
import { analyseSources } from '../src/runner.js';

/**
 * How a directive is written, held to the README's Directives section.
 *
 * The README's table names the attributes each directive takes, and every
 * other one is a parse problem; that is checked in both directions, for every
 * attribute the table names on every directive. The rest - where a directive
 * sits in its comment, how a value is quoted, where a value is said to be, how
 * a list splits - is what the section's prose says, observed through the
 * parsed directive a caller of the API receives.
 */

const parse = (text: string): Directive[] => parseDirectives(scanMarkdown(text).comments);

function only(text: string): Directive {
  const [directive, ...rest] = parse(text);
  if (directive === undefined || rest.length > 0) throw new Error(`expected one directive in ${text}`);
  return directive;
}

/** The README's table of directives, each with the attributes its row lists. */
function documented(): Map<string, string[]> {
  const readme = readFileSync('README.md', 'utf8');
  const header = '| directive | attributes |';
  const at = readme.indexOf(header);
  if (at === -1) throw new Error('the README has no table of directive attributes');
  const rows = readme.slice(at, readme.indexOf('\n\n', at)).split('\n').slice(2);
  const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
  return new Map(
    rows.map((row) => {
      const [, directive = '', attributes = ''] = row.split('|').map((cell) => cell.trim());
      return [(ticked(directive)[0] ?? '').replace(/^@/, ''), ticked(attributes)] as const;
    }),
  );
}

describe('the attributes of each directive', () => {
  it('are read from the README, one row for each of the five directives', () => {
    const table = documented();
    expect([...table.keys()]).toEqual(['spec-node', 'spec-item', 'spec-edge', 'spec-ignore', 'spec-history']);
    // A table that failed to parse would pass the test below vacuously.
    expect(new Set([...table.values()].flat()).size).toBeGreaterThan(8);
  });

  it('are the ones its row lists: each is taken, and every other one is reported', () => {
    const table = documented();
    const every = [...new Set([...table.values()].flat())];
    const reported: string[] = [];
    const expected: string[] = [];
    for (const [name, attributes] of table) {
      for (const attribute of every) {
        const directive = only(`<!-- @${name} ${attribute}="x" -->`);
        reported.push(`@${name} ${attribute}: ${directive.unknownAttributes.join(',') || 'taken'}`);
        expected.push(`@${name} ${attribute}: ${attributes.includes(attribute) ? 'taken' : attribute}`);
      }
    }
    expect(reported).toEqual(expected);
  });

  it('that are unknown are a parse problem, and the directive still applies', () => {
    const { corpus, graph } = analyseSources([
      { path: 'docs/adr/0042-sharding.md', text: '<!-- @spec-node id="ADR-0042" state="accepted" -->\n\n# Sharding\n' },
    ]);
    expect(corpus.problems.map((problem) => problem.message)).toEqual(['unknown attribute "state" on @spec-node']);
    expect(graph.document('ADR-0042')?.path).toBe('docs/adr/0042-sharding.md');
  });
});

describe('a directive', () => {
  it('is the first thing in its comment, so a comment that only mentions one is a comment', () => {
    expect(parse('<!-- Decide whether this needs @spec-ignore before merging. -->')).toEqual([]);
    const { graph } = analyseSources([
      { path: 'docs/adr/0001-a.md', text: '# A\n\n<!-- Not @spec-ignore yet: it is still being read. -->\n' },
    ]);
    expect(graph.document('ADR-0001')).toBeDefined();
  });

  it('may open its comment with no space, or after a line break and indentation', () => {
    expect(parse('<!--@spec-history-->').map((directive) => directive.name)).toEqual(['spec-history']);
    const spread = only('<!--\n\n   @spec-node id="ADR-0001"\n-->');
    expect([spread.name, attr(spread, 'id')?.value]).toEqual(['spec-node', 'ADR-0001']);
  });
});

describe('a value', () => {
  it('is read whole when it is bare, and nothing after it is taken for another attribute', () => {
    const directive = only('<!-- @spec-node id=ADR-0042 status=accepted -->');
    expect([attr(directive, 'id')?.value, attr(directive, 'status')?.value]).toEqual(['ADR-0042', 'accepted']);
    expect(directive.unknownAttributes).toEqual([]);
  });

  it('is found where it is written, quoted either way or bare, so a finding can point at it', () => {
    for (const written of ['status="accepted"', "status='accepted'", 'status=accepted']) {
      const text = `<!-- @spec-node ${written} -->`;
      const directive = only(text);
      const raw = directive.attributes.get('status');
      const read = attr(directive, 'status');
      expect(text.slice(raw?.start, raw?.end), written).toBe('accepted');
      expect(text.slice(read?.start, read?.end), written).toBe('accepted');
    }
  });

  it('is pointed at by its text once trimmed', () => {
    const text = '<!-- @spec-node status="  accepted  " -->';
    const directive = only(text);
    const raw = directive.attributes.get('status');
    const read = attr(directive, 'status');
    expect(text.slice(raw?.start, raw?.end)).toBe('  accepted  ');
    expect([read?.value, text.slice(read?.start, read?.end)]).toEqual(['accepted', 'accepted']);
  });
});

describe('a list of aliases', () => {
  it('splits at commas, semicolons and spaces, and a separator at either end adds nothing', () => {
    const directive = only('<!-- @spec-node id="ADR-0007" aliases=", adr-7; sharding  shard-key," -->');
    expect(attrList(directive, 'aliases')).toEqual(['adr-7', 'sharding', 'shard-key']);
  });

  it('is empty when the attribute is missing or blank', () => {
    expect(attrList(only('<!-- @spec-node id="ADR-0007" -->'), 'aliases')).toEqual([]);
    expect(attrList(only('<!-- @spec-node id="ADR-0007" aliases=" " -->'), 'aliases')).toEqual([]);
  });

  it('gives a document those aliases, and no empty one', () => {
    const { graph } = analyseSources([
      { path: 'docs/adr/0007-sharding.md', text: '<!-- @spec-node id="ADR-0007" aliases=", partitioning," -->\n\n# Sharding\n' },
    ]);
    expect(graph.document('ADR-0007')?.aliases).toContain('partitioning');
    expect(graph.document('ADR-0007')?.aliases).not.toContain('');
  });
});
