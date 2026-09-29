import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, main } from '../src/cli.js';
import { RULE_IDS, RULE_QUERIES } from '../src/rules.js';

/*
 * What each command prints and what it takes from the repository: the messages
 * a person reads, the fields a script parses, and the exit code CI reads.
 * Every test that writes to disk writes under a directory named for its
 * process (CLAUDE.md).
 */

const DEMO = 'tests/fixtures/demo';
const LEGACY = 'tests/fixtures/legacy';
const PROJECT = 'tests/fixtures/project';

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runIn(cwd: string, ...argv: string[]): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({
    argv,
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { NO_COLOR: '1', SPEC_GRAPH_ASCII: '1' },
    isTTY: false,
  });
  return { code, out, err };
}

const run = (...argv: string[]): Promise<Run> => runIn(process.cwd(), ...argv);
const absolute = (relative: string): string => `${process.cwd()}/${relative}`;

/** A repository written for one test, under a path named for this process, and removed after it. */
async function withRepo(name: string, files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const root = `tests/fixtures/.tmp/${name}-${process.pid}`;
  await rm(root, { recursive: true, force: true });
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(`${root}/${path}`), { recursive: true });
      await writeFile(`${root}/${path}`, text);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Three documents where an open question is handed to a retired one: one error, two pieces of evidence. */
const GHOST = {
  'docs/adr/0002-old.md': '---\nstatus: superseded by ADR-0003\n---\n\n# Old\n',
  'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
  'docs/adr/0004-cache.md':
    '---\nstatus: accepted\n---\n\n# Cache\n\n## Open Questions\n\n- [ ] Eviction policy? Deferred to [ADR-0002](0002-old.md).\n',
};

/** A retired decision that never says what replaced it: a warning and nothing else. */
const UNRECIPROCATED = {
  'docs/adr/0001-one.md': '---\nstatus: retired\n---\n\n# ADR-0001: One\n',
  'docs/adr/0002-two.md': '---\nstatus: accepted\nsupersedes: ADR-0001\n---\n\n# ADR-0002: Two\n',
};

describe('recording a baseline', () => {
  it('says how many findings it wrote down and in how many entries, counting one in the singular', async () => {
    // A repeat is one entry with a count, so findings and entries differ.
    await withRepo('cli-record', { 'docs/0001.md': '# ADR-0001: One\n\nSee [a](nope.md) and [b](nope.md), and [c](gone.md).\n' }, async (root) => {
      const recorded = await run('check', 'docs/**/*.md', '--root', root, '--no-config', '--record-baseline', 'b.json');
      expect(recorded).toEqual({ code: EXIT_OK, out: 'recorded 3 findings as 2 entries in b.json\n', err: '' });
    });
    await withRepo('cli-record-one', { 'docs/0001.md': '# ADR-0001: One\n\nSee [a](nope.md).\n' }, async (root) => {
      const recorded = await run('check', 'docs/**/*.md', '--root', root, '--no-config', '--record-baseline', 'b.json');
      expect(recorded.out).toBe('recorded 1 finding as 1 entry in b.json\n');
    });
    await withRepo('cli-record-none', { 'docs/0001.md': '# ADR-0001: One\n' }, async (root) => {
      const recorded = await run('check', 'docs/**/*.md', '--root', root, '--no-config', '--record-baseline', 'b.json');
      expect(recorded.out).toBe('recorded 0 findings as 0 entries in b.json\n');
    });
  });

  it('stops with exit 2, naming the file, when it cannot write it', async () => {
    await withRepo('cli-record-nowhere', { 'docs/0001.md': '# ADR-0001: One\n' }, async (root) => {
      const refused = await run('check', 'docs/**/*.md', '--root', root, '--no-config', '--record-baseline', 'missing/b.json');
      expect(refused.code).toBe(EXIT_ERROR);
      expect(refused.err).toMatch(/^spec-graph: cannot write missing\/b\.json: \S/);
      expect(refused.out).toBe('');
    });
  });
});

