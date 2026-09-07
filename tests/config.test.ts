import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, parseConfig, CONFIG_FILES, CONFIG_PACKAGE_KEY } from '../src/config.js';
import { createFamilyFilter, analyseSources, type Source } from '../src/runner.js';
import type { RuleId } from '../src/types.js';

/**
 * Repository configuration, and the family rules it carries.
 *
 * A CI invocation carrying eight `--ignore-ref` arguments is a configuration
 * file that has not admitted what it is. See ADR-0010.
 */

const ROOT = 'tests/fixtures/.tmp/config';

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const write = async (name: string, body: string): Promise<void> => {
  await mkdir(ROOT, { recursive: true });
  await writeFile(`${ROOT}/${name}`, body);
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

describe('parsing a configuration', () => {
  it('reads every key', () => {
    const { config, problems } = parseConfig(
      JSON.stringify({
        patterns: ['docs/**/*.md'],
        ignore: ['drafts'],
        ignoreReferences: ['trap *'],
        families: ['ADR'],
        ignoreFamilies: ['RFC'],
        severities: { 'self-reference': 'off' },
        strict: true,
        maxRelated: 3,
      }),
      'test',
    );
    expect(problems).toEqual([]);
    expect(config).toEqual({
      patterns: ['docs/**/*.md'],
      ignore: ['drafts'],
      ignoreReferences: ['trap *'],
      families: ['ADR'],
      ignoreFamilies: ['RFC'],
      severities: { 'self-reference': 'off' },
      strict: true,
      maxRelated: 3,
    });
  });

  it('reports malformed JSON rather than throwing', () => {
    // A broken config must not stop a team seeing the findings it was going to
    // show them anyway.
    const { config, problems } = parseConfig('{ not json', 'test');
    expect(config).toEqual({});
    expect(problems[0]).toContain('not valid JSON');
  });

  it('rejects a top-level value that is not an object', () => {
    expect(parseConfig('[]', 'test').problems[0]).toContain('must contain a JSON object');
    expect(parseConfig('"x"', 'test').problems[0]).toContain('must contain a JSON object');
  });

  it('reports a key of the wrong type, and drops only that key', () => {
    const { config, problems } = parseConfig(
      JSON.stringify({ patterns: 'docs/**/*.md', ignore: ['ok'] }),
      'test',
    );
    expect(problems[0]).toContain('"patterns" must be an array of strings');
    expect(config.patterns).toBeUndefined();
    expect(config.ignore).toEqual(['ok']);
  });

  it('reports a list containing a non-string', () => {
    expect(parseConfig(JSON.stringify({ ignore: ['a', 3] }), 'test').problems[0]).toContain('array of strings');
  });

  it('reports an unknown rule and an unknown severity separately', () => {
    const { config, problems } = parseConfig(
      JSON.stringify({ severities: { 'not-a-rule': 'off', 'self-reference': 'loud', 'state-conflict': 'error' } }),
      'test',
    );
    expect(problems.some((p) => p.includes('unknown rule "not-a-rule"'))).toBe(true);
    expect(problems.some((p) => p.includes('"severities.self-reference"'))).toBe(true);
    // The valid entry survives its neighbours being wrong.
    expect(config.severities).toEqual({ 'state-conflict': 'error' });
  });

  it('reports an unknown key rather than ignoring a typo', () => {
    // A silently ignored `ignoreReference` is a config that looks applied and is not.
    expect(parseConfig(JSON.stringify({ ignoreReference: ['x'] }), 'test').problems[0]).toContain(
      'unknown key "ignoreReference"',
    );
  });

  it('tolerates $schema, so an editor can be pointed at one', () => {
    expect(parseConfig(JSON.stringify({ $schema: 'https://example.com/s.json' }), 'test').problems).toEqual([]);
  });

  it('rejects a non-integer maxRelated', () => {
    expect(parseConfig(JSON.stringify({ maxRelated: -1 }), 'test').problems[0]).toContain('non-negative');
    expect(parseConfig(JSON.stringify({ maxRelated: 1.5 }), 'test').problems[0]).toContain('whole number');
  });
});

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

describe('finding a configuration', () => {
  it('finds nothing when there is nothing', async () => {
    await mkdir(ROOT, { recursive: true });
    expect(loadConfig(ROOT)).toEqual({ config: {}, source: null, problems: [] });
  });

  it('prefers the first file name in the documented order', async () => {
    await write(CONFIG_FILES[1] as string, JSON.stringify({ ignore: ['second'] }));
    expect(loadConfig(ROOT).config.ignore).toEqual(['second']);

    await write(CONFIG_FILES[0] as string, JSON.stringify({ ignore: ['first'] }));
    expect(loadConfig(ROOT).config.ignore).toEqual(['first']);
    expect(loadConfig(ROOT).source).toBe(CONFIG_FILES[0]);
  });

  it('reads a file a Windows editor saved with a byte-order mark', async () => {
    // JSON.parse rejects a BOM. A config that silently stops applying because
    // of an invisible first character is the worst kind of configuration bug.
    const mark = String.fromCharCode(0xfeff);
    await write(CONFIG_FILES[0] as string, mark + JSON.stringify({ ignore: ['marked'] }));
    expect(loadConfig(ROOT)).toEqual({ config: { ignore: ['marked'] }, source: CONFIG_FILES[0], problems: [] });

    await rm(`${ROOT}/${CONFIG_FILES[0] as string}`);
    await write('package.json', mark + JSON.stringify({ name: 'x', [CONFIG_PACKAGE_KEY]: { strict: true } }));
    expect(loadConfig(ROOT).config.strict).toBe(true);

    expect(parseConfig(mark + '{"strict":true}', 'x.json').problems).toEqual([]);
  });

  it('falls back to the package.json key', async () => {
    await write('package.json', JSON.stringify({ name: 'x', [CONFIG_PACKAGE_KEY]: { ignore: ['from-package'] } }));
    const loaded = loadConfig(ROOT);
    expect(loaded.config.ignore).toEqual(['from-package']);
    expect(loaded.source).toContain('package.json');
  });

  it('ignores a package.json with no key of ours', async () => {
    await write('package.json', JSON.stringify({ name: 'x' }));
    expect(loadConfig(ROOT)).toEqual({ config: {}, source: null, problems: [] });
  });

  it('reports a package.json key that is not an object', async () => {
    await write('package.json', JSON.stringify({ [CONFIG_PACKAGE_KEY]: 'nope' }));
    expect(loadConfig(ROOT).problems[0]).toContain('must be an object');
  });

  it('survives an unreadable package.json', async () => {
    await write('package.json', '{ broken');
    expect(loadConfig(ROOT)).toEqual({ config: {}, source: null, problems: [] });
  });

  it('lets a dedicated file win over the package.json key', async () => {
    await write('package.json', JSON.stringify({ [CONFIG_PACKAGE_KEY]: { ignore: ['package'] } }));
    await write(CONFIG_FILES[0] as string, JSON.stringify({ ignore: ['file'] }));
    expect(loadConfig(ROOT).config.ignore).toEqual(['file']);
  });
});

/* -------------------------------------------------------------------------- */
/* Family rules                                                               */
/* -------------------------------------------------------------------------- */

describe('the family filter', () => {
  it('is absent when neither list is given', () => {
    expect(createFamilyFilter(undefined, undefined)).toBeUndefined();
    expect(createFamilyFilter([], [])).toBeUndefined();
  });

  it('denies the families it is told to', () => {
    const filter = createFamilyFilter(undefined, ['RFC']);
    expect(filter?.('RFC')).toBe(true);
    expect(filter?.('rfc')).toBe(true);
    expect(filter?.('ADR')).toBe(false);
  });

  it('allows only the families it is told to', () => {
    const filter = createFamilyFilter(['ADR', 'KEP'], undefined);
    expect(filter?.('ADR')).toBe(false);
    expect(filter?.('KEP')).toBe(false);
    expect(filter?.('RFC')).toBe(true);
    expect(filter?.('PHASE')).toBe(true);
  });

  it('lets a denial beat an allowance', () => {
    const filter = createFamilyFilter(['ADR', 'RFC'], ['RFC']);
    expect(filter?.('ADR')).toBe(false);
    expect(filter?.('RFC')).toBe(true);
  });

  it('trims what it is given', () => {
    expect(createFamilyFilter(undefined, ['  rfc  '])?.('RFC')).toBe(true);
  });
});

describe('family rules in a corpus', () => {
  const files: Source[] = [
    { path: 'docs/rfcs/0001-a.md', text: '# A\n' },
    { path: 'docs/rfcs/0002-b.md', text: '# B\n\nKey words per RFC 2119. Builds on RFC 0001.\n' },
  ];
  const rules = (options: Parameters<typeof analyseSources>[1]): RuleId[] =>
    analyseSources(files, options).diagnostics.map((d) => d.rule);

  it('reports a citation of a standard the repository does not hold', () => {
    // The canonical false positive: every specification cites RFC 2119, and a
    // repository with its own RFC-* documents reads that as a local one.
    expect(rules({})).toEqual(['broken-reference']);
  });

  it('goes quiet once the family is declared not ours', () => {
    expect(rules({ isIgnoredFamily: createFamilyFilter(undefined, ['RFC']) })).toEqual([]);
  });

  it('goes quiet under an allowlist that excludes it', () => {
    expect(rules({ isIgnoredFamily: createFamilyFilter(['ADR'], undefined) })).toEqual([]);
  });

  it('never costs an edge that resolved', () => {
    // The filter runs only after resolution failed, so a real relation survives.
    const { graph } = analyseSources(files, { isIgnoredFamily: createFamilyFilter(undefined, ['RFC']) });
    expect(graph.out('RFC-0002').some((edge) => edge.to === 'RFC-0001')).toBe(true);
  });

  it('leaves prose that never looked like a family alone either way', () => {
    const prose: Source[] = [
      { path: 'docs/adr/0001-a.md', text: '# A\n\nPhase 1 ran in R69 with Q-120 at Step 4, see Table 2.\n' },
    ];
    // Already silent: an opportunistic identifier needs a family witness in the
    // corpus before it is read as a citation at all.
    expect(analyseSources(prose).diagnostics).toEqual([]);
  });
});

describe('the newer keys', () => {
  it('reads history patterns as a list of globs', () => {
    const parsed = parseConfig(JSON.stringify({ historyPatterns: ['**/JOURNAL_*.md'] }), 'c.json');
    expect(parsed.config.historyPatterns).toEqual(['**/JOURNAL_*.md']);
    expect(parsed.problems).toEqual([]);
    expect(parseConfig(JSON.stringify({ historyPatterns: 'one' }), 'c.json').problems[0]).toContain('array of strings');
  });

  it('reads a baseline path, and refuses one that is not a path', () => {
    expect(parseConfig(JSON.stringify({ baseline: '.spec-graph-baseline.json' }), 'c.json').config.baseline).toBe(
      '.spec-graph-baseline.json',
    );
    for (const bad of [7, '', '   ', null]) {
      const parsed = parseConfig(JSON.stringify({ baseline: bad }), 'c.json');
      expect(parsed.problems[0]).toContain('"baseline" must be a path');
      expect(parsed.config.baseline).toBeUndefined();
    }
  });

  it('leaves both unset when neither is written', () => {
    const parsed = parseConfig('{}', 'c.json');
    expect(parsed.config.historyPatterns).toBeUndefined();
    expect(parsed.config.baseline).toBeUndefined();
    expect(parsed.problems).toEqual([]);
  });
});
