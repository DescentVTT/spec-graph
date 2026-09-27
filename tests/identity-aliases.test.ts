import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ID_KEYS, identify, normaliseRef, splitAnchor, type IdentityInput } from '../src/identity.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * What a document is called, and every spelling that reaches it.
 *
 * ADR-0004: a declaration and a file name *name* a document, a title only
 * describes one, and `ADR-7`, `ADR-0007`, `adr 7` and the path all reach the
 * same place. ADR-0009: a region answers to neither the file's path nor its
 * name. `identify` and `normaliseRef` are exported, and the aliases they
 * produce are in every JSON export, so they are asserted here directly as
 * well as through the graph a user sees.
 */

const file = (path: string, rest: Partial<IdentityInput> = {}): IdentityInput => ({
  path,
  declaredId: null,
  declaredAliases: [],
  heading: null,
  ...rest,
});

const ids = (sources: Source[]): string[] =>
  analyseSources(sources)
    .corpus.documents.map((d) => d.id)
    .sort();

const readme = (): string => readFileSync('README.md', 'utf8');

describe('the family a directory gives a numbered file', () => {
  // The README lists these. The nearest enclosing one wins.
  const FAMILIES: readonly (readonly [string, string])[] = [
    ['adr', 'ADR'],
    ['adrs', 'ADR'],
    ['architecture-decisions', 'ADR'],
    ['decision-records', 'ADR'],
    ['decisions', 'ADR'],
    ['rfc', 'RFC'],
    ['rfcs', 'RFC'],
    ['kep', 'KEP'],
    ['keps', 'KEP'],
    ['enhancements', 'KEP'],
    ['proposal', 'PROPOSAL'],
    ['proposals', 'PROPOSAL'],
    ['design', 'DESIGN'],
    ['designs', 'DESIGN'],
    ['prd', 'PRD'],
    ['prds', 'PRD'],
    ['spec', 'SPEC'],
    ['specs', 'SPEC'],
  ];

  it('is one of the ones the README lists', () => {
    const text = readme();
    const bullet = text.slice(text.indexOf('- **Bare numbers are family-scoped.**'), text.indexOf('- **Two candidates'));
    // `proposal(s)/` names both spellings.
    const listed = [...bullet.matchAll(/`([a-z-]+)(\(s\))?\/`/g)].flatMap(([, stem, plural]) =>
      plural ? [stem as string, `${stem}s`] : [stem as string],
    );
    expect(listed.sort()).toEqual(FAMILIES.map(([directory]) => directory).sort());
  });

  it.each(FAMILIES)('is %s/ -> %s', (directory, family) => {
    expect(identify(file(`docs/${directory}/0007-sharding.md`)).id).toBe(`${family}-0007`);
  });
});

describe('the front-matter keys that declare an identifier', () => {
  const KEYS: readonly (readonly [string, string, string, string])[] = [
    ['id', 'docs/notes/sharding.md', 'ADR-0007', 'ADR-0007'],
    ['adr', 'docs/adr/sharding.md', '0007', 'ADR-0007'],
    ['adr-id', 'docs/adr/sharding.md', 'ADR-0007', 'ADR-0007'],
    ['rfc', 'docs/rfcs/sharding.md', '0007', 'RFC-0007'],
    ['rfc-id', 'docs/rfcs/sharding.md', 'RFC-0007', 'RFC-0007'],
    ['kep-number', 'docs/keps/sharding.md', '1234', 'KEP-1234'],
    ['number', 'docs/adr/sharding.md', '0007', 'ADR-0007'],
  ];

  it('are the ones the README lists, every one the code exports', () => {
    const listed = /an explicit `id:` \(or ([^)]*)\)/.exec(readme())?.[1] ?? '';
    const documented = ['id', ...[...listed.matchAll(/`([a-z-]+):`/g)].map(([, key]) => key as string)];
    expect([...documented].sort()).toEqual([...ID_KEYS].sort());
    // Each is read below: all but `slug:` by the table, `slug:` on its own.
    expect([...KEYS.map(([key]) => key), 'slug'].sort()).toEqual([...ID_KEYS].sort());
  });

  it.each(KEYS)('reads %s: in %s', (key, path, value, id) => {
    expect(ids([{ path, text: `---\n${key}: ${value}\nstatus: accepted\n---\n\n# Sharding\n` }])).toEqual([id]);
  });

  it('reads slug: as a name the document answers to, beside the number its file name gives', () => {
    const { corpus, diagnostics, graph } = analyseSources([
      { path: 'docs/adr/0007-sharding.md', text: '---\nslug: sharding-the-write-path\nstatus: accepted\n---\n\n# Sharding\n' },
      { path: 'docs/adr/0008-cache.md', text: '---\nstatus: accepted\n---\n\n# Cache\n\nBuilds on [[sharding-the-write-path]].\n' },
    ]);
    expect(corpus.documents.map((d) => d.id).sort()).toEqual(['ADR-0007', 'ADR-0008']);
    expect(graph.out('ADR-0008').map((e) => e.to)).toEqual(['ADR-0007']);
    expect(diagnostics).toEqual([]);
  });
});

