import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError } from '../src/cli.js';

/*
 * An input that is set and names nothing is refused: exit 2 and one line that
 * names it, never a run that reads it as if it had not been given (ADR-0010,
 * amended 2026-10-09). Each refusal stands beside the nearest input that is
 * still taken, which is the half that matters. Every test that writes to disk
 * writes under a directory named for its process (CLAUDE.md).
 */

/** One document citing a standard its repository does not hold: one error. */
const RFCS = ['docs/**/*.md', '--root', 'tests/fixtures/rfcs'];
const PROJECT = 'tests/fixtures/project';
const NOWHERE = 'tests/fixtures/no-such-directory';

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

const usage = (argv: string[]): string => {
  try {
    parseArgs(argv, '/repo');
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`${argv.join(' ')} parsed`);
};

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

describe('a family option given a name no family has', () => {
  // What an unset variable leaves, a list typed where one name goes, an
  // identifier, two names, and a number first.
  const NAMELESS = ['', ' ', ',', 'ADR,RFC', 'ADR-0001', 'ADR RFC', '9A'];

  it('is refused by the option and what it holds', () => {
    for (const flag of ['--family', '--ignore-family']) {
      for (const value of NAMELESS) {
        expect(usage([flag, value])).toBe(`${flag} expects one family's name, such as ADR, got "${value}"`);
      }
    }
  });

  it('takes a name a family has, in any case, with a digit or an underscore in it, and the spaces a shell variable brings', () => {
    const options = parseArgs(['--family', ' adr ', '--family', 'S3', '--ignore-family', 'A_B'], '/repo');
    expect(options.families).toEqual([' adr ', 'S3']);
    expect(options.ignoreFamilies).toEqual(['A_B']);
  });

  it('stops the run that an allowlist of nothing used to pass', async () => {
    // `--family "$FAMILIES"` with the variable unset allowed no family, so the
    // citation below was prose and the run exited 0.
    expect((await run('check', ...RFCS)).code).toBe(EXIT_FAILED);
    expect(await run('check', ...RFCS, '--family', '')).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-graph: --family expects one family\'s name, such as ADR, got ""\n',
    });
  });
});

