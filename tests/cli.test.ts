import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, main, parseArgs, UsageError } from '../src/cli.js';

const DEMO = 'tests/fixtures/demo';

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs the CLI in-process and captures both streams. */
async function run(...argv: string[]): Promise<Run> {
  return runIn(process.cwd(), ...argv);
}

/** The same, from somewhere else in the tree, for configuration discovery. */
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
    // A fixed environment keeps the output identical on every machine and in CI.
    env: { NO_COLOR: '1', SPEC_GRAPH_ASCII: '1' },
    isTTY: false,
  });
  return { code, out, err };
}

/* -------------------------------------------------------------------------- */

describe('argument parsing', () => {
  it('defaults to the check command', () => {
    expect(parseArgs([], '/repo').command).toBe('check');
    expect(parseArgs(['docs/**/*.md'], '/repo').patterns).toEqual(['docs/**/*.md']);
  });

  it('recognises each command', () => {
    for (const command of ['check', 'query', 'graph', 'rules'] as const) {
      const argv = command === 'query' ? [command, 'document'] : [command];
      expect(parseArgs(argv, '/repo').command).toBe(command);
    }
  });

  it('takes the first bare argument of a query as the selector', () => {
    const options = parseArgs(['query', 'document[phase=active]', 'docs/**/*.md'], '/repo');
    expect(options.selector).toBe('document[phase=active]');
    expect(options.patterns).toEqual(['docs/**/*.md']);
  });

  it('collects repeatable options', () => {
    const options = parseArgs(['--ignore', 'a/**', '--ignore', 'b/**'], '/repo');
    expect(options.ignore).toEqual(['a/**', 'b/**']);
  });

  it('parses rule severity overrides', () => {
    expect(parseArgs(['--rule', 'self-reference=off'], '/repo').severities).toEqual({ 'self-reference': 'off' });
  });

  it('treats everything after -- as a pattern', () => {
    expect(parseArgs(['--', '--weird-name.md'], '/repo').patterns).toEqual(['--weird-name.md']);
  });

  it('rejects an unknown option, and says how to get help', () => {
    expect(() => parseArgs(['--nope'], '/repo')).toThrow(UsageError);
    expect(() => parseArgs(['--nope'], '/repo')).toThrow(/--help/);
  });

  it('rejects an unknown rule and lists the real ones', () => {
    expect(() => parseArgs(['--rule', 'not-a-rule=off'], '/repo')).toThrow(/ghost-handover/);
  });

  it('rejects an unknown severity', () => {
    expect(() => parseArgs(['--rule', 'ghost-handover=loud'], '/repo')).toThrow(/error, warn, info, off/);
  });

  it('rejects a flag that is missing its value', () => {
    expect(() => parseArgs(['--root'], '/repo')).toThrow(/needs a value/);
  });

  it('rejects a non-numeric count', () => {
    expect(() => parseArgs(['--max', 'lots'], '/repo')).toThrow(/whole number/);
  });

  it('requires a selector for query', () => {
    expect(() => parseArgs(['query'], '/repo')).toThrow(/needs a selector/);
  });
});