describe('a declared identifier', () => {
  it('reads a family and number written together', () => {
    // `rfc2119` is one of the forms the identifier pattern is documented for.
    expect(identify(file('docs/notes/keywords.md', { declaredId: 'RFC2119' })).id).toBe('RFC-2119');
  });

  it('is read without the space around it', () => {
    const padded = identify(file('docs/notes/x.md', { declaredId: ' ADR-0009 ' }));
    expect([padded.id, padded.family, padded.number]).toEqual(['ADR-0009', 'ADR', 9]);
    expect(identify(file('docs/notes/x.md', { declaredId: ' MY-THING ' })).id).toBe('MY-THING');
  });

  it('is kept as written when it is not a family and a number', () => {
    // A sub-decision is its own document, not a second ADR-0007.
    const sub = identify(file('docs/notes/sub.md', { declaredId: 'ADR-0007.1' }));
    expect([sub.id, sub.family, sub.number]).toEqual(['ADR-0007.1', null, null]);
  });

  it('keeps its zero padding, even when its family has a digit in it', () => {
    // The padding was read from the first run of digits, which in `S3-0012`
    // is the family's: it was reported as S3-12.
    expect(identify(file('docs/notes/storage.md', { declaredId: 'S3-0012' })).id).toBe('S3-0012');
    expect(identify(file('docs/notes/platform.md', { declaredId: 'K8S-0007' })).id).toBe('K8S-0007');
  });
});

describe('the spellings a document answers to', () => {
  it('include every padding a citation might use', () => {
    expect(identify(file('docs/adr/0040-enforce.md')).aliases).toEqual(
      expect.arrayContaining(['adr40', 'adr040', 'adr0040']),
    );
    expect(identify(file('docs/adr/07-shard.md')).aliases).toEqual(
      expect.arrayContaining(['adr7', 'adr07', 'adr007', 'adr0007']),
    );
  });

  it('include the bare number when there is no family, since there is one number space', () => {
    expect(identify(file('text/0001-private-fields.md')).aliases).toEqual(expect.arrayContaining(['1', '001', '0001']));
    const { graph } = analyseSources([
      { path: 'text/0001-private-fields.md', text: '---\nstatus: accepted\n---\n\n# Private fields\n' },
      { path: 'text/0002-rfc-process.md', text: '---\nstatus: accepted\ndepends-on: 0001\n---\n\n# RFC process\n' },
    ]);
    expect(graph.out('0002-rfc-process', ['depends-on']).map((e) => e.to)).toEqual(['0001-private-fields']);
  });

  it('include the path, with and without its extension, for a file and never for a region', () => {
    const own = identify(file('docs/adr/0007-sharding.md')).aliases;
    expect(own).toEqual(expect.arrayContaining([normaliseRef('docs/adr/0007-sharding.md'), normaliseRef('docs/adr/0007-sharding')]));
    const region = identify(file('docs/adr/0007-sharding.md', { declaredId: 'ADR-0012', includePathAliases: false })).aliases;
    expect(region).not.toContain(normaliseRef('docs/adr/0007-sharding.md'));
    expect(region).not.toContain(normaliseRef('docs/adr/0007-sharding'));
  });

  it('take all of an extensionless file\'s name, and its path once', () => {
    const aliases = identify(file('docs/rfcs/0007-sharding')).aliases;
    expect(aliases).toContain(normaliseRef('0007-sharding'));
    // There is no extension to drop, so there is no second spelling of the path.
    expect(aliases.filter((alias) => alias.includes('/'))).toEqual([normaliseRef('docs/rfcs/0007-sharding')]);
  });

  it('never include an empty spelling, whatever was declared', () => {
    expect(identify(file('docs/adr/0007-sharding.md', { declaredAliases: ['sharding', '—', '...'] })).aliases).not.toContain('');
  });
});