describe('what the configuration decides', () => {
  it('counts the problems that stopped the run', async () => {
    await withRepo('cli-one-problem', { '.spec-graph.json': '{ "nope": 1 }\n', 'docs/0001.md': '# ADR-0001: One\n' }, async (root) => {
      const stopped = await run('check', '--root', root);
      expect(stopped.err).toContain('spec-graph: 1 problem in the configuration, so nothing was checked\n');
    });
    await withRepo('cli-two-problems', { '.spec-graph.json': '{ "nope": 1, "nor": 2 }\n', 'docs/0001.md': '# ADR-0001: One\n' }, async (root) => {
      const stopped = await run('check', '--root', root);
      expect(stopped.err).toContain('spec-graph: 2 problems in the configuration, so nothing was checked\n');
    });
  });

  it('applies the severities it declares, and a --rule on the command line wins over them', async () => {
    const files = {
      '.spec-graph.json': '{ "patterns": ["docs/**/*.md"], "severities": { "broken-reference": "off" } }\n',
      'docs/0001.md': '# ADR-0001: One\n\nSee [a](nope.md).\n',
    };
    await withRepo('cli-severities', files, async (root) => {
      expect((await run('check', '--root', root)).code).toBe(EXIT_OK);
      expect((await run('check', '--root', root, '--rule', 'broken-reference=error')).code).toBe(EXIT_FAILED);
    });
  });

  it('raises every warning when it declares "strict"', async () => {
    const files = { '.spec-graph.json': '{ "patterns": ["docs/**/*.md"], "strict": true }\n', ...UNRECIPROCATED };
    await withRepo('cli-strict', files, async (root) => {
      const strict = await run('check', '--root', root);
      expect(strict.code).toBe(EXIT_FAILED);
      expect(strict.out).toContain('unreciprocated-supersession (strict: warn -> error)');
    });
  });

  it('fails on a baseline with slack in it when it declares "ratchet"', async () => {
    const files = { '.spec-graph.json': '{ "patterns": ["docs/**/*.md"], "baseline": "b.json", "ratchet": true }\n', ...GHOST };
    await withRepo('cli-ratchet', files, async (root) => {
      const { readFile, writeFile } = await import('node:fs/promises');
      expect((await run('check', '--root', root, '--record-baseline', 'b.json')).code).toBe(EXIT_OK);
      expect((await run('check', '--root', root)).code).toBe(EXIT_OK);
      const held = JSON.parse(await readFile(`${root}/b.json`, 'utf8')) as { findings: unknown[] };
      held.findings.push({ rule: 'broken-reference', document: 'ADR-0003', subject: 'docs/never.md', count: 1 });
      await writeFile(`${root}/b.json`, JSON.stringify(held));
      const loose = await run('check', '--root', root);
      expect(loose.code).toBe(EXIT_FAILED);
      expect(loose.out).toContain('the baseline is looser than the repository');
    });
  });

  it('caps the evidence under each finding at its "maxRelated"', async () => {
    const related = async (root: string): Promise<number[]> =>
      (JSON.parse((await run('check', '--root', root, '--format', 'json')).out) as { diagnostics: { related: unknown[] }[] }).diagnostics.map(
        (diagnostic) => diagnostic.related.length,
      );
    await withRepo('cli-related', { '.spec-graph.json': '{ "patterns": ["docs/**/*.md"] }\n', ...GHOST }, async (root) => {
      expect(await related(root)).toEqual([2]);
    });
    await withRepo('cli-related-one', { '.spec-graph.json': '{ "patterns": ["docs/**/*.md"], "maxRelated": 1 }\n', ...GHOST }, async (root) => {
      expect(await related(root)).toEqual([1]);
    });
  });
});

describe('a run that finds nothing to read', () => {
  it('names every pattern it tried, quoted, and where it looked', async () => {
    const result = await run('check', '--root', DEMO, 'nothing/*.md', 'nope/**/*.md');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe(`spec-graph: no specifications matched "nothing/*.md", "nope/**/*.md"\n  looked under ${DEMO}\n`);
  });
});