describe('check', () => {
  it('finds every seeded defect in the demo repository', async () => {
    const result = await run('check', '--root', DEMO);
    expect(result.code).toBe(EXIT_FAILED);
    for (const rule of ['orphaned-obligation', 'ghost-handover', 'stale-premise', 'broken-reference']) {
      expect(result.out).toContain(rule);
    }
    expect(result.out).toContain('the specification graph is inconsistent');
  });

  it('prints a location an editor can open', async () => {
    const result = await run('check', '--root', DEMO);
    expect(result.out).toMatch(/docs\/adr\/0003-event-log\.md:\d+:\d+/);
  });

  it('emits machine-readable output with positions intact', async () => {
    const result = await run('check', '--root', DEMO, '--format', 'json');
    const report: {
      version: number;
      ok: boolean;
      diagnostics: { rule: string; line: number; column: number; related: unknown[] }[];
    } = JSON.parse(result.out);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of report.diagnostics) {
      expect(diagnostic.line).toBeGreaterThan(0);
      expect(diagnostic.column).toBeGreaterThan(0);
    }
  });

  it('honours a severity override', async () => {
    const noisy = await run('check', '--root', DEMO);
    const quiet = await run(
      'check',
      '--root',
      DEMO,
      '--rule',
      'orphaned-obligation=off',
      '--rule',
      'ghost-handover=off',
      '--rule',
      'stale-premise=off',
      '--rule',
      'broken-reference=off',
    );
    expect(noisy.code).toBe(EXIT_FAILED);
    expect(quiet.code).toBe(EXIT_OK);
    expect(quiet.out).toContain('the specification graph is consistent');
  });

  it('caps the number of findings shown but still fails', async () => {
    const result = await run('check', '--root', DEMO, '--max', '1');
    expect(result.out).toContain('... and');
    expect(result.code).toBe(EXIT_FAILED);
  });

  it('fails on warnings when asked to', async () => {
    const files = ['--root', DEMO, '--rule', 'orphaned-obligation=warn'];
    const lenient = await run('check', ...files, '--rule', 'ghost-handover=off', '--rule', 'stale-premise=off', '--rule', 'broken-reference=off');
    expect(lenient.code).toBe(EXIT_OK);
    const strict = await run(
      'check',
      ...files,
      '--rule',
      'ghost-handover=off',
      '--rule',
      'stale-premise=off',
      '--rule',
      'broken-reference=off',
      '--max-warnings',
      '0',
    );
    expect(strict.code).toBe(EXIT_FAILED);
  });

  it('produces byte-identical output across runs', async () => {
    const first = await run('check', '--root', DEMO, '--format', 'json');
    const second = await run('check', '--root', DEMO, '--format', 'json');
    // Timing is the only field allowed to differ.
    const strip = (text: string): string => text.replace(/"durationMs": [\d.]+/, '"durationMs": 0');
    expect(strip(first.out)).toBe(strip(second.out));
  });

  it('reports a usage error, not a pass, when nothing matches', async () => {
    const result = await run('check', '--root', DEMO, 'nothing/here/*.md');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('no specifications matched');
  });
});

describe('--ignore-ref', () => {
  const CONCEPTS = 'tests/fixtures/concepts';

  it('is collected, repeatably', () => {
    const options = parseArgs(['--ignore-ref', 'trap *', '--ignore-ref', 'Q-*'], '/repo');
    expect(options.ignoreReferences).toEqual(['trap *', 'Q-*']);
    expect(parseArgs([], '/repo').ignoreReferences).toEqual([]);
  });

  it('needs a value', () => {
    expect(() => parseArgs(['--ignore-ref'], '/repo')).toThrow(/needs a value/);
  });

  it('reports concept tags by default, and names the flag that stops it', async () => {
    const result = await run('check', '--root', CONCEPTS);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.out).toContain('does not resolve to any document');
    expect(result.out).toContain('--ignore-ref "trap *"');
  });

  it('goes quiet once the convention is declared', async () => {
    const result = await run('check', '--root', CONCEPTS, '--ignore-ref', 'trap *');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('the specification graph is consistent');
  });

  it('leaves the graph itself untouched', async () => {
    // The filter suppresses findings, never edges. Exporting the graph with a
    // pattern that matches everything must still show every relation.
    const plain = await run('graph', '--root', CONCEPTS, '--graph-format', 'json');
    const filtered = await run('graph', '--root', CONCEPTS, '--graph-format', 'json', '--ignore-ref', '*');
    expect(filtered.out).toBe(plain.out);
  });
});

describe('family rules', () => {
  const RFCS = ['docs/**/*.md', '--root', 'tests/fixtures/rfcs'];

  it('are collected, repeatably', () => {
    const options = parseArgs(['--family', 'ADR', '--family', 'KEP', '--ignore-family', 'RFC'], '/repo');
    expect(options.families).toEqual(['ADR', 'KEP']);
    expect(options.ignoreFamilies).toEqual(['RFC']);
  });

  it('need a value', () => {
    expect(() => parseArgs(['--family'], '/repo')).toThrow(/needs a value/);
    expect(() => parseArgs(['--ignore-family'], '/repo')).toThrow(/needs a value/);
  });

  it('report a cited standard the repository does not hold', async () => {
    const result = await run('check', ...RFCS);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.out).toContain('"RFC 2119"');
  });

  it('go quiet once the family is declared not ours', async () => {
    const result = await run('check', ...RFCS, '--ignore-family', 'RFC');
    expect(result.code).toBe(EXIT_OK);
  });

  it('go quiet under an allowlist that excludes it', async () => {
    const result = await run('check', ...RFCS, '--family', 'ADR');
    expect(result.code).toBe(EXIT_OK);
  });

  it('never cost a relation that resolved', async () => {
    const result = await run('graph', ...RFCS, '--graph-format', 'json', '--ignore-family', 'RFC');
    const parsed: { edges: { from: string; to: string }[] } = JSON.parse(result.out);
    expect(parsed.edges.some((e) => e.from === 'RFC-0002' && e.to === 'RFC-0001')).toBe(true);
  });
});