describe('a --root that is no directory', () => {
  const COMMANDS = [['check'], ['query', 'document'], ['graph'], ['rules']];

  it('is refused when it is blank, before anything is read', () => {
    for (const blank of ['', '  ']) expect(usage(['--root', blank])).toBe(`--root expects a directory, got "${blank}"`);
  });

  it('is refused by every command that reads one, when nothing is there', async () => {
    for (const command of COMMANDS) {
      expect(await run(...command, '--root', NOWHERE), command[0]).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: --root "${NOWHERE}" is not there\n`,
      });
    }
  });

  it('is refused by every command that reads one, when it is a file', async () => {
    for (const command of COMMANDS) {
      expect(await run(...command, '--root', 'package.json'), command[0]).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: 'spec-graph: --root "package.json" is not a directory\n',
      });
    }
  });

  it('lists the rules a root declares, where it is a directory', async () => {
    const listed = await run('rules', '--root', PROJECT);
    expect(listed.code).toBe(EXIT_OK);
    expect(listed.out).toContain('project:no-draft-dependency');
  });

  it('leaves a directory with nothing in it to the patterns, which say what they looked for', async () => {
    await withRepo('refusals-empty-root', { 'keep.txt': '' }, async (root) => {
      const result = await run('check', '--root', root, '--no-config', 'docs/**/*.md');
      expect(result.code).toBe(EXIT_ERROR);
      expect(result.err).toBe(`spec-graph: no specifications matched "docs/**/*.md"\n  looked under ${root}\n`);
    });
  });

  it('is the option, and not the directory a run was started in', async () => {
    // Only a root somebody named is theirs to get wrong.
    const started = await runIn(NOWHERE, 'rules', '--no-config');
    expect(started.code).toBe(EXIT_OK);
    expect(started.err).toBe('');
  });
});

describe('a baseline whose path is blank', () => {
  it('is refused by the option and what it holds', () => {
    for (const flag of ['--baseline', '--record-baseline']) {
      for (const blank of ['', ' ']) expect(usage([flag, blank])).toBe(`${flag} expects a file, got "${blank}"`);
    }
  });

  it('takes a name with a space in it, which is a name', () => {
    const options = parseArgs(['--baseline', 'accepted debt.json', '--record-baseline', ' b.json'], '/repo');
    expect(options.baseline).toBe('accepted debt.json');
    expect(options.recordBaseline).toBe(' b.json');
  });
});

describe('an --ignore that is blank', () => {
  it('is refused as an empty one is, on the command line and in the configuration', async () => {
    // It was a directory called " ", which nothing is, so it ignored nothing.
    const refused = { code: EXIT_ERROR, out: '', err: 'spec-graph: invalid glob "  ": the pattern is empty\n' };
    expect(await run('check', '--root', PROJECT, '--no-config', '--ignore', '  ')).toEqual(refused);
    await withRepo('refusals-blank-ignore', { '.spec-graph.json': '{ "ignore": ["  "] }\n', 'docs/a.md': '# A\n' }, async (root) => {
      expect(await run('check', '--root', root)).toEqual(refused);
    });
  });
});

describe('a second word given to rules', () => {
  it('is refused, with every word it was given', () => {
    expect(usage(['rules', 'ghost-handover', 'stale-premise'])).toBe('rules takes one rule id, got 2: ghost-handover, stale-premise');
    expect(usage(['rules', 'a', '--explain', 'b', 'c'])).toBe('rules takes one rule id, got 3: a, b, c');
  });

  it('is a pattern to every other command, and one rule id is taken', () => {
    expect(parseArgs(['rules', 'ghost-handover'], '/repo').patterns).toEqual(['ghost-handover']);
    expect(parseArgs(['check', 'a.md', 'b.md'], '/repo').patterns).toEqual(['a.md', 'b.md']);
    expect(parseArgs(['graph', 'a.md', 'b.md'], '/repo').patterns).toEqual(['a.md', 'b.md']);
  });

  it('does not stand between a person and the help or the version', async () => {
    expect(await run('rules', 'a', 'b', '--help')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect((await run('rules', 'a', 'b', '--version')).code).toBe(EXIT_OK);
  });
});

describe('--format json asked of a command that writes none', () => {
  it('is refused by graph and by rules, each told what it writes', () => {
    expect(usage(['graph', '--format', 'json'])).toBe(
      '--format json belongs to check, query or diff, not to graph: graph writes JSON with --graph-format json',
    );
    expect(usage(['rules', '--format', 'json'])).toBe('--format json belongs to check, query or diff, not to rules: rules lists the rules as text');
  });

  it('is taken by the three commands that write it, as the default is', () => {
    for (const argv of [['check'], ['query', 'document'], ['diff', 'a.json', 'b.json']]) {
      expect(parseArgs([...argv, '--format', 'json'], '/repo').format, argv[0]).toBe('json');
      expect(parseArgs([...argv, '--format', 'human'], '/repo').format, argv[0]).toBe('human');
    }
  });

  it('does not stand between a person and the help or the version', async () => {
    expect(await run('graph', '--format', 'json', '--help')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect((await run('rules', '--format', 'json', '--version')).code).toBe(EXIT_OK);
  });
});

describe('a configuration file that is there and cannot be read', () => {
  // A directory where the file is named: every host refuses to read one.
  const UNREADABLE = { '.spec-graph.json/keep': '', 'docs/adr/0001-a.md': '# ADR-0001: A\n' };
  const STOPPED =
    /^spec-graph: \.spec-graph\.json cannot be read: EISDIR[^\n]*\nspec-graph: 1 problem in the configuration, so nothing was checked\n {2}fix it, or run again with --no-config to check on defaults\n$/;

  it('stops the run, where it used to check on defaults and say nothing', async () => {
    await withRepo('refusals-config-directory', UNREADABLE, async (root) => {
      for (const command of [['check'], ['rules']]) {
        const result = await run(...command, '--root', root);
        expect(result.code, command[0]).toBe(EXIT_ERROR);
        expect(result.err, command[0]).toMatch(STOPPED);
        expect(result.out, command[0]).toBe('');
      }
    });
  });

  it('stops a run started below it, which used to read the configuration of a directory above', async () => {
    await withRepo('refusals-config-above', { '.spec-graph.json': '{}\n', ...Object.fromEntries(Object.entries(UNREADABLE).map(([path, text]) => [`pkg/${path}`, text])) }, async (root) => {
      const result = await runIn(`${process.cwd()}/${root}/pkg/docs`, 'check');
      expect(result.code).toBe(EXIT_ERROR);
      expect(result.err).toMatch(STOPPED);
    });
  });

  it('is passed over under --no-config, which reads no configuration', async () => {
    await withRepo('refusals-config-skipped', UNREADABLE, async (root) => {
      expect(await run('check', '--root', root, '--no-config', '--format', 'json')).toMatchObject({ code: EXIT_OK, err: '' });
    });
  });
});
