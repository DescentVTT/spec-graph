import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parseArgs, UsageError } from '../src/cli.js';

/*
 * What is given and would not be read: a list of families no document here
 * belongs to, or one that mistypes a family the documents do belong to, an
 * option of another command, a value that is the next option. Each ran as if
 * it had not been given, and each is refused by name now (ADR-0010, amended
 * again 2026-10-09 and on 2026-10-12). Beside every refusal stands the
 * nearest input that is still taken, with no new line: a tool that stops a
 * correct run is switched off (ADR-0006). Every test that writes to disk
 * writes under a directory named for its process (CLAUDE.md).
 */

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(...argv: string[]): Promise<Run> {
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
    env: { NO_COLOR: '1', SPEC_GRAPH_ASCII: '1' },
    isTTY: false,
  });
  return { code, out, err };
}

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

const accepted = (id: string, body: string): string => `---\nstatus: accepted\n---\n\n# ${id}: A decision\n\n${body}\n`;

/** Two ADRs, one citing an ADR nobody wrote: one error. */
const ADRS = {
  'docs/adr/0001-a.md': accepted('ADR-0001', 'See ADR-0099 for the rest.'),
  'docs/adr/0002-b.md': accepted('ADR-0002', 'Builds on [ADR-0001](0001-a.md).'),
};
/** The same beside two RFCs, one citing a standard the repository does not hold: two errors. */
const BOTH = {
  ...ADRS,
  'docs/rfcs/0001-x.md': accepted('RFC-0001', 'The key words are to be read as in RFC 2119.'),
  'docs/rfcs/0002-y.md': accepted('RFC-0002', 'Builds on [RFC-0001](0001-x.md).'),
};
/** A page of no family that links, in brackets, to an ADR and an RFC nobody wrote: two errors. */
const PAGE = { 'docs/guide.md': '# Guide\n\nSee [[ADR-0099]] and [[RFC-7]].\n' };

const ADVICE = '  name a family the documents belong to, or leave the list out\n';
const EACH = '  name each family as its documents do, or leave it off the list until its first document is written\n';

/** An ADR that cites an RFC that is there and one nobody wrote: one error, in the RFCs' family. */
const CITED = {
  'docs/adr/0001-a.md': accepted('ADR-0001', 'As decided in RFC-0001, and again in RFC-0099.'),
  'docs/rfcs/0001-x.md': accepted('RFC-0001', 'The transport.'),
};
/** Three families with documents, and an ADR that cites a KEP nobody wrote: one error, in the KEPs' family. */
const THREE = {
  'docs/adr/0001-a.md': accepted('ADR-0001', 'As decided in RFC-0001, and again in KEP-0099.'),
  'docs/rfcs/0001-x.md': accepted('RFC-0001', 'The transport.'),
  'docs/keps/0001-k.md': accepted('KEP-0001', 'The rollout.'),
};

/** A run's report with the one thing in it that differs between two runs of the same check taken out. */
const timeless = (out: string): string => out.replace(/[\d.]+ms/, '');