describe('repository configuration', () => {
  const CONFIGURED = ['--root', 'tests/fixtures/configured'];

  it('is read without any flags', async () => {
    const result = await run('check', ...CONFIGURED);
    expect(result.code).toBe(EXIT_OK);
  });

  it('names its source under --verbose', async () => {
    const result = await run('check', ...CONFIGURED, '--verbose');
    expect(result.out).toContain('configuration: .spec-graph.json');
  });

  it('is skipped entirely with --no-config', async () => {
    const result = await run('check', 'docs/**/*.md', ...CONFIGURED, '--no-config');
    expect(result.code).toBe(EXIT_FAILED);
    expect(parseArgs(['--no-config'], '/repo').noConfig).toBe(true);
  });

  it('adds to its list options rather than being replaced by a flag', async () => {
    // A --ignore-ref on the command line is one more exclusion, not a decision
    // to discard the ones the repository already declared.
    const result = await run('check', ...CONFIGURED, '--ignore-ref', 'never-matches-*');
    expect(result.code).toBe(EXIT_OK);
  });
});

describe('strict mode', () => {
  // A fixture whose only findings are warnings: a retired decision that never
  // says what replaced it, and a link to a real document outside the patterns.
  // Those are exactly the findings a team past its first run stops tolerating.
  const WARN = ['docs/**/*.md', '--root', 'tests/fixtures/warnings'];

  it('passes without it and fails with it', async () => {
    const lenient = await run('check', ...WARN);
    expect(lenient.code).toBe(EXIT_OK);
    expect(lenient.out).toContain('2 warnings');
    expect(lenient.out).toContain('no errors - the specification graph holds');

    const strict = await run('check', ...WARN, '--strict');
    expect(strict.code).toBe(EXIT_FAILED);
    expect(strict.out).toContain('2 errors');
    expect(strict.out).toContain('the specification graph is inconsistent');
  });

  it('says which findings it raised, and how many', async () => {
    // A finding that is only an error because of a flag has to say so, or the
    // reader cannot tell what the build would do without it.
    const strict = await run('check', ...WARN, '--strict');
    expect(strict.out).toContain('unreciprocated-supersession (strict: warn -> error)');
    expect(strict.out).toContain('reference-outside-corpus (strict: warn -> error)');
    expect(strict.out).toContain('2 raised by --strict');
  });

  it('says nothing about strict when the flag is absent', async () => {
    const lenient = await run('check', ...WARN);
    expect(lenient.out).not.toContain('strict');
  });

  it('reports the same findings, only louder', async () => {
    // Strict changes severity and nothing else. The same rules fire at the same
    // places with the same hints; a flag that also changed what was detected
    // would make the non-strict run untrustworthy.
    const parse = (text: string): { rule: string; line: number; message: string }[] =>
      JSON.parse(text).diagnostics.map((d: { rule: string; line: number; message: string }) => ({
        rule: d.rule,
        line: d.line,
        message: d.message,
      }));
    const lenient = await run('check', ...WARN, '--format', 'json');
    const strict = await run('check', ...WARN, '--strict', '--format', 'json');
    expect(parse(strict.out)).toEqual(parse(lenient.out));
  });

  it('lets an explicit rule override exempt one rule from strict', async () => {
    // Strict is only usable if a team can turn it on and keep the one rule
    // their repository disagrees with, rather than choosing all or nothing.
    const exempted = await run(
      'check',
      ...WARN,
      '--strict',
      '--rule',
      'unreciprocated-supersession=warn',
      '--format',
      'json',
    );
    const report: { diagnostics: { rule: string; severity: string; escalated: boolean }[] } = JSON.parse(exempted.out);
    const kept = report.diagnostics.find((d) => d.rule === 'unreciprocated-supersession');
    expect(kept?.severity).toBe('warn');
    expect(kept?.escalated).toBe(false);
    const raised = report.diagnostics.find((d) => d.rule === 'reference-outside-corpus');
    expect(raised?.severity).toBe('error');
    expect(raised?.escalated).toBe(true);
  });

  it('marks the escalation in the machine-readable report too', async () => {
    const strict = await run('check', ...WARN, '--strict', '--format', 'json');
    const report: { strict: boolean; ok: boolean; diagnostics: { escalated: boolean }[] } = JSON.parse(strict.out);
    expect(report.strict).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.every((d) => d.escalated)).toBe(true);

    const lenient = await run('check', ...WARN, '--format', 'json');
    const plain: { strict: boolean; ok: boolean; diagnostics: { escalated: boolean }[] } = JSON.parse(lenient.out);
    expect(plain.strict).toBe(false);
    expect(plain.ok).toBe(true);
    expect(plain.diagnostics.every((d) => !d.escalated)).toBe(true);
  });

  it('changes nothing on a corpus with no warnings to raise', async () => {
    const clean = ['docs/**/*.md', '--root', DEMO, '--rule', 'unreciprocated-supersession=off'];
    const strip = (text: string): string =>
      text.replace(/"durationMs": [\d.]+/, '"durationMs": 0').replace(/"strict": (true|false)/, '"strict": x');
    const plain = await run('check', ...clean, '--format', 'json');
    const strict = await run('check', ...clean, '--strict', '--format', 'json');
    expect(plain.code).toBe(strict.code);
    expect(strip(strict.out)).toBe(strip(plain.out));
  });

  it('is parsed as a flag', () => {
    expect(parseArgs(['check', '--strict'], '/repo').strict).toBe(true);
    expect(parseArgs(['check'], '/repo').strict).toBe(false);
  });
});