describe('the number a file name gives', () => {
  const NAMES: readonly (readonly [string, string])[] = [
    ['docs/decisions/ADR 0007 Sharding.md', 'ADR-0007'],
    ['docs/adr/0007 Sharding.md', 'ADR-0007'],
    ['docs/rfcs/rfc2119-keywords.md', 'RFC-2119'],
    ['docs/adr/0007-sharding/README.md', 'ADR-0007'],
  ];

  it.each(NAMES)('reads %s as %s', (path, id) => {
    expect(identify(file(path)).id).toBe(id);
  });

  it('is read only where the name opens with it', () => {
    // A version at the end of a name is not the document's number.
    expect(identify(file('docs/adr/sharding-v2.md')).id).toBe('sharding-v2');
  });

  it('is not borrowed from a directory by a name that merely begins like README or index', () => {
    expect(identify(file('docs/guides/indexing.md')).id).toBe('indexing');
  });
});

describe('a title', () => {
  it('names a document nothing else has named, however its identifier is spaced', () => {
    expect(identify(file('docs/notes/keywords.md', { heading: 'RFC2119: Key words' })).id).toBe('RFC-2119');
    expect(identify(file('docs/notes/sharding.md', { heading: 'ADR 0007: Sharding' })).id).toBe('ADR-0007');
  });

  it('names nothing with an identifier it does not open with', () => {
    expect(identify(file('docs/notes/sharding.md', { heading: 'Sharding, after ADR-0003' })).id).toBe('sharding');
  });

  it('that loses to the file name registers no alias', () => {
    // ADR-0004: `# ADR-0040 considered harmful` at the top of 0007-sharding.md
    // was registering adr0040 against ADR-0007.
    for (const declaredId of [null, 'sharding']) {
      const identity = identify(file('docs/adr/0007-sharding.md', { declaredId, heading: 'ADR-0040 considered harmful' }));
      expect(identity.id).toBe('ADR-0007');
      expect(identity.aliases).not.toContain('adr0040');
    }
  });
});

describe('normaliseRef', () => {
  it('folds case, separators and surrounding punctuation', () => {
    for (const spelling of ['ADR-0007', 'adr 0007', 'Adr_0007', ' (ADR-0007) ', '[[ADR-0007]]', 'ADR-0007).']) {
      expect(normaliseRef(spelling)).toBe('adr0007');
    }
  });
});

describe('splitAnchor', () => {
  it('splits a target from its anchor, and a leading # is an anchor in the citing document', () => {
    expect(splitAnchor('ADR-0011#scope')).toEqual({ target: 'ADR-0011', anchor: 'scope' });
    expect(splitAnchor('#scope')).toEqual({ target: '', anchor: 'scope' });
    expect(splitAnchor('ADR-0011')).toEqual({ target: 'ADR-0011', anchor: null });
  });
});

describe('a link to a file that is not a document', () => {
  it('is not a reference, even when a document extension sits inside its name', () => {
    // A template for an ADR is not an ADR.
    const { diagnostics } = analyseSources([
      {
        path: 'docs/adr/0001-templates.md',
        text: '---\nstatus: accepted\n---\n\n# Templates\n\nStart from [the template](../templates/adr.md.hbs).\n',
      },
    ]);
    expect(diagnostics).toEqual([]);
  });
});