describe('the stale baseline entries a person is shown', () => {
  /** A copy of the legacy corpus, its baseline recorded, plus three entries for defects nobody has. */
  async function withSlack(body: (root: string) => Promise<void>): Promise<void> {
    const { cp, readFile, rm, writeFile } = await import('node:fs/promises');
    const root = `tests/fixtures/.tmp/cli-slack-${process.pid}`;
    await rm(root, { recursive: true, force: true });
    await cp(LEGACY, root, { recursive: true });
    try {
      await run('check', '--root', root, '--no-config', '--record-baseline', 'b.json');
      const held = JSON.parse(await readFile(`${root}/b.json`, 'utf8')) as { findings: unknown[] };
      held.findings.push(
        { rule: 'broken-reference', document: 'ADR-0003', subject: 'docs/never-existed.md', count: 1 },
        // A finding about a whole document has no subject.
        { rule: 'orphaned-obligation', document: 'ADR-0003', subject: '', count: 1 },
        { rule: 'broken-reference', document: 'ADR-0404', subject: 'docs/x.md', count: 1 },
      );
      await writeFile(`${root}/b.json`, JSON.stringify(held));
      await body(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('are counted by default and named under --verbose, each the way it can be struck', async () => {
    await withSlack(async (root) => {
      const quiet = await run('check', '--root', root, '--no-config', '--baseline', 'b.json');
      expect(quiet.code).toBe(EXIT_OK);
      expect(quiet.out).toContain('3 baseline entries no longer occur');
      expect(quiet.out).not.toMatch(/^ {2}(paid|gone):/m);

      const loud = await run('check', '--root', root, '--no-config', '--baseline', 'b.json', '--verbose');
      const named = loud.out.split('\n').filter((line) => /^ {2}(paid|gone):/.test(line));
      expect(named).toEqual([
        '  paid: broken-reference ADR-0003 "docs/never-existed.md"',
        '  gone: broken-reference ADR-0404 "docs/x.md" - ADR-0404 is not in this corpus',
        '  paid: orphaned-obligation ADR-0003',
      ]);
    });
  });
});

describe('SARIF from check', () => {
  it('carries the version of spec-graph that ran, the project rules that fired, and what --strict raised', async () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const sarif = await run('check', '--root', PROJECT, '--format', 'sarif', '--strict');
    const [only] = (
      JSON.parse(sarif.out) as {
        runs: {
          tool: { driver: { version: string; rules: { id: string; shortDescription: { text: string } }[] } };
          results: { ruleId: string; properties: { escalated: boolean } }[];
        }[];
      }
    ).runs;
    expect(only?.tool.driver.version).toBe(version);
    expect(only?.tool.driver.rules).toContainEqual(
      expect.objectContaining({ id: 'project:twice-over', shortDescription: { text: 'document[id=ADR-0002] | document[phase=draft]' } }),
    );
    const escalated = Object.fromEntries(only?.results.map((result) => [result.ruleId, result.properties.escalated]) ?? []);
    expect(escalated).toEqual({ 'project:no-draft-dependency': false, 'project:twice-over': true });
  });
});

describe('paths typed below the root', () => {
  const files = async (cwd: string, ...argv: string[]): Promise<string[]> => {
    const result = await runIn(cwd, 'query', 'document', ...argv, '--format', 'json');
    expect(result.code, result.err).toBe(EXIT_OK);
    return (JSON.parse(result.out) as { matches: { nodes: { file: string }[] }[] }).matches.map((match) => match.nodes[0]?.file as string).sort();
  };

  it('reads the same from a working directory written with trailing slashes', async () => {
    expect(await files(`${absolute(PROJECT)}/docs//`, '*.md')).toEqual(['docs/0001.md', 'docs/0002.md']);
    expect(await files(`${absolute(PROJECT)}/docs/`, '*.md')).toEqual(['docs/0001.md', 'docs/0002.md']);
    // One directory down, however it was written, is one `../` to the file.
    const verbose = await runIn(`${absolute(PROJECT)}/docs//`, 'check', '--verbose', '--format', 'markdown');
    expect(verbose.err).toBe('configuration: ../.spec-graph.json\n');
  });

  it('prunes a bare --ignore name at any depth, and anchors a path or a glob where it was typed', async () => {
    // A bare name is a directory wherever it is, as a .gitignore line is.
    expect(await files(absolute(`${PROJECT}/docs/deep`), '--ignore', 'deep')).toEqual(['docs/0001.md', 'docs/0002.md']);
    // So is one with a `!` before it, which gives the name back.
    const all = ['docs/0001.md', 'docs/0002.md', 'docs/deep/0003.md'];
    expect(await files(absolute(`${PROJECT}/docs/deep`), '--ignore', 'deep', '--ignore', '!deep')).toEqual(all);
    // A path, or a glob, means the one below the directory it was typed in.
    expect(await files(absolute(`${PROJECT}/docs`), '--ignore', 'deep/0003.md')).toEqual(['docs/0001.md', 'docs/0002.md']);
    expect(await files(absolute(`${PROJECT}/docs/deep`), '--ignore', '*.md')).toEqual(['docs/0001.md', 'docs/0002.md']);
    expect(await files(absolute(PROJECT), '--ignore', '*.md')).toEqual(['docs/0001.md', 'docs/0002.md', 'docs/deep/0003.md']);
  });

  it('reads a directory the walk skips when a plain name names it, wherever it was typed', async () => {
    // Each of these found no specification, and stopped with exit 2.
    const repo = { '.spec-graph.json': '{}\n', 'vendor/0001.md': '# One\n', 'docs/vendor/0002.md': '# Two\n', 'docs/0003.md': '# Three\n' };
    await withRepo('cli-plain-vendor', repo, async (root) => {
      expect(await files(absolute(root), 'vendor')).toEqual(['vendor/0001.md']);
      expect(await files(absolute(root), 'docs/vendor')).toEqual(['docs/vendor/0002.md']);
      expect(await files(absolute(`${root}/docs`), 'vendor')).toEqual(['docs/vendor/0002.md']);
    });
  });
});

describe('a brace alternative with a leading slash', () => {
  // spec-core 7e41240 reads the slash as the same text written alone reads it:
  // rooted at the filesystem's root, which no path under the root is, and for
  // `--ignore-ref` part of the text a link wrote. It was dropped, so `{/docs,x}`
  // read `docs`: the patterns to check read `docs`, `--ignore` took it out, and
  // `--ignore-ref` passed over the target `docs/a.md` and not `/docs/a.md`.
  const REPO = {
    '.spec-graph.json': '{}\n',
    'docs/0001-alpha.md': '---\nstatus: accepted\n---\n# ADR-0001: Alpha\n\nSee [rooted](/docs/a.md) and [relative](docs/a.md).\n',
    'x/0002-beta.md': '---\nstatus: accepted\n---\n# ADR-0002: Beta\n\nText.\n',
  };

  /** What a run read and reported, without the time it took. */
  const report = async (root: string, ...argv: string[]) => {
    const result = await run('check', '--root', root, '--format', 'json', ...argv);
    if (result.out === '') return { code: result.code, err: result.err };
    const json = JSON.parse(result.out) as {
      summary: { durationMs?: number };
      files: string[];
      diagnostics: { target?: string }[];
      suppressed: { target: string }[];
    };
    delete json.summary.durationMs;
    return {
      code: result.code,
      err: result.err,
      files: json.files,
      reported: json.diagnostics.map((diagnostic) => diagnostic.target),
      passedOver: json.suppressed.map((suppressed) => suppressed.target),
      json,
    };
  };

  it('reads as the same text written alone, in the patterns to check, --ignore and --ignore-ref', async () => {
    await withRepo('cli-rooted-alternative', REPO, async (root) => {
      const checked = await report(root, '{/docs/*.md,x/*.md}');
      expect(checked).toMatchObject({ code: EXIT_OK, files: ['x/0002-beta.md'] });
      expect(checked).toEqual(await report(root, '/docs/*.md', 'x/*.md'));

      const ignored = await report(root, '**/*.md', '--ignore', '{/docs,x}');
      expect(ignored).toMatchObject({ code: EXIT_FAILED, files: ['docs/0001-alpha.md'] });
      expect(ignored).toEqual(await report(root, '**/*.md', '--ignore', '/docs', '--ignore', 'x'));

      const passed = await report(root, '**/*.md', '--ignore-ref', '{/docs/a.md,x}');
      expect(passed).toMatchObject({ code: EXIT_FAILED, reported: ['docs/a.md'], passedOver: ['/docs/a.md'] });
      expect(passed).toEqual(await report(root, '**/*.md', '--ignore-ref', '/docs/a.md', '--ignore-ref', 'x'));
    });
  });

  it('reads as the same text written alone in the configuration', async () => {
    const { writeFile } = await import('node:fs/promises');
    await withRepo('cli-rooted-alternative-config', REPO, async (root) => {
      const configured = async (config: object, ...argv: string[]) => {
        await writeFile(`${root}/.spec-graph.json`, JSON.stringify(config));
        return report(root, ...argv);
      };
      const checked = await configured({ patterns: ['{/docs/*.md,x/*.md}'] });
      expect(checked).toMatchObject({ files: ['x/0002-beta.md'] });
      expect(checked).toEqual(await configured({ patterns: ['/docs/*.md', 'x/*.md'] }));
      const ignored = await configured({ ignore: ['{/docs,x}'] }, '**/*.md');
      expect(ignored).toMatchObject({ files: ['docs/0001-alpha.md'] });
      expect(ignored).toEqual(await configured({ ignore: ['/docs', 'x'] }, '**/*.md'));
      const passed = await configured({ ignoreReferences: ['{/docs/a.md,x}'] }, '**/*.md');
      expect(passed).toMatchObject({ reported: ['docs/a.md'], passedOver: ['/docs/a.md'] });
      expect(passed).toEqual(await configured({ ignoreReferences: ['/docs/a.md', 'x'] }, '**/*.md'));
    });
  });
});

describe('the rules command', () => {
  const ROW = /^(\S+)( +)(error|warn|info|off)( +)(.+)$/;

  it('lists one line a rule, with the severity and the description each in a column of its own', async () => {
    const lines = (await run('rules', '--no-config')).out.trimEnd().split('\n');
    expect(lines.map((line) => ROW.exec(line)?.[1])).toEqual([...RULE_IDS]);
    const columns = new Set(lines.map((line) => line.indexOf(ROW.exec(line)?.[3] as string, (ROW.exec(line)?.[1] as string).length)));
    expect(columns.size).toBe(1);
    const descriptions = new Set(lines.map((line) => line.length - (ROW.exec(line)?.[5] as string).length));
    expect(descriptions.size).toBe(1);
  });

  it('sets each selector and the decision behind it under the description with --explain, and no selector a rule lacks', async () => {
    const lines = (await run('rules', '--explain', '--no-config')).out.trimEnd().split('\n');
    expect(lines.join('\n')).not.toContain('undefined');
    const rows = lines.flatMap((line, index) => (ROW.test(line) && !line.startsWith(' ') ? [index] : []));
    expect(rows).toHaveLength(RULE_IDS.length);
    for (const [position, index] of rows.entries()) {
      const row = lines[index] as string;
      const id = ROW.exec(row)?.[1] as keyof typeof RULE_QUERIES;
      const column = row.length - (ROW.exec(row)?.[5] as string).length;
      const under = lines.slice(index + 1, rows[position + 1] ?? lines.length);
      expect(under.map((line) => line.trimStart()), id).toEqual([
        ...(RULE_QUERIES[id] === undefined ? [] : [RULE_QUERIES[id]]),
        expect.stringMatching(/^https:\/\/github\.com\/DescentVTT\/spec-graph\/blob\/v[^/]+\/docs\/adr\/\d{4}-[a-z0-9-]+\.md$/),
      ]);
      for (const line of under) expect(line.length - line.trimStart().length, line).toBe(column);
    }
  });

  it('describes a project rule by its first selector, sets the rest under it, and names the file that declared it', async () => {
    const config = {
      patterns: ['docs/**/*.md'],
      rules: {
        single: { query: 'document[id=ADR-0001]', message: '{0}' },
        three: { query: ['document[id=ADR-0001]', 'document[id=ADR-0002]', 'document[phase=draft]'], message: '{0}' },
      },
    };
    await withRepo('cli-rules-explain', { '.spec-graph.json': JSON.stringify(config), 'docs/0001.md': '# ADR-0001: One\n' }, async (root) => {
      const single = (await run('rules', 'project:single', '--explain', '--root', root)).out.split('\n');
      expect(single.map((line) => line.trim())).toEqual(['project:single  warn   document[id=ADR-0001]', '.spec-graph.json: rules.single', '']);
      const three = (await run('rules', 'project:three', '--explain', '--root', root)).out.split('\n');
      expect(three.map((line) => line.trim())).toEqual([
        'project:three  warn   document[id=ADR-0001]',
        'document[id=ADR-0002] | document[phase=draft]',
        '.spec-graph.json: rules.three',
        '',
      ]);
    });
  });

  it('names every project rule the repository declares when asked for one it does not', async () => {
    const refused = await run('rules', 'project:nope', '--root', PROJECT);
    expect(refused.code).toBe(EXIT_ERROR);
    expect(refused.err).toContain('\n  project rules here: project:no-draft-dependency, project:twice-over\n');
  });
});

describe('the query command', () => {
  it('prints each match above where it is written, then how many there were', async () => {
    const documents = await run('query', 'document[phase=retired]', '--root', DEMO);
    expect(documents.out.split('\n')).toEqual([
      'ADR-0002',
      '  docs/adr/0002-single-node-storage.md:1:1',
      'ADR-0005',
      '  docs/adr/archive/0005-legacy-queue.md:1:1',
      '2 matches',
      '',
    ]);
    // A path is printed with where it starts and where it ends.
    const path = await run('query', 'item[openness=open] -delegates-to-> document[phase=retired]', '--root', DEMO);
    const lines = path.out.split('\n');
    expect(lines[0]).toBe('ADR-0003#open-questions.1 -delegates-to-> ADR-0002');
    expect(lines[1]).toMatch(/^ {2}docs\/adr\/0003-event-log\.md:13:\d+ {2}docs\/adr\/0002-single-node-storage\.md:1:1$/);
    expect(lines.slice(2)).toEqual(['1 match', '']);
  });

  it('gives each match in JSON its relations and, for an item, its state rather than a phase', async () => {
    const json = await run('query', 'item[openness=open] -delegates-to-> document[phase=retired]', '--root', DEMO, '--format', 'json');
    const [match] = (
      JSON.parse(json.out) as { matches: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }[] }
    ).matches;
    expect(match?.edges).toEqual([
      { kind: 'delegates-to', from: 'ADR-0003#open-questions.1', to: 'ADR-0002', file: 'docs/adr/0003-event-log.md', line: 13 },
    ]);
    const [item, document] = match?.nodes ?? [];
    expect(item).toMatchObject({ kind: 'item', state: 'unresolved', openness: 'open' });
    expect(item).not.toHaveProperty('phase');
    expect(document).toMatchObject({ kind: 'document', phase: 'retired' });
    expect(document).not.toHaveProperty('openness');
  });

  it('points its caret at the character the selector went wrong on', async () => {
    const selector = 'document -invents-> document';
    const refused = await run('query', selector, '--root', DEMO);
    const [, echoed, caret] = refused.err.split('\n');
    expect(echoed).toBe(`  ${selector}`);
    expect(caret?.indexOf('^')).toBe(2 + selector.indexOf('invents'));
    expect(caret?.trim()).toBe('^');
  });

  it('runs every selector of a project rule, and tells two paths apart even when their ids run together', async () => {
    // `ab -> c` and `a -> bc` are two paths whose ids, run together, spell the
    // same word. A union keyed on that word would print one.
    const config = {
      patterns: ['docs/**/*.md'],
      rules: {
        'run-together': { query: ['document[id=ab] -depends-on-> document', 'document[id=a] -depends-on-> document'], message: '{0} rests on {1}' },
      },
    };
    const document = (id: string, dependsOn?: string): string =>
      `---\nid: ${id}\nstatus: accepted\n${dependsOn === undefined ? '' : `depends-on: ${dependsOn}\n`}---\n\n# ${id}\n`;
    const files = {
      '.spec-graph.json': JSON.stringify(config),
      'docs/ab.md': document('ab', 'c'),
      'docs/c.md': document('c'),
      'docs/a.md': document('a', 'bc'),
      'docs/bc.md': document('bc'),
    };
    await withRepo('cli-union', files, async (root) => {
      const matched = await run('query', 'project:run-together', '--root', root);
      expect(matched.code).toBe(EXIT_OK);
      expect(matched.out.split('\n').filter((line) => line.includes('-depends-on->'))).toEqual(['ab -depends-on-> c', 'a -depends-on-> bc']);
      expect(matched.out).toContain('\n2 matches\n');
    });
  });
});