describe('query', () => {
  it('answers the ghost-handover question', async () => {
    const result = await run('query', 'item[openness=open] -delegates-to-> document[phase=retired]', '--root', DEMO);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('ADR-0003#open-questions.1 -delegates-to-> ADR-0002');
    expect(result.out).toContain('1 match');
  });

  it('exits non-zero when a query finds nothing, so it can gate a build', async () => {
    const result = await run('query', 'document[phase=frozen]', '--root', DEMO);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.out).toContain('no matches');
  });

  it('emits JSON matches', async () => {
    const result = await run('query', 'document[phase=retired]', '--root', DEMO, '--format', 'json');
    const parsed: { count: number; matches: { nodes: { id: string; phase: string }[] }[] } = JSON.parse(result.out);
    expect(parsed.count).toBe(2);
    expect(parsed.matches[0]?.nodes[0]?.phase).toBe('retired');
  });

  it('points at the character of a selector that failed to parse', async () => {
    const result = await run('query', 'document[phase=', '--root', DEMO);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('^');
    expect(result.err).toContain('document[phase=');
  });

  it('names the valid relations when given a bad one', async () => {
    const result = await run('query', 'document -invents-> document', '--root', DEMO);
    expect(result.err).toContain('delegates-to');
  });
});

describe('graph', () => {
  it('exports Graphviz', async () => {
    const result = await run('graph', '--root', DEMO);
    expect(result.out).toContain('digraph spec {');
    expect(result.out).toContain('"ADR-0002"');
    expect(result.code).toBe(EXIT_OK);
  });

  it('exports Mermaid', async () => {
    const result = await run('graph', '--root', DEMO, '--graph-format', 'mermaid');
    expect(result.out).toMatch(/^graph LR/);
    expect(result.out).toContain('classDef retired');
  });

  it('lifts item relations onto documents when items are hidden', async () => {
    // Hiding items must not hide the handover they describe.
    const full = await run('graph', '--root', DEMO, '--graph-format', 'json');
    const lifted = await run('graph', '--root', DEMO, '--graph-format', 'json', '--documents-only');
    const parse = (text: string): { nodes: { kind: string }[]; edges: { kind: string; from: string; to: string }[] } =>
      JSON.parse(text);

    expect(parse(full.out).nodes.some((node) => node.kind === 'item')).toBe(true);
    expect(parse(lifted.out).nodes.every((node) => node.kind === 'document')).toBe(true);
    expect(parse(lifted.out).edges).toContainEqual(
      expect.objectContaining({ kind: 'delegates-to', from: 'ADR-0003', to: 'ADR-0002' }),
    );
  });
});