describe('a list of families, held against the documents', () => {
  it('stops the check that an allowlist of nothing used to pass, naming the list and the families there are', async () => {
    await withRepo('unread-allowlist', ADRS, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      // The finding the list would have passed over.
      expect((await run(...check)).code).toBe(EXIT_FAILED);
      const refused = {
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to a family named by --family (RFC); the documents here belong to ADR\n${ADVICE}`,
      };
      expect(await run(...check, '--family', 'RFC')).toEqual(refused);
      // Under --strict as without it, and in a format a script reads.
      expect(await run(...check, '--family', 'RFC', '--strict')).toEqual(refused);
      expect(await run(...check, '--family', 'rfc', '--format', 'json')).toEqual(refused);
      // A name one letter from the family the documents belong to.
      expect((await run(...check, '--family', 'ADRS')).err).toBe(
        `spec-graph: no document here belongs to a family named by --family (ADRS); the documents here belong to ADR\n${ADVICE}`,
      );
    });
  });

  it('records no baseline of a check it did not make', async () => {
    const { readdir } = await import('node:fs/promises');
    await withRepo('unread-allowlist-record', ADRS, async (root) => {
      const result = await run('check', '--root', root, '--no-config', '--family', 'RFC', '--record-baseline', 'debt.json');
      expect(result.code).toBe(EXIT_ERROR);
      expect(result.out).toBe('');
      expect(await readdir(root)).toEqual(['docs']);
    });
  });

  it('names the list where it was written: the configuration, or both', async () => {
    await withRepo('unread-allowlist-config', { ...ADRS, '.spec-graph.json': '{ "families": ["RFC"] }\n' }, async (root) => {
      expect(await run('check', '--root', root)).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to a family named by "families" in .spec-graph.json (RFC); the documents here belong to ADR\n${ADVICE}`,
      });
      // The two lists add up, and a name given twice is one name.
      expect((await run('check', '--root', root, '--family', 'KEP', '--family', ' rfc ')).err).toBe(
        `spec-graph: no document here belongs to a family named by --family and "families" in .spec-graph.json (RFC, KEP); the documents here belong to ADR\n${ADVICE}`,
      );
    });
  });

  it('names the option alone where the configuration lists none, and both in a note as in a refusal', async () => {
    await withRepo('unread-allowlist-empty', { ...ADRS, '.spec-graph.json': '{ "families": [] }\n' }, async (root) => {
      expect((await run('check', '--root', root, '--family', 'RFC')).err).toBe(
        `spec-graph: no document here belongs to a family named by --family (RFC); the documents here belong to ADR\n${ADVICE}`,
      );
    });
    await withRepo('unread-allowlist-note', { ...ADRS, '.spec-graph.json': '{ "families": ["ADR"] }\n' }, async (root) => {
      const result = await run('check', '--root', root, '--family', 'KEP');
      expect(result.code).toBe(EXIT_FAILED);
      expect(result.err).toBe(
        'spec-graph: no document here belongs to KEP, named by --family and "families" in .spec-graph.json; the documents here belong to ADR\n',
      );
    });
  });

  it('names every family the documents belong to, or says they belong to none', async () => {
    await withRepo('unread-allowlist-two', BOTH, async (root) => {
      expect((await run('check', '--root', root, '--no-config', '--family', 'KEP')).err).toBe(
        `spec-graph: no document here belongs to a family named by --family (KEP); the documents here belong to ADR and RFC\n${ADVICE}`,
      );
    });
    await withRepo('unread-allowlist-none', PAGE, async (root) => {
      // Both links are passed over under a list that names neither family, so
      // this run was clean too.
      expect(await run('check', '--root', root, '--no-config', '--family', 'KEP')).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to a family named by --family (KEP); the documents here belong to no family\n${ADVICE}`,
      });
    });
  });

  it('says nothing to a repository whose list names the families its documents belong to', async () => {
    await withRepo('unread-allowlist-right', BOTH, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      // The whole list, in any case and with the spaces a variable brings.
      const whole = await run(...check, '--family', ' adr ', '--family', 'RFC');
      expect(whole.code).toBe(EXIT_FAILED);
      expect(whole.err).toBe('');
      // Part of it: leaving a family the corpus has off the list is what a
      // list is for, and its citations going quiet is the documented result.
      const part = await run(...check, '--family', 'ADR');
      expect(part.code).toBe(EXIT_FAILED);
      expect(part.err).toBe('');
      expect(part.out).toContain('"ADR-0099"');
      expect(part.out).not.toContain('"RFC 2119"');
    });
  });

  it('says so and fails nothing where a name has no document and every family the documents belong to is listed', async () => {
    await withRepo('unread-allowlist-started', BOTH, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      const whole = [...check, '--family', 'ADR', '--family', 'RFC'];
      // A family the repository means to start.
      const started = await run(...whole, '--family', 'KEP');
      expect(started.err).toBe('spec-graph: no document here belongs to KEP, named by --family; the documents here belong to ADR and RFC\n');
      // The run is the one the list without that name makes, and the one no
      // list makes: the name passes over nothing either would have read.
      for (const without of [await run(...whole), await run(...check)]) {
        expect({ code: started.code, out: timeless(started.out) }).toEqual({ code: without.code, out: timeless(without.out) });
        expect(without.err).toBe('');
      }
      expect(started.code).toBe(EXIT_FAILED);
      // Two such names, and a report a script reads left whole on stdout.
      const json = await run(...whole, '--family', 'KEP', '--family', 'RCF', '--format', 'json');
      expect(json.err).toBe('spec-graph: no document here belongs to KEP or RCF, named by --family; the documents here belong to ADR and RFC\n');
      expect((JSON.parse(json.out) as { ok: boolean }).ok).toBe(false);
    });
  });

  it('fails nothing over a family listed before its first document', async () => {
    await withRepo('unread-allowlist-first', ADRS, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      const bare = await run(...check);
      expect(bare).toMatchObject({ code: EXIT_FAILED, err: '' });
      for (const strict of [[], ['--strict']]) {
        const first = await run(...check, '--family', 'ADR', '--family', 'RFC', ...strict);
        expect(first.err).toBe('spec-graph: no document here belongs to RFC, named by --family; the documents here belong to ADR\n');
        expect(first.code).toBe(EXIT_FAILED);
        expect(first.out).toContain('"ADR-0099"');
      }
      expect(timeless((await run(...check, '--family', 'ADR', '--family', 'RFC')).out)).toBe(timeless(bare.out));
    });
  });

  it('fails nothing where the documents of a listed family are ones this run does not read', async () => {
    await withRepo('unread-allowlist-part', { ...CITED, '.spec-graph.json': '{ "families": ["ADR", "RFC"] }\n' }, async (root) => {
      const note = 'spec-graph: no document here belongs to RFC, named by "families" in .spec-graph.json; the documents here belong to ADR\n';
      // The whole repository, with its list: the finding.
      expect(await run('check', '--root', root)).toMatchObject({ code: EXIT_FAILED, err: '' });
      // A run over part of it, with the list of all of it. The RFCs are out
      // of reach with no list too, and what cites them is prose either way
      // (ADR-0006): the two runs report the same.
      const part = await run('check', '--root', root, 'docs/adr/**/*.md');
      const bare = await run('check', '--root', root, '--no-config', 'docs/adr/**/*.md');
      expect(part).toMatchObject({ code: EXIT_OK, err: note });
      expect(bare).toMatchObject({ code: EXIT_OK, err: '' });
      expect(timeless(part.out)).toBe(timeless(bare.out));
      // The documents of the listed family ignored, and no other family there.
      for (const strict of [[], ['--strict']]) {
        expect(await run('check', '--root', root, '--ignore', 'docs/rfcs/**', ...strict)).toMatchObject({ code: EXIT_OK, err: note });
      }
    });
  });

  it('stops the check where a name has no document and the list leaves out a family the documents belong to', async () => {
    const { readdir } = await import('node:fs/promises');
    await withRepo('unread-allowlist-half', CITED, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      // The finding, with no list and with the right one: an RFC nobody
      // wrote, cited from an ADR.
      for (const list of [[], ['--family', 'ADR', '--family', 'RFC']]) {
        const found = await run(...check, ...list);
        expect(found.code, list.join(' ')).toBe(EXIT_FAILED);
        expect(found.out, list.join(' ')).toContain('"RFC-0099"');
        expect(found.err, list.join(' ')).toBe('');
      }
      // `RFCS` for `RFC` leaves the RFCs' own family off the list, so the
      // citation was prose: `the specification graph is consistent`, exit 0,
      // under --strict too, and one line on stderr.
      const refused = {
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to RFCS, named by --family; the documents here belong to ADR and RFC, and the list leaves out RFC\n${EACH}`,
      };
      const mistyped = [...check, '--family', 'ADR', '--family', 'RFCS'];
      expect(await run(...mistyped)).toEqual(refused);
      expect(await run(...mistyped, '--strict')).toEqual(refused);
      expect(await run(...check, '--family', 'adr', '--family', ' rfcs ', '--format', 'json')).toEqual(refused);
      // No baseline is recorded of the check that was not made.
      expect(await run(...mistyped, '--record-baseline', 'debt.json')).toEqual(refused);
      expect(await readdir(root)).toEqual(['docs']);
      // Every name with no document is named.
      expect((await run(...mistyped, '--family', 'KEP')).err).toBe(
        `spec-graph: no document here belongs to RFCS or KEP, named by --family; the documents here belong to ADR and RFC, and the list leaves out RFC\n${EACH}`,
      );
    });
    // And the list is named where it was written.
    await withRepo('unread-allowlist-half-config', { ...CITED, '.spec-graph.json': '{ "families": ["ADR", "RFCS"] }\n' }, async (root) => {
      expect(await run('check', '--root', root)).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to RFCS, named by "families" in .spec-graph.json; the documents here belong to ADR and RFC, and the list leaves out RFC\n${EACH}`,
      });
    });
  });

  it('takes a family on --ignore-family as taken out on purpose, not as left out', async () => {
    const note = 'spec-graph: no document here belongs to RFCS, named by --family; the documents here belong to ADR and RFC\n';
    await withRepo('unread-allowlist-ignored', CITED, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      const mistyped = [...check, '--family', 'ADR', '--family', 'RFCS'];
      // What the list would pass over, the other option passes over without
      // it: the two runs report the same, so the list costs nothing.
      const bare = await run(...check, '--ignore-family', 'RFC');
      expect(bare).toMatchObject({ code: EXIT_OK, err: '' });
      const both = await run(...mistyped, '--ignore-family', ' rfc ');
      expect(both).toMatchObject({ code: EXIT_OK, err: note });
      expect(timeless(both.out)).toBe(timeless(bare.out));
      // Another family taken out is not this one.
      expect(await run(...mistyped, '--ignore-family', 'KEP')).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to RFCS, named by --family; the documents here belong to ADR and RFC, and the list leaves out RFC\n${EACH}`,
      });
    });
    await withRepo('unread-allowlist-ignored-config', { ...CITED, '.spec-graph.json': '{ "ignoreFamilies": ["RFC"] }\n' }, async (root) => {
      expect(await run('check', '--root', root, '--family', 'ADR', '--family', 'RFCS')).toMatchObject({ code: EXIT_OK, err: note });
    });
  });

  it('cannot tell a family not yet started from a mistyped one where the list is narrower on purpose, and takes --ignore-family as saying which', async () => {
    await withRepo('unread-allowlist-narrow', THREE, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      const narrow = [...check, '--family', 'ADR', '--family', 'RFC'];
      // The finding the narrower list passes over, on purpose: every name on
      // it has a document, and there is nothing to say.
      expect((await run(...check)).out).toContain('"KEP-0099"');
      expect(await run(...narrow)).toMatchObject({ code: EXIT_OK, err: '' });
      // One more name, with no document. It reads as a name meant for the
      // family left out, and both are named.
      expect(await run(...narrow, '--family', 'PRD')).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: `spec-graph: no document here belongs to PRD, named by --family; the documents here belong to ADR, KEP and RFC, and the list leaves out KEP\n${EACH}`,
      });
      // Said to be out on purpose, the family is not one left out.
      expect(await run(...narrow, '--family', 'PRD', '--ignore-family', 'KEP')).toMatchObject({
        code: EXIT_OK,
        err: 'spec-graph: no document here belongs to PRD, named by --family; the documents here belong to ADR, KEP and RFC\n',
      });
      // Two families left out are both named.
      expect((await run(...check, '--family', 'ADR', '--family', 'PRD')).err).toBe(
        `spec-graph: no document here belongs to PRD, named by --family; the documents here belong to ADR, KEP and RFC, and the list leaves out KEP and RFC\n${EACH}`,
      );
    });
  });

  it('is a check\'s to refuse: the other commands read no list', async () => {
    await withRepo('unread-allowlist-others', { ...ADRS, '.spec-graph.json': '{ "families": ["RFC"] }\n' }, async (root) => {
      for (const command of [['graph'], ['query', 'document'], ['rules']]) {
        expect(await run(...command, '--root', root), command[0]).toMatchObject({ code: EXIT_OK, err: '' });
      }
    });
  });

  it('asks nothing of --ignore-family, where a name no document belongs to passes over nothing', async () => {
    await withRepo('unread-ignore-family', ADRS, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      // A mistyped name reports more, not less: the finding is still there.
      for (const name of ['RFC', 'RCF']) {
        const result = await run(...check, '--ignore-family', name);
        expect(result.code, name).toBe(EXIT_FAILED);
        expect(result.err, name).toBe('');
      }
      // And the family the documents belong to is passed over when it is the
      // one named, which is what was asked.
      expect(await run(...check, '--ignore-family', 'ADR')).toMatchObject({ code: EXIT_OK, err: '' });
    });
  });
});

