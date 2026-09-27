import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError } from '../src/cli.js';
import { RULE_IDS } from '../src/rules.js';

/*
 * What each flag means, as `--help` states it, and what the command line takes
 * from its environment. The exit code is the contract with CI.
 */

const DEMO = 'tests/fixtures/demo';

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs the CLI in-process with an environment and a terminal of the test's choosing. */
async function runWith(env: Record<string, string>, isTTY: boolean, ...argv: string[]): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({
    argv,
    cwd: process.cwd(),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    isTTY,
  });
  return { code, out, err };
}

/** The fixed environment the rest of the suite uses: no colour, ASCII glyphs. */
const run = (...argv: string[]): Promise<Run> => runWith({ NO_COLOR: '1', SPEC_GRAPH_ASCII: '1' }, false, ...argv);

const usage = (argv: string[]): UsageError => {
  try {
    parseArgs(argv, '/repo');
  } catch (error) {
    return error as UsageError;
  }
  throw new Error(`${argv.join(' ')} parsed`);
};

const version = (): string =>
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('reading the command line', () => {
  it('reads the first word as the command only when it names one', () => {
    expect(parseArgs(['--verbose', 'query'], '/repo')).toMatchObject({ command: 'check', patterns: ['query'], verbose: true });
    expect(parseArgs(['checks'], '/repo')).toMatchObject({ command: 'check', patterns: ['checks'] });
    expect(parseArgs(['diff', 'a.json', 'b.json'], '/repo')).toMatchObject({ command: 'diff', patterns: ['a.json', 'b.json'] });
  });

  it('takes everything after -- as a pattern, and keeps the patterns before it', () => {
    expect(parseArgs(['a.md', '--', '-b.md', '--c.md'], '/repo').patterns).toEqual(['a.md', '-b.md', '--c.md']);
  });

  it('treats nothing as a journal until --history names one', () => {
    expect(parseArgs([], '/repo').historyPatterns).toEqual([]);
    expect(parseArgs(['--history', '**/JOURNAL_*.md', '--history', 'archive/**'], '/repo').historyPatterns).toEqual([
      '**/JOURNAL_*.md',
      'archive/**',
    ]);
  });

  it('reads --color, --no-color and --ascii, and leaves each to the environment when it is absent', () => {
    expect(parseArgs([], '/repo')).toMatchObject({ color: null, ascii: null });
    expect(parseArgs(['--color'], '/repo').color).toBe(true);
    expect(parseArgs(['--no-color'], '/repo').color).toBe(false);
    expect(parseArgs(['--ascii'], '/repo').ascii).toBe(true);
  });

  it('takes each graph format by name and refuses any other, naming the ones there are', () => {
    for (const format of ['dot', 'mermaid', 'json'] as const) {
      expect(parseArgs(['graph', '--graph-format', format], '/repo').graphFormat).toBe(format);
    }
    expect(() => parseArgs(['graph', '--graph-format', 'svg'], '/repo')).toThrow(
      '--graph-format must be dot, mermaid or json, got "svg"',
    );
  });

  it('asks for <id>=<severity> when --rule is given a bare rule', () => {
    expect(usage(['--rule', 'ghost-handover']).message).toBe('--rule expects <id>=<severity>, got "ghost-handover"');
  });

  it('lists every built-in rule, one by one, when --rule names none of them', () => {
    const { message } = usage(['--rule', 'ghost-handoverr=off']);
    const [first, list] = message.split('\n  known rules: ');
    expect(first).toBe('unknown rule "ghost-handoverr"');
    expect(list?.split(', ')).toEqual([...RULE_IDS]);
  });

  it('takes a count only as a non-negative whole number, allowing the spaces a shell variable brings', () => {
    for (const value of ['-1', '3x', '1.5', '', 'lots']) {
      expect(usage(['--max', value]).message).toBe(`--max expects a non-negative whole number, got "${value}"`);
    }
    expect(parseArgs(['--max', ' 3 '], '/repo').max).toBe(3);
    expect(parseArgs(['--max-warnings', '0'], '/repo').maxWarnings).toBe(0);
  });

  it('names its usage error, so a caller holding another copy of the module can still tell it apart', () => {
    const error = usage(['--nope']);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.name).toBe('UsageError');
  });
});

describe('what the flags do to a run', () => {
  const coloured = (text: string): boolean => text.includes('\u001b[');

  it('answers -h and -v as it answers --help and --version', async () => {
    expect(await run('-h')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect(await run('-v')).toEqual({ code: EXIT_OK, out: `${version()}\n`, err: '' });
  });

  it('colours the report when the environment says to, and --color or --no-color overrides it', async () => {
    const report = ['check', '--root', DEMO];
    expect(coloured((await runWith({}, false, ...report)).out)).toBe(false);
    expect(coloured((await runWith({}, true, ...report)).out)).toBe(true);
    expect(coloured((await runWith({ FORCE_COLOR: '1' }, false, ...report)).out)).toBe(true);
    // "Force colour on or off", whatever the environment says.
    expect(coloured((await runWith({ NO_COLOR: '1' }, true, ...report, '--color')).out)).toBe(true);
    expect(coloured((await runWith({ FORCE_COLOR: '1' }, true, ...report, '--no-color')).out)).toBe(false);
  });

  it('draws ASCII glyphs when the environment asks for them or --ascii does, whatever the platform', async () => {
    const report = ['check', '--root', DEMO];
    const rich = (text: string): boolean => text.includes('✖');
    // A terminal that announces itself as modern gets the rich glyphs on every
    // platform, Windows included.
    const modern = { WT_SESSION: '1', TERM_PROGRAM: 'vscode' };
    expect(rich((await runWith({ ...modern, SPEC_GRAPH_ASCII: '1' }, false, ...report)).out)).toBe(false);
    expect(rich((await runWith(modern, false, ...report)).out)).toBe(true);
    expect(rich((await runWith(modern, false, ...report, '--ascii')).out)).toBe(false);
  });

  it('fails on warnings only when there are more than --max-warnings allows', async () => {
    // Two warnings and nothing else.
    const warnings = ['check', 'docs/**/*.md', '--root', 'tests/fixtures/warnings'];
    expect((await run(...warnings, '--max-warnings', '2')).code).toBe(EXIT_OK);
    expect((await run(...warnings, '--max-warnings', '5')).code).toBe(EXIT_OK);
    expect((await run(...warnings, '--max-warnings', '1')).code).toBe(EXIT_FAILED);
  });

  it('reads its own arguments and writes to its own streams when called with nothing, as the binary calls it', async () => {
    const argv = process.argv;
    const written = { out: '', err: '' };
    const capture = (stream: 'out' | 'err') =>
      ((chunk: unknown) => {
        written[stream] += String(chunk);
        return true;
      }) as typeof process.stdout.write;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture('out'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture('err'));
    let listed: number;
    let refused: number;
    try {
      process.argv = [argv[0] as string, 'spec-graph', 'rules', '--no-config'];
      listed = await main();
      process.argv = [argv[0] as string, 'spec-graph', '--no-such-flag'];
      refused = await main();
    } finally {
      process.argv = argv;
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(listed).toBe(EXIT_OK);
    expect(written.out).toContain('ghost-handover');
    expect(refused).toBe(EXIT_ERROR);
    expect(written.err).toContain('spec-graph: unknown option "--no-such-flag"');
  });
});
