import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverConfig, loadConfig, parseConfig, CONFIG_FILES, CONFIG_PACKAGE_KEY } from '../src/config.js';
import { createFamilyFilter, analyseSources, type Source } from '../src/runner.js';
import type { AnyRuleId } from '../src/types.js';

/**
 * Repository configuration, and the family rules it carries.
 *
 * A CI invocation carrying eight `--ignore-ref` arguments is a configuration
 * file that has not admitted what it is. See ADR-0010.
 */

// Named for the process. Stryker runs this file in several workers at once, all
// in one sandbox, and a fixed path is one they write and delete under each other:
// the 2026-09-14 sweep counted dozens of mutants killed by ENOENT alone.
const ROOT = `tests/fixtures/.tmp/config-${process.pid}`;

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
        ratchet: true,
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
      ratchet: true,
      maxRelated: 3,
    });
  });

  it('reports malformed JSON rather than throwing', () => {
    // Collected rather than thrown, so the reader is handed every problem in
    // the file at once instead of the first one. What a problem costs is the
    // caller's to decide, and the CLI stops the run on any of them.
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

  it('reports a rule whose message names an attribute nothing has', () => {
    // "{1.phse}" for "{1.phase}", found on an 885-document repository. The rule
    // compiles here or it does not run at all, so the typo has to surface as a
    // problem of the file rather than as a rule that quietly matches nothing.
    const { config, problems } = parseConfig(
      JSON.stringify({
        rules: { 'no-draft-dependency': { query: 'document -depends-on-> document', message: '{0} needs {1.phse}' } },
      }),
      'test',
    );
    expect(problems.some((p) => p.includes('{1.phse}'))).toBe(true);
    expect(config.rules).toEqual([]);
  });

  it('names the file in every problem, so the reader knows which one to open', () => {
    // Discovery walks upward, and the file that did not load is often not the
    // one in front of them. A problem that names no file names the wrong one.
    const sources = [
      parseConfig('{ not json', 'spec-graph.config.json'),
      parseConfig(JSON.stringify({ nope: 1, strict: 'yes' }), '.spec-graph.json'),
    ];
    for (const { source, problems } of sources) {
      expect(problems.length).toBeGreaterThan(0);
      for (const problem of problems) expect(problem, problem).toContain(source as string);
    }
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
    expect(parseConfig('{"ratchet":"yes"}', 'x.json').problems).toEqual(['x.json: "ratchet" must be true or false']);
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

  it('reports a package.json key that is not an object, and says it was package.json', async () => {
    // The problem stops the run, and a reader sent to .spec-graph.json by a
    // message that named no file would be looking for a file that is not there.
    await write('package.json', JSON.stringify({ [CONFIG_PACKAGE_KEY]: 'nope' }));
    const loaded = loadConfig(ROOT);
    expect(loaded.source).toBe('package.json');
    expect(loaded.problems).toEqual([`package.json: "${CONFIG_PACKAGE_KEY}" must be an object`]);
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
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

describe('discovering a configuration upward', () => {
  /**
   * A directory tree as a map of path to contents.
   *
   * Injected rather than written to disk, because what is under test is the
   * order the walk visits directories in, and a temporary tree would test the
   * filesystem's opinion of that as well as ours.
   */
  const tree = (files: Readonly<Record<string, string>>) => {
    const read = (path: string): string => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`ENOENT ${path}`);
      return hit;
    };
    return { read, exists: (path: string): boolean => path in files };
  };

  const CONFIG = CONFIG_FILES[0] as string;

  it('reads the configuration in the starting directory, and stays there', () => {
    const io = tree({ [`/repo/${CONFIG}`]: '{"strict":true}', '/repo/.git': '' });
    const found = discoverConfig('/repo', io);
    expect(found.root).toBe('/repo');
    expect(found.config.strict).toBe(true);
  });

  it('walks up until it finds one, and makes that directory the root', () => {
    const io = tree({ [`/repo/${CONFIG}`]: '{"strict":true}', '/repo/.git': '' });
    const found = discoverConfig('/repo/packages/auth/docs', io);
    expect(found.root).toBe('/repo');
    expect(found.source).toBe(CONFIG);
    expect(found.config.strict).toBe(true);
  });

  it('lets the nearest configuration win', () => {
    const io = tree({
      [`/repo/${CONFIG}`]: '{"ignore":["root"]}',
      [`/repo/packages/auth/${CONFIG}`]: '{"ignore":["package"]}',
      '/repo/.git': '',
    });
    const found = discoverConfig('/repo/packages/auth/docs', io);
    expect(found.root).toBe('/repo/packages/auth');
    expect(found.config.ignore).toEqual(['package']);
  });

  it('stops at the repository, and never reads above it', () => {
    // A configuration file in a home directory or a parent checkout is one
    // nobody in this repository can see, and a run that silently picked it up
    // would be worse than no discovery at all.
    const io = tree({ [`/home/${CONFIG}`]: '{"strict":true}', '/home/repo/.git': '' });
    const found = discoverConfig('/home/repo/docs', io);
    expect(found.source).toBeNull();
    expect(found.root).toBe('/home/repo/docs');
  });

  it('gives back the starting directory when there is nothing to find', () => {
    const found = discoverConfig('/repo/docs', tree({}));
    expect(found).toEqual({ config: {}, source: null, problems: [], root: '/repo/docs' });
  });

  it('stops on a package.json that carries the key, and walks past one that does not', () => {
    const bare = tree({
      '/repo/packages/auth/package.json': '{"name":"auth"}',
      [`/repo/${CONFIG}`]: '{"ignore":["root"]}',
      '/repo/.git': '',
    });
    expect(discoverConfig('/repo/packages/auth', bare).root).toBe('/repo');

    const carrying = tree({
      '/repo/packages/auth/package.json': `{"name":"auth","${CONFIG_PACKAGE_KEY}":{"ignore":["package"]}}`,
      [`/repo/${CONFIG}`]: '{"ignore":["root"]}',
      '/repo/.git': '',
    });
    const found = discoverConfig('/repo/packages/auth', carrying);
    expect(found.root).toBe('/repo/packages/auth');
    expect(found.config.ignore).toEqual(['package']);
  });

  it('stops on a configuration it cannot read, rather than falling through to a parent', () => {
    // Silently checking against the parent's configuration because this one has
    // a trailing comma in it is the worst available answer.
    const io = tree({
      [`/repo/packages/auth/${CONFIG}`]: '{ broken',
      [`/repo/${CONFIG}`]: '{"ignore":["root"]}',
      '/repo/.git': '',
    });
    const found = discoverConfig('/repo/packages/auth', io);
    expect(found.root).toBe('/repo/packages/auth');
    expect(found.problems[0]).toContain('not valid JSON');
    expect(found.config.ignore).toBeUndefined();
  });

  it('tolerates a path with a trailing separator', () => {
    const io = tree({ [`/repo/${CONFIG}`]: '{}', '/repo/.git': '' });
    expect(discoverConfig('/repo/docs/', io).root).toBe('/repo');
    // Including when the walk finds nothing and hands the start back: the root
    // is what every path in the run is relative to, so it is normalised once
    // here rather than everywhere it is joined.
    expect(discoverConfig('/repo/docs//', tree({})).root).toBe('/repo/docs');
  });

  it('gives up at the top of a relative path rather than reading the filesystem root', () => {
    // Only tests and `--root` produce a relative start, and `--root` turns
    // discovery off - so the useful property is that the walk terminates.
    expect(discoverConfig('docs/adr', tree({})).root).toBe('docs/adr');
  });

  it("stops at a linked worktree's .git file, which is not a directory", async () => {
    // The injected tree cannot tell a file from a directory, and this is where
    // the difference matters. A linked worktree has a `.git` file pointing at its
    // main checkout, and one nested inside that checkout is common. A boundary
    // that asked for a directory would walk out of the worktree and read the
    // main checkout's configuration - another branch's rules, silently.
    const base = `tests/fixtures/.tmp/worktree-${process.pid}`;
    await rm(base, { recursive: true, force: true });
    await mkdir(`${base}/nested/docs`, { recursive: true });
    await writeFile(`${base}/${CONFIG}`, '{"strict":true}');
    await writeFile(`${base}/nested/.git`, 'gitdir: ../.git/worktrees/nested\n');
    try {
      const found = discoverConfig(`${base}/nested/docs`);
      expect(found.source).toBeNull();
      expect(found.root).toBe(`${base}/nested/docs`);

      // And the file is what stopped it: without one, the same walk escapes.
      await rm(`${base}/nested/.git`);
      expect(discoverConfig(`${base}/nested/docs`).root).toBe(base);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
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
  const rules = (options: Parameters<typeof analyseSources>[1]): AnyRuleId[] =>
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