describe('an option given to a command that does not read it', () => {
  const COMMANDS: Record<string, string[]> = {
    check: ['check'],
    query: ['query', 'document'],
    graph: ['graph'],
    rules: ['rules'],
    diff: ['diff', 'a.json', 'b.json'],
  };
  /** A value each option can read, for the ones that take one. */
  const VALUES: Record<string, string[]> = {
    '--root': ['docs'],
    '--ignore': ['drafts'],
    '--history': ['JOURNAL.md'],
    '--ignore-ref': ['trap *'],
    '--family': ['ADR'],
    '--ignore-family': ['RFC'],
    '--baseline': ['debt.json'],
    '--record-baseline': ['debt.json'],
    '--rule': ['self-reference=off'],
    '--max': ['3'],
    '--max-warnings': ['0'],
    '--format': ['human'],
    '--graph-format': ['mermaid'],
  };

  /** The README's table: each option against the commands that read it. */
  function documented(): Map<string, string[]> {
    const readme = readFileSync('README.md', 'utf8');
    const start = readme.indexOf('| Option | Read by |');
    if (start === -1) throw new Error('the README has no table of options and the commands that read them');
    const table = new Map<string, string[]>();
    for (const row of readme.slice(start, readme.indexOf('\n\n', start)).split('\n').slice(2)) {
      const [options, readers] = row.split('|').slice(1, 3) as [string, string];
      const names = [...readers.matchAll(/`([a-z]+)`/g)].map((match) => match[1] as string);
      for (const option of options.matchAll(/`(--[a-z-]+)`/g)) table.set(option[1] as string, names.length > 0 ? names : Object.keys(COMMANDS));
    }
    return table;
  }

  it('is refused by that command with the commands that do read it, as the README\'s table has them', () => {
    const table = documented();
    // Every option --help lists is in the table, so none is left undecided.
    for (const option of HELP.matchAll(/^ {2}(?:-[hv], )?(--[a-z-]+)(?: \/ (--[a-z-]+))?/gm)) {
      for (const name of option.slice(1)) if (name !== undefined) expect([...table.keys()], name).toContain(name);
    }
    for (const [option, readers] of table) {
      for (const [command, argv] of Object.entries(COMMANDS)) {
        const line = [...argv, option, ...(VALUES[option] ?? [])];
        if (readers.includes(command)) {
          expect(() => parseArgs(line, '/repo'), line.join(' ')).not.toThrow();
        } else {
          const or = readers.length < 2 ? readers.join('') : `${readers.slice(0, -1).join(', ')} or ${readers[readers.length - 1] as string}`;
          expect(usage(line), line.join(' ')).toBe(`${option} belongs to ${or}, not to ${command}`);
        }
      }
    }
  });

  it('refuses the option where the command was forgotten, and writes nothing a file could take for a graph', async () => {
    // `spec-graph --graph-format mermaid > graph.mmd` wrote the check's report
    // into the file, and exited by its findings.
    expect(await run('--graph-format', 'mermaid', '--root', 'tests/fixtures/demo')).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-graph: --graph-format belongs to graph, not to check\n',
    });
  });

  it('refuses each one given, the first by name', () => {
    expect(usage(['graph', '--strict', '--max', '1'])).toBe('--strict belongs to check, not to graph');
    expect(usage(['query', 'document', '--format', 'json', '--explain'])).toBe('--explain belongs to rules, not to query');
  });

  it('keeps the line a format already had, and gives --format human the table\'s', () => {
    expect(usage(['graph', '--format', 'sarif'])).toBe('--format sarif reports findings, so it belongs to check, not to graph');
    expect(usage(['rules', '--format', 'human'])).toBe('--format belongs to check, query or diff, not to rules');
  });

  it('takes --verbose for --explain on rules, and each on the commands that read it', () => {
    expect(parseArgs(['rules', '--verbose'], '/repo').verbose).toBe(true);
    expect(parseArgs(['rules', '--explain'], '/repo').verbose).toBe(true);
    expect(parseArgs(['graph', '--verbose'], '/repo').verbose).toBe(true);
  });

  it('does not stand between a person and the help or the version', async () => {
    expect(await run('graph', '--strict', '--help')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect((await run('diff', '--root', 'docs', '--version')).code).toBe(EXIT_OK);
  });
});

