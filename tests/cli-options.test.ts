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

  it('reads --color, --no-color, --ascii and --no-ascii, and leaves each to the environment when it is absent', () => {
    expect(parseArgs([], '/repo')).toMatchObject({ color: null, ascii: null });
    expect(parseArgs(['--color'], '/repo').color).toBe(true);
    expect(parseArgs(['--no-color'], '/repo').color).toBe(false);
    expect(parseArgs(['--ascii'], '/repo').ascii).toBe(true);
    expect(parseArgs(['--no-ascii'], '/repo')).toMatchObject({ ascii: false, documentsOnly: false });
  });

  // Every option that has an opposite on the command line: the other
  // twenty-one have none to be given beside.
  const pairs = [
    { on: '--color', off: '--no-color', key: 'color', refusal: '--color is given beside --no-color, and a report is coloured or it is not: give one of the two' },
    { on: '--ascii', off: '--no-ascii', key: 'ascii', refusal: '--ascii is given beside --no-ascii, and the glyphs are drawn one way: give one of the two' },
  ] as const;

  it.each(pairs)('refuses $on beside $off, whichever comes first, and takes either alone', ({ on, off, key, refusal }) => {
    // The later decided and the earlier went unread, with no word of it.
    expect(usage([on, off]).message).toBe(refusal);
    expect(usage([off, on]).message).toBe(refusal);
    expect(usage(['check', off, '--verbose', on]).message).toBe(refusal);
    // In a format that draws neither colour nor glyph too: one of the two is still unread.
    for (const format of ['json', 'sarif', 'github', 'gitlab', 'markdown']) {
      expect(usage(['check', '--format', format, on, off]).message, format).toBe(refusal);
    }
    // Either alone is taken, and one of them twice is one of them.
    expect(parseArgs([on], '/repo')[key]).toBe(true);
    expect(parseArgs([off], '/repo')[key]).toBe(false);
    expect(parseArgs([on, on], '/repo')[key]).toBe(true);
    expect(parseArgs([off, off], '/repo')[key]).toBe(false);
    // After `--` the second is a pattern, not an option.
    expect(parseArgs([on, '--', off], '/repo')).toMatchObject({ [key]: true, patterns: [off] });
    // With the help or the version asked for beside them too, as an option
    // of another command is.
    expect(usage([on, off, '--help']).message).toBe(refusal);
    expect(usage([off, on, '-h']).message).toBe(refusal);
    expect(usage(['--version', on, off]).message).toBe(refusal);
    expect(usage([off, '-v', on]).message).toBe(refusal);
    expect(parseArgs([on, '--help'], '/repo').help).toBe(true);
  });

  it('holds every option the help lists to that: one with an opposite is refused beside it, and the rest have none', () => {
    // Read off the help, so an opposite added later is held to the refusal
    // without being listed here: `--no-strict` taken, and `--strict` beside
    // it not refused, fails this.
    const start = HELP.indexOf('\nOPTIONS\n');
    // The list ends at the first empty line; the paragraphs after it name options in prose.
    const block = HELP.slice(start, HELP.indexOf('\n\n', start));
    const listed = [...block.matchAll(/^ {2}(?:-[a-z], )?(--[a-z-]+)(?: \/ (--[a-z-]+))?/gm)].flatMap((line) => line.slice(1).filter((name) => name !== undefined));
    expect(listed).toHaveLength(25);
    const unknown = (option: string): boolean => {
      try {
        parseArgs([option], '/repo');
      } catch (error) {
        return (error as Error).message.startsWith(`unknown option "${option}"`);
      }
      return false;
    };
    const found: string[][] = [];
    for (const option of listed) {
      expect(unknown(option), option).toBe(false);
      const opposite = option.startsWith('--no-') ? `--${option.slice(5)}` : `--no-${option.slice(2)}`;
      if (unknown(opposite)) continue;
      const on = option.startsWith('--no-') ? opposite : option;
      const off = option.startsWith('--no-') ? option : opposite;
      expect(usage([option, opposite]).message, option).toContain(`${on} is given beside ${off}, and `);
      expect(usage([opposite, option]).message, option).toContain(`${on} is given beside ${off}, and `);
      if (option === on) found.push([on, off]);
    }
    expect(found).toEqual(pairs.map(({ on, off }) => [on, off]));
  });

  it('holds every option the help gives a value to one value, unless the help calls it repeatable', () => {
    // Read off the help as above, so an option added later is held to the
    // rule by what its own entry says: given two values it is refused with
    // both, or its entry says "Repeatable" and it takes each.
    const start = HELP.indexOf('\nOPTIONS\n');
    const block = HELP.slice(start, HELP.indexOf('\n\n', start));
    const entries = [...block.matchAll(/^ {2}(?:-[a-z], )?(--[a-z-]+)(?: \/ --[a-z-]+)?( <[^>]+>)?/gm)];
    const taking = entries
      .map((entry, at) => ({ option: entry[1]!, valued: entry[2] !== undefined, text: block.slice(entry.index, entries[at + 1]?.index) }))
      .filter((entry) => entry.valued);
    // Two values each option takes, and the command that reads it.
    const values: Record<string, [string, string, string?]> = {
      '--root': ['a', 'b'],
      '--ignore': ['a', 'b'],
      '--ignore-ref': ['a', 'b'],
      '--family': ['ADR', 'RFC'],
      '--ignore-family': ['ADR', 'RFC'],
      '--history': ['a', 'b'],
      '--baseline': ['a.json', 'b.json'],
      '--record-baseline': ['a.json', 'b.json'],
      '--format': ['json', 'human'],
      '--graph-format': ['dot', 'json', 'graph'],
      '--rule': ['broken-reference=off', 'self-reference=off'],
      '--max': ['1', '2'],
      '--max-warnings': ['1', '2'],
    };
    expect(taking.map((entry) => entry.option)).toEqual(Object.keys(values));
    const once: string[] = [];
    for (const { option, text } of taking) {
      const [first, second, command = 'check'] = values[option]!;
      const twice = [command, option, first, option, second];
      // The same value again is the option once, for every one of them.
      expect(() => parseArgs([command, option, first, option, first], '/repo'), option).not.toThrow();
      if (text.includes('Repeatable')) {
        expect(() => parseArgs(twice, '/repo'), option).not.toThrow();
        continue;
      }
      once.push(option);
      expect(usage(twice).message, option).toBe(`${option} is given "${first}" and "${second}", and takes one value: give one of the two`);
      expect(usage([...twice, '--help']).message, option).toBe(usage(twice).message);
    }
    expect(once).toEqual(['--root', '--baseline', '--record-baseline', '--format', '--graph-format', '--max', '--max-warnings']);
  });

  it('takes an option beside the opposite of another, and names the pair whose first half comes first', () => {
    // Half of each pair is no pair: nothing here goes unread.
    expect(parseArgs(['--color', '--no-ascii'], '/repo')).toMatchObject({ color: true, ascii: false });
    expect(parseArgs(['--ascii', '--no-color'], '/repo')).toMatchObject({ color: false, ascii: true });
    expect(parseArgs(['--color', '--ascii'], '/repo')).toMatchObject({ color: true, ascii: true });
    expect(parseArgs(['--no-color', '--no-ascii'], '/repo')).toMatchObject({ color: false, ascii: false });
    // Both pairs on one line are refused one at a time.
    expect(usage(['--color', '--no-color', '--ascii', '--no-ascii']).message).toBe(pairs[0].refusal);
    expect(usage(['--no-ascii', '--no-color', '--ascii', '--color']).message).toBe(pairs[1].refusal);
  });

  it('takes --no-ascii for a check alone, as --color, and --ascii for every command', () => {
    const others: Record<string, string[]> = {
      query: ['query', 'document'],
      graph: ['graph'],
      rules: ['rules'],
      diff: ['diff', 'a.json', 'b.json'],
    };
    for (const [command, argv] of Object.entries(others)) {
      // It would say the Unicode glyphs were drawn, where the command draws none.
      expect(usage([...argv, '--no-ascii']).message, command).toBe(`--no-ascii belongs to check, not to ${command}`);
      expect(usage([...argv, '--color']).message, command).toBe(`--color belongs to check, not to ${command}`);
      // Beside --ascii too: the option of another command is named before the pair is.
      expect(usage([...argv, '--ascii', '--no-ascii']).message, command).toBe(`--no-ascii belongs to check, not to ${command}`);
      expect(usage([...argv, '--no-color', '--color']).message, command).toBe(`--color belongs to check, not to ${command}`);
      // --ascii asks for what is already so, and is taken.
      expect(parseArgs([...argv, '--ascii'], '/repo'), command).toMatchObject({ command, ascii: true });
      // With the help or the version asked for beside it too.
      expect(usage([...argv, '--no-ascii', '--help']).message, command).toBe(`--no-ascii belongs to check, not to ${command}`);
      expect(usage([...argv, '--no-ascii', '-v']).message, command).toBe(`--no-ascii belongs to check, not to ${command}`);
      expect(parseArgs([...argv, '--ascii', '--help'], '/repo').help, command).toBe(true);
    }
    // A check takes it, named or not, and in a format that draws no glyph:
    // that pairs an option with an option, as --no-color beside sarif does.
    expect(parseArgs(['check', '--no-ascii'], '/repo')).toMatchObject({ command: 'check', ascii: false });
    expect(parseArgs(['--no-ascii', 'docs'], '/repo')).toMatchObject({ command: 'check', ascii: false });
    for (const format of ['json', 'sarif', 'github', 'gitlab', 'markdown']) {
      expect(parseArgs(['check', '--format', format, '--no-ascii'], '/repo').ascii, format).toBe(false);
      expect(parseArgs(['check', '--format', format, '--ascii'], '/repo').ascii, format).toBe(true);
    }
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

/*
 * A line that is wrong is wrong with the help or the version asked for
 * beside it: answered first, the help told a script nothing of the line it
 * wrote, and the version answered it as if the line were right (spec-core's
 * ADR-0005, 2026-10-18; ADR-0010).
 */
describe('the help and the version, beside a line that is wrong', () => {
  // Each refusal the parser makes after it has read the line, and two it
  // makes as it reads it, which were refused beside the help already.
  const WRONG: readonly (readonly string[])[] = [
    ['check', '--bogus'],
    ['check', '--format', 'xml'],
    ['graph', '--strict'],
    ['query', 'document', '--format', 'sarif'],
    ['query', 'document', '--format', 'markdown'],
    ['graph', '--format', 'json'],
    ['check', '--color', '--no-color'],
    ['check', '--ascii', '--no-ascii'],
    ['check', '--root', 'a', '--root', 'b'],
    ['check', '--baseline', 'a.json', '--record-baseline', 'b.json'],
    ['check', '--family', 'ADR', '--ignore-family', 'ADR'],
    ['rules', 'a', 'b'],
    ['diff', 'a.json', 'b.json', 'c.json'],
    ['diff', '', 'b.json'],
    ['check', '--record-baseline', 'b.json', '--strict'],
    ['check', '--record-baseline', 'b.json', '--format', 'sarif'],
  ];
  const HELP_AND_VERSION = '--help is given beside --version, and a run prints the help or the version: give one of the two';

  it('is refused as it is without them, whichever is asked for and wherever it stands', () => {
    for (const line of WRONG) {
      const alone = usage([...line]).message;
      for (const asked of ['--help', '-h', '--version', '-v']) {
        expect(usage([...line, asked]).message, `${line.join(' ')} ${asked}`).toBe(alone);
        expect(usage([line[0]!, asked, ...line.slice(1)]).message, `${asked} ${line.join(' ')}`).toBe(alone);
      }
    }
  });

  it('is answered where what is missing is what the help is for, and where only the run reads what is wrong', async () => {
    for (const line of [['query'], ['diff'], ['diff', 'a.json'], ['check', '--root', 'nowhere'], ['rules', 'no-such-rule']]) {
      expect(await run(...line, '--help'), line.join(' ')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
      expect(await run(...line, '-v'), line.join(' ')).toEqual({ code: EXIT_OK, out: `${version()}\n`, err: '' });
    }
    // Neither asked for, each of them is refused.
    expect(usage(['query']).message).toContain('query needs a selector');
    expect(usage(['diff']).message).toContain('diff compares two graph exports');
    expect(usage(['diff', 'a.json']).message).toContain('diff compares two graph exports');
    expect(parseArgs(['diff', 'a.json', 'b.json'], '/repo').patterns).toEqual(['a.json', 'b.json']);
  });

  it('refuses the help beside the version, in either order and either spelling', async () => {
    for (const [a, b] of [['--help', '--version'], ['--version', '--help'], ['-h', '-v'], ['-v', '-h'], ['--help', '-v'], ['-v', '--help']] as const) {
      expect(usage([a, b]).message, `${a} ${b}`).toBe(HELP_AND_VERSION);
      expect(usage(['graph', a, '--documents-only', b]).message, `${a} ${b}`).toBe(HELP_AND_VERSION);
    }
    expect(await run('--version', '--help')).toEqual({ code: EXIT_ERROR, out: '', err: `spec-graph: ${HELP_AND_VERSION}\n` });
    // One of them twice is that one once.
    expect(await run('--help', '-h')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect(await run('-v', '--version')).toEqual({ code: EXIT_OK, out: `${version()}\n`, err: '' });
    // An option of another command is named first, and the two before a pair.
    expect(usage(['graph', '--strict', '--help', '--version']).message).toBe('--strict belongs to check, not to graph');
    expect(usage(['--color', '--no-color', '-v', '-h']).message).toBe(HELP_AND_VERSION);
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
    // Off as the convention spells it, on a terminal that would colour.
    expect(coloured((await runWith({ FORCE_COLOR: 'false' }, true, ...report)).out)).toBe(false);
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
    // An option wins over the variable, each way.
    expect(rich((await runWith({ ...modern, SPEC_GRAPH_ASCII: '0' }, false, ...report, '--ascii')).out)).toBe(false);
    expect(rich((await runWith({ ...modern, SPEC_GRAPH_ASCII: '1' }, false, ...report, '--no-ascii')).out)).toBe(true);
  });

  it('draws the rich glyphs when --no-ascii asks, where the environment names no terminal and where it asks for ASCII', async () => {
    const report = ['check', '--root', DEMO];
    const rich = (text: string): boolean => text.includes('✖');
    // No WT_SESSION and no TERM_PROGRAM: on Windows that is the console that
    // gets ASCII, and the option is how a person there asks for the rest.
    expect(rich((await runWith({}, false, ...report, '--no-ascii')).out)).toBe(true);
    expect(rich((await runWith({ SPEC_GRAPH_ASCII: '1' }, false, ...report, '--no-ascii')).out)).toBe(true);
    expect(rich((await runWith({ SPEC_GRAPH_ASCII: '1' }, false, ...report)).out)).toBe(false);
    // The report is the one the environment would have asked for, glyph for glyph.
    const asked = await runWith({ WT_SESSION: '1' }, false, ...report);
    const told = await runWith({ SPEC_GRAPH_ASCII: '1' }, false, ...report, '--no-ascii');
    expect(told.out.replace(/[\d.]+ms/, '')).toBe(asked.out.replace(/[\d.]+ms/, ''));
    expect(told.code).toBe(asked.code);
  });

  it('refuses --no-ascii to a command that draws no glyph, and writes nothing', async () => {
    expect(await run('query', 'document', '--root', DEMO, '--no-ascii')).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-graph: --no-ascii belongs to check, not to query\n',
    });
    // --ascii is taken there, and the answer is the one without it.
    const plain = await run('query', 'document', '--root', DEMO);
    expect(plain.code).toBe(EXIT_OK);
    expect(await run('query', 'document', '--root', DEMO, '--ascii')).toEqual(plain);
  });

  it('refuses a run given --ascii beside --no-ascii, and writes no report', async () => {
    expect(await run('check', '--root', DEMO, '--no-ascii', '--ascii')).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-graph: --ascii is given beside --no-ascii, and the glyphs are drawn one way: give one of the two\n',
    });
  });

  it('refuses a run given --color beside --no-color, in either order, and writes no report', async () => {
    const refused = {
      code: EXIT_ERROR,
      out: '',
      err: 'spec-graph: --color is given beside --no-color, and a report is coloured or it is not: give one of the two\n',
    };
    // On a terminal and into a pipe, whatever the environment asks for.
    expect(await runWith({}, true, 'check', '--root', DEMO, '--color', '--no-color')).toEqual(refused);
    expect(await runWith({ FORCE_COLOR: '1' }, false, 'check', '--root', DEMO, '--no-color', '--color')).toEqual(refused);
    expect(await runWith({ NO_COLOR: '1' }, false, 'check', '--root', DEMO, '--format', 'json', '--color', '--no-color')).toEqual(refused);
    // Beside the help as well, and a command that prints no colour names --color as a check's.
    expect(await run('check', '--color', '--no-color', '--help')).toEqual(refused);
    expect((await run('query', 'document', '--root', DEMO, '--color', '--no-color')).err).toBe('spec-graph: --color belongs to check, not to query\n');
    // --no-color twice, on a command that takes it, is --no-color.
    expect(await run('query', 'document', '--root', DEMO, '--no-color', '--no-color')).toEqual(await run('query', 'document', '--root', DEMO));
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
