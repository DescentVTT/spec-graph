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