describe('running a registered rule by name', () => {
  const PROJECT = 'tests/fixtures/project';

  it('runs the rule the configuration declared', async () => {
    // The open question ADR-0016 shipped with: the rule is already compiled by
    // now, and the alternative is copying its selector out of the file by hand.
    const result = await run('query', 'project:no-draft-dependency', '--root', PROJECT);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('ADR-0001 -depends-on-> ADR-0002');
    expect(result.out).toContain('1 match');
  });

  it('reads a rule with two selectors as a union, and a path both find as one', async () => {
    const result = await run('query', 'project:twice-over', '--root', PROJECT);
    expect(result.out).toContain('1 match');
    expect(result.out).toContain('ADR-0002');
  });

  it('names the selector under --verbose, which is what calibrating one needs', async () => {
    const result = await run('query', 'project:no-draft-dependency', '--root', PROJECT, '--verbose');
    expect(result.out).toContain('project:no-draft-dependency: document[phase=active] -depends-on-> document[phase=draft]');
  });

  it('rejects a name nothing declares, and lists what is declared', async () => {
    const result = await run('query', 'project:no-such-rule', '--root', PROJECT);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('unknown rule "project:no-such-rule"');
    expect(result.err).toContain('project:no-draft-dependency');
  });

  it('says so when the repository declares none at all', async () => {
    const result = await run('query', 'project:anything', '--root', PROJECT, '--no-config');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('defines no project rules');
  });

  it('still reads a selector that only looks like a namespace', async () => {
    const result = await run('query', 'document[id=ADR-0002]', '--root', PROJECT);
    expect(result.code).toBe(EXIT_OK);
  });
});

describe('finding the configuration from a subdirectory', () => {
  const PROJECT = 'tests/fixtures/project';
  const absolute = (relative: string): string => `${process.cwd()}/${relative}`;

  it('reports exactly what a run from the top reports', async () => {
    // The whole claim of ADR-0018 in one assertion. Markdown rather than the
    // human report because the human one prints how long the run took.
    const top = await run('check', '--root', PROJECT, '--format', 'markdown');
    const nested = await runIn(absolute(`${PROJECT}/docs`), 'check', '--format', 'markdown');
    expect(nested.out).toBe(top.out);
    expect(nested.out).toContain('docs/0001.md');
    expect(nested.code).toBe(top.code);
  });

  it('names the configuration the way the reader would have to type it', async () => {
    const nested = await runIn(absolute(`${PROJECT}/docs`), 'check', '--verbose', '--format', 'markdown');
    expect(nested.out).toContain('configuration: ../.spec-graph.json');
  });

  it('keeps a pattern typed on the command line relative to where it was typed', async () => {
    // The root moved up; the pattern did not. `docs/*.md` from inside the
    // package means the package's docs, and reporting them against the root is
    // what makes a baseline key survive being recorded from anywhere.
    const nested = await runIn(absolute(`${PROJECT}/docs`), 'query', 'document', '.', '--format', 'json');
    expect(nested.code).toBe(EXIT_OK);
    const parsed = JSON.parse(nested.out) as { matches: { nodes: { file: string }[] }[] };
    expect(parsed.matches.map((match) => (match.nodes[0] as { file: string }).file).sort()).toEqual([
      'docs/0001.md',
      'docs/0002.md',
    ]);
  });

  it('leaves an absolute path alone, since it was never relative to anywhere', async () => {
    // The root moving cannot change what an absolute path means, and a run from
    // a subdirectory must not start prefixing one.
    const absolutePattern = absolute(`${PROJECT}/docs/0001.md`);
    const nested = await runIn(absolute(`${PROJECT}/docs`), 'check', absolutePattern, '--format', 'markdown');
    const top = await run('check', '--root', PROJECT, absolutePattern, '--format', 'markdown');
    expect(nested.out).toBe(top.out);
  });

  it('does not discover anything when --root says where the root is', async () => {
    // A flag always wins, and naming the root is naming it. Pointed at the
    // documents directory, the rules one level above it never run.
    const result = await run('check', '--root', `${PROJECT}/docs`);
    expect(result.out).not.toContain('project:no-draft-dependency');
    expect(result.code).toBe(EXIT_OK);
  });
});