describe('a value that reads as an option', () => {
  const VALUED = ['--root', '--ignore', '--ignore-ref', '--family', '--ignore-family', '--history', '--baseline', '--record-baseline', '--format', '--rule', '--max', '--max-warnings'];

  it('is refused by every option that takes a value, in the same words', () => {
    for (const flag of VALUED) {
      expect(usage(['check', flag, '--strict'])).toBe(`${flag} needs a value, and --strict reads as an option`);
    }
    expect(usage(['graph', '--graph-format', '--documents-only'])).toBe('--graph-format needs a value, and --documents-only reads as an option');
    // The short options, the end of the options, and a word that is no option
    // of this tool and begins as one does.
    for (const value of ['-h', '-v', '--', '--strcit']) {
      expect(usage(['check', '--ignore', value])).toBe(`--ignore needs a value, and ${value} reads as an option`);
    }
  });

  it('writes no file named for an option', async () => {
    const { readdir } = await import('node:fs/promises');
    await withRepo('unread-value', ADRS, async (root) => {
      const result = await run('check', '--root', root, '--no-config', '--record-baseline', '--verbose');
      expect(result).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-graph: --record-baseline needs a value, and --verbose reads as an option\n' });
      expect(await readdir(root)).toEqual(['docs']);
    });
  });

  it('leaves a value with one dash to the option, which has its own line for it or takes it as a name', () => {
    expect(usage(['check', '--max', '-1'])).toBe('--max expects a non-negative whole number, got "-1"');
    expect(parseArgs(['check', '--ignore', '-drafts'], '/repo').ignore).toEqual(['-drafts']);
    expect(parseArgs(['check', '--', '--strict'], '/repo')).toMatchObject({ patterns: ['--strict'], strict: false });
  });

  it('takes a name that does begin with two dashes in the spelling each kind of value has', async () => {
    const files = {
      'docs/guide.md': '# Guide\n\nSee [[--verbose]] for the flag.\n',
      'docs/--drafts/d.md': '# Draft\n\nSee [[nothing here]].\n',
    };
    await withRepo('unread-dashes', files, async (root) => {
      const check = ['check', '--root', root, '--no-config'];
      expect((await run(...check)).out).toContain('2 errors');
      // A reference target, escaped; a directory, in a pattern; a file, by its path.
      expect(await run(...check, '--ignore-ref', '\\--verbose', '--ignore', '**/[-]-drafts')).toMatchObject({ code: EXIT_OK, err: '' });
      const recorded = await run(...check, '--record-baseline', './--debt.json');
      expect(recorded.code).toBe(EXIT_OK);
      expect(recorded.out).toBe('recorded 2 findings as 2 entries in ./--debt.json\n');
    });
  });
});

describe('an empty name given to diff', () => {
  it('is refused by which side it was', () => {
    expect(usage(['diff', '', 'b.json'])).toBe('diff expects a graph export on each side, got "" for the first');
    expect(usage(['diff', 'a.json', '  '])).toBe('diff expects a graph export on each side, got "  " for the second');
  });

  it('is diff\'s to refuse, and a name with a space in it is a name', () => {
    expect(parseArgs(['diff', 'my base.json', 'head.json'], '/repo').patterns).toEqual(['my base.json', 'head.json']);
    // An empty pattern is refused as a pattern, by the commands that read one.
    expect(parseArgs(['check', ''], '/repo').patterns).toEqual(['']);
    expect(usage(['diff', '', 'b.json', 'c.json'])).toContain('diff compares two graph exports');
  });

  it('does not stand between a person and the help or the version', async () => {
    expect(await run('diff', '', 'b.json', '--help')).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect((await run('diff', '', 'b.json', '--version')).code).toBe(EXIT_OK);
  });
});