describe('rules', () => {
  it('lists every rule with its default severity', async () => {
    const result = await run('rules');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('ghost-handover');
    expect(result.out).toContain('error');
  });

  it('shows the selector equivalent with --explain', async () => {
    const result = await run('rules', '--explain');
    expect(result.out).toContain('-delegates-to,blocked-by->');
  });

  it('names the ADR that decided each rule, rather than paraphrasing it', async () => {
    // A rule that fires is a claim about somebody's repository. The reasoning
    // is written down once, in an ADR this corpus checks, and pointed at from
    // here - a second copy would be the drift this tool exists to catch.
    const result = await run('rules', '--explain');
    expect(result.out).toContain('docs/adr/0002-lifecycle-lattice.md');
    expect(result.out).toContain('docs/adr/0014-a-relation-is-spelled-both-ways.md');
  });

  it('narrows to one rule when asked for one', async () => {
    const result = await run('rules', 'ghost-handover', '--explain');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('ghost-handover');
    expect(result.out).not.toContain('stale-premise');
    expect(result.out.trimEnd().split('\n')).toHaveLength(3);
  });

  it('narrows to a project rule, and names where it was declared', async () => {
    const result = await run('rules', 'project:twice-over', '--explain', '--root', 'tests/fixtures/project');
    expect(result.out).toContain('.spec-graph.json: rules.twice-over');
    expect(result.out).not.toContain('ghost-handover');
  });

  it('rejects a name no rule has, and lists both kinds', async () => {
    const result = await run('rules', 'ghost-handoverr', '--root', 'tests/fixtures/project');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('unknown rule "ghost-handoverr"');
    expect(result.err).toContain('ghost-handover,');
    expect(result.err).toContain('project:no-draft-dependency');
  });
});

describe('help and version', () => {
  it('prints usage', async () => {
    const result = await run('--help');
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain('USAGE');
    expect(result.out).toContain('SELECTORS');
  });

  it('prints a version', async () => {
    const result = await run('--version');
    expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports a usage error on stderr with exit 2', async () => {
    const result = await run('--not-a-flag');
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toContain('spec-graph:');
    expect(result.out).toBe('');
  });
});

const LEGACY = 'tests/fixtures/legacy';

describe('historical records', () => {
  it('indicts a journal until it is declared one, and never after', async () => {
    const before = await run('check', '--root', LEGACY, '--no-config');
    expect(before.out).toContain('ghost-handover');
    expect(before.code).toBe(EXIT_FAILED);

    const after = await run('check', '--root', LEGACY, '--no-config', '--history', '**/JOURNAL_*.md');
    expect(after.out).not.toContain('ghost-handover');
  });

  it('still reports where its links go', async () => {
    const after = await run('check', '--root', LEGACY, '--no-config', '--history', '**/JOURNAL_*.md');
    expect(after.out).toContain('broken-reference');
    expect(after.out).toContain('migration.md');
  });

  it('leaves its checkboxes out of the headline count', async () => {
    // The summary is only built by a real run, which is why this is asserted
    // here rather than against analyseSources.
    const before = await run('check', '--root', LEGACY, '--no-config');
    const after = await run('check', '--root', LEGACY, '--no-config', '--history', '**/JOURNAL_*.md');
    expect(before.out).toContain('1 open');
    expect(after.out).toContain('0 open');
  });
});

describe('the baseline', () => {
  const FILE = '.tmp-baseline.json';
  const path = `${LEGACY}/${FILE}`;

  it('records, suppresses, and lets the next new finding through', async () => {
    const { rm, readFile, writeFile } = await import('node:fs/promises');
    try {
      const recorded = await run('check', '--root', LEGACY, '--no-config', '--record-baseline', FILE);
      expect(recorded.code).toBe(EXIT_OK);
      expect(recorded.out).toContain(`in ${FILE}`);

      const written = await readFile(path, 'utf8');
      expect(JSON.parse(written)).toMatchObject({ version: 1 });
      // Recorded by specification and citation, so no line number can go stale.
      expect(written).not.toMatch(/"line"|"column"/);

      const clean = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE);
      expect(clean.code).toBe(EXIT_OK);
      expect(clean.out).toContain(`accepted by ${FILE}`);

      // One new broken link, and the build fails again.
      const extra = `${LEGACY}/docs/adr/0009-new.md`;
      await writeFile(extra, '# ADR-0009: New\n\n## Status\n\naccepted\n\nSee [gone](docs/nope.md).\n');
      try {
        const worse = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE);
        expect(worse.code).toBe(EXIT_FAILED);
        expect(worse.out).toContain('docs/nope.md');
      } finally {
        await rm(extra, { force: true });
      }
    } finally {
      await rm(path, { force: true });
    }
  });

  it('accepts nothing when the file is not there yet', async () => {
    const missing = await run('check', '--root', LEGACY, '--no-config', '--baseline', 'nothing-here.json');
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.err).toBe('');
  });

  it('reports a baseline it cannot read rather than trusting it', async () => {
    const { rm, writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json');
    try {
      const broken = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE);
      expect(broken.err).toContain('not valid JSON');
      expect(broken.code).toBe(EXIT_FAILED);
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe('SARIF', () => {
  it('reports the findings in the shape a code-scanning uploader expects', async () => {
    const sarif = await run('check', '--root', LEGACY, '--no-config', '--format', 'sarif');
    expect(sarif.code).toBe(EXIT_FAILED);
    const report = JSON.parse(sarif.out) as {
      version: string;
      runs: {
        tool: { driver: { name: string; rules: { id: string }[] } };
        results: {
          ruleId: string;
          level: string;
          locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
          partialFingerprints: { specGraphIdentity: string };
        }[];
      }[];
    };
    expect(report.version).toBe('2.1.0');
    const [only] = report.runs;
    expect(only?.tool.driver.name).toBe('spec-graph');
    expect(only?.results.length).toBeGreaterThan(0);

    const first = only?.results[0];
    expect(['error', 'warning', 'note']).toContain(first?.level);
    // Repository-relative and POSIX, which is what an uploader resolves against.
    expect(first?.locations[0]?.physicalLocation.artifactLocation.uri).not.toContain(String.fromCharCode(92));
    expect(first?.locations[0]?.physicalLocation.region.startLine).toBeGreaterThan(0);

    // The driver describes this run, not the tool: only the rules that fired.
    const fired = new Set(only?.results.map((result) => result.ruleId));
    expect(only?.tool.driver.rules.map((rule) => rule.id).sort()).toEqual([...fired].sort());
  });

  it('fingerprints a finding the way a baseline does, so neither drifts on an edit', async () => {
    const before = await run('check', '--root', LEGACY, '--no-config', '--format', 'sarif');
    const prints = (text: string) =>
      (JSON.parse(text) as { runs: { results: { partialFingerprints: { specGraphIdentity: string } }[] }[] }).runs[0]
        ?.results.map((result) => result.partialFingerprints.specGraphIdentity);
    // No line number in it, by construction: that is the whole point of the
    // identity ADR-0012 keys on, and it is what lets a consumer follow one
    // finding across commits.
    for (const print of prints(before.out) ?? []) expect(print).not.toMatch(/:\d+/);
    expect(prints(before.out)?.[0]).toMatch(/^[a-z-]+\//);
  });

  it('is byte-identical between runs', async () => {
    const first = await run('check', '--root', LEGACY, '--no-config', '--format', 'sarif');
    const second = await run('check', '--root', LEGACY, '--no-config', '--format', 'sarif');
    // No timestamp, no absolute path, no run id. A file that differs when
    // nothing did is a file nobody can diff.
    expect(first.out).toBe(second.out);
  });

  it('belongs to check, and says so rather than falling back', () => {
    expect(() => parseArgs(['graph', '--format', 'sarif'], '/repo')).toThrow(UsageError);
    expect(() => parseArgs(['check', '--format', 'sarif'], '/repo')).not.toThrow();
  });
});

describe('the other side of the ratchet', () => {
  const FILE = '.tmp-ratchet.json';
  const path = `${LEGACY}/${FILE}`;

  /**
   * Records today's debt, then adds one entry for a defect nobody has.
   *
   * That is the shape the ratchet exists for: a file that is exactly right
   * about the repository except for the one exemption somebody already paid
   * off and forgot to strike.
   */
  async function withSlack(entry?: Record<string, unknown>): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    await run('check', '--root', LEGACY, '--no-config', '--record-baseline', FILE);
    const held = JSON.parse(await readFile(path, 'utf8')) as { version: number; findings: unknown[] };
    // ADR-0003 is a real document in this corpus, and it has no broken link to
    // `docs/never-existed.md`. That is what "paid" means: the exemption
    // outlived the defect, and the document is still here to prove it.
    held.findings.push(
      entry ?? { rule: 'broken-reference', document: 'ADR-0003', subject: 'docs/never-existed.md', count: 1 },
    );
    await writeFile(path, JSON.stringify(held));
  }

  it('says so and passes by default', async () => {
    const { rm } = await import('node:fs/promises');
    await withSlack();
    try {
      const loose = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE);
      expect(loose.out).toContain('no longer occurs');
      // ADR-0012: failing a build because somebody fixed something is a strange
      // way to encourage them. The default stays soft.
      expect(loose.code).toBe(EXIT_OK);
    } finally {
      await rm(path, { force: true });
    }
  });

  it('tells a document that left the corpus apart from a defect that was fixed', async () => {
    // The distinction ADR-0012 asked for. An entry about a document this run
    // never saw is not the ratchet working - the usual way to produce one is to
    // narrow an include pattern, which loses sight of a defect rather than
    // fixing it, and "paid" would be congratulating somebody for that.
    const { rm } = await import('node:fs/promises');
    await withSlack({ rule: 'broken-reference', document: 'ADR-0404', subject: 'docs/x.md', count: 1 });
    try {
      const loose = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE, '--verbose');
      expect(loose.out).toContain('gone: broken-reference ADR-0404 "docs/x.md" - ADR-0404 is not in this corpus');
      expect(loose.out).toContain('check the include patterns before re-recording');
      expect(loose.out).not.toContain('paid: broken-reference ADR-0404');
    } finally {
      await rm(path, { force: true });
    }
  });

  it('names the stale entries in the JSON report, where a bot can read them', async () => {
    // ADR-0015 left this open: the human report names them and JSON counted
    // them. A number is enough to know the file has slack and never enough to
    // strike it, and the rows cannot go on stdout without breaking the parse.
    const { rm } = await import('node:fs/promises');
    await withSlack();
    try {
      const json = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE, '--format', 'json');
      const report = JSON.parse(json.out) as {
        baseline: { stale: number; entries: { rule: string; document: string; reason: string }[] };
      };
      expect(report.baseline.stale).toBe(1);
      expect(report.baseline.entries).toEqual([
        { rule: 'broken-reference', document: 'ADR-0003', subject: 'docs/never-existed.md', count: 1, reason: 'paid' },
      ]);
      // Nothing leaked onto stdout beside the document.
      expect(json.out.trimStart().startsWith('{')).toBe(true);
    } finally {
      await rm(path, { force: true });
    }
  });

  it('fails on the slack when asked to', async () => {
    const { rm } = await import('node:fs/promises');
    await withSlack();
    try {
      const tight = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE, '--ratchet');
      expect(tight.code).toBe(EXIT_FAILED);
      // Named, not counted: a number says the file has slack, and is not enough
      // to strike it.
      expect(tight.out).toContain('paid: broken-reference ADR-0003 "docs/never-existed.md"');
      // The verdict has to agree with the exit code.
      expect(tight.out).toContain('the baseline is looser than the repository');
      expect(tight.out).not.toContain('the specification graph is consistent');
    } finally {
      await rm(path, { force: true });
    }
  });

  it('says the same thing in JSON, and says only that', async () => {
    const { rm } = await import('node:fs/promises');
    await withSlack();
    try {
      const tight = await run(
        'check', '--root', LEGACY, '--no-config', '--baseline', FILE, '--ratchet', '--format', 'json', '--verbose',
      );
      // The `paid:` lines are a human courtesy. On stdout beside JSON they are
      // the difference between a report a bot can parse and one it cannot.
      const report = JSON.parse(tight.out) as { ok: boolean; baseline: { stale: number; ratchet: boolean } };
      expect(report.ok).toBe(false);
      expect(report.baseline).toMatchObject({ stale: 1, ratchet: true });
    } finally {
      await rm(path, { force: true });
    }
  });

  it('has nothing to fail on when the baseline is exact', async () => {
    const { rm } = await import('node:fs/promises');
    try {
      await run('check', '--root', LEGACY, '--no-config', '--record-baseline', FILE);
      const tight = await run('check', '--root', LEGACY, '--no-config', '--baseline', FILE, '--ratchet');
      expect(tight.code).toBe(EXIT_OK);
    } finally {
      await rm(path, { force: true });
    }
  });

  it('has nothing to fail on with no baseline at all', async () => {
    // The flag is about a file. Without one there is no slack to find, and it
    // must not turn into a second `--strict`.
    const alone = await run('check', '--root', LEGACY, '--no-config', '--ratchet');
    expect(alone.code).toBe(EXIT_FAILED);
    expect(alone.out).toContain('the specification graph is inconsistent');
  });

  it('is a flag and a configuration key', () => {
    expect(parseArgs(['check', '--ratchet'], '/repo').ratchet).toBe(true);
    expect(parseArgs(['check'], '/repo').ratchet).toBe(false);
  });
});
