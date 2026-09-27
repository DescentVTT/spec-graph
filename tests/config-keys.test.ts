import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';

import { HELP, main } from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import { analyseSources } from '../src/runner.js';

/**
 * What each configuration key takes, and what a value it cannot take costs.
 *
 * A key is read or it is a problem, named - never dropped. A configuration that
 * loads with one value silently left out checks a repository nobody configured,
 * and reports that one as consistent (ADR-0010). So every refusal here is a
 * named problem and an absent value, and every value a key documents is read.
 */

const README = readFileSync('README.md', 'utf8');

// Named for the process: Stryker runs a test file in several workers at once,
// in one sandbox, and a fixed path is one they write and delete under each other.
const ROOT = `tests/fixtures/.tmp/config-keys-${process.pid}`;

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const SOURCE = '.spec-graph.json';
const parse = (config: unknown) => parseConfig(JSON.stringify(config), SOURCE);

/** A retired decision still holding `open` questions: one finding, one related location per question. */
const retired = (open: number): string =>
  [
    '---',
    'status: retired',
    '---',
    '',
    '# ADR-0001: Old',
    '',
    '## Open Questions',
    '',
    ...Array.from({ length: open }, (_, n) => `- [ ] Question ${n + 1}?`),
    '',
  ].join('\n');

describe('the examples the documentation gives', () => {
  it('are configurations this build reads without a problem', () => {
    const readme = /## Configuration[\s\S]*?```json\n([\s\S]*?)```/.exec(README)?.[1];
    const help = /\n {4}(\{ "patterns"[\s\S]*?\})\n\n/.exec(HELP)?.[1];
    expect(readme).toBeDefined();
    expect(help).toBeDefined();
    for (const [where, text] of [
      ['README', readme],
      ['--help', help],
    ] as const) {
      const loaded = parseConfig(text as string, SOURCE);
      expect(loaded.problems, where).toEqual([]);
      // The one key no flag mirrors is learned from these examples or not at
      // all, so both of them show it.
      expect(loaded.config.maxRelated, where).toBeDefined();
    }
  });
});

describe('severities', () => {
  // `severities` mirrors `--rule`, so it takes the levels --help gives the flag.
  const levels = (): string[] => {
    const listed = /Override one rule: (\w+), (\w+), (\w+) or (\w+)\./.exec(HELP);
    expect(listed).not.toBeNull();
    return (listed as RegExpExecArray).slice(1);
  };

  it('takes every level --rule takes', () => {
    expect(levels()).toHaveLength(4);
    for (const level of levels()) {
      const loaded = parse({ severities: { 'self-reference': level } });
      expect(loaded.problems, level).toEqual([]);
      expect(loaded.config.severities, level).toEqual({ 'self-reference': level });
    }
  });

  it('names the levels when given another, and keeps the rest of the object', () => {
    const loaded = parse({ severities: { 'self-reference': 'loud', 'broken-reference': 'warn' } });
    expect(loaded.problems).toEqual([`${SOURCE}: "severities.self-reference" must be ${levels().slice(0, 3).join(', ')} or ${levels()[3]}`]);
    expect(loaded.config.severities).toEqual({ 'broken-reference': 'warn' });
  });

  it('refuses anything but an object of rule to severity', () => {
    // An array has no rule names in it, and an empty one would otherwise read
    // as "override nothing" - a value that looks applied and is not.
    for (const value of [null, [], ['self-reference'], 'off', 3]) {
      const loaded = parse({ severities: value });
      expect(loaded.problems, JSON.stringify(value)).toEqual([`${SOURCE}: "severities" must be an object of rule to severity`]);
      expect(loaded.config.severities, JSON.stringify(value)).toBeUndefined();
    }
  });
});

describe('strict and ratchet', () => {
  it('take true or false, and nothing that only looks like one', () => {
    for (const key of ['strict', 'ratchet'] as const) {
      expect(parse({ [key]: false }).config[key], key).toBe(false);
      expect(parse({ [key]: true }).config[key], key).toBe(true);
      for (const value of ['yes', 'true', 1, null]) {
        const loaded = parse({ [key]: value });
        expect(loaded.problems, `${key}: ${JSON.stringify(value)}`).toEqual([`${SOURCE}: "${key}" must be true or false`]);
        expect(loaded.config[key], `${key}: ${JSON.stringify(value)}`).toBeUndefined();
      }
    }
  });
});

describe('maxRelated', () => {
  it('takes a whole number from zero up, and nothing else', () => {
    for (const value of [0, 1, 8, 50]) {
      const loaded = parse({ maxRelated: value });
      expect(loaded.problems, String(value)).toEqual([]);
      expect(loaded.config.maxRelated, String(value)).toBe(value);
    }
    for (const value of [-1, 2.5, '3', null, true]) {
      const loaded = parse({ maxRelated: value });
      expect(loaded.problems, JSON.stringify(value)).toEqual([`${SOURCE}: "maxRelated" must be a non-negative whole number`]);
      expect(loaded.config.maxRelated, JSON.stringify(value)).toBeUndefined();
    }
  });

  it('caps the related locations a finding lists: 8 unless set, and 0 lists none', () => {
    const related = (maxRelated?: number): number | undefined => {
      const sources = [{ path: 'docs/adr/0001-old.md', text: retired(10) }];
      const { diagnostics } = analyseSources(sources, maxRelated === undefined ? {} : { maxRelated });
      return diagnostics.find((finding) => finding.rule === 'orphaned-obligation')?.related.length;
    };
    expect(related()).toBe(8);
    expect(related(3)).toBe(3);
    expect(related(0)).toBe(0);
  });

  it('reaches the run from the configuration file', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(`${ROOT}/docs/adr`, { recursive: true });
    await writeFile(`${ROOT}/docs/adr/0001-old.md`, retired(3));
    const related = async (): Promise<number[]> => {
      let out = '';
      await main({
        argv: ['check', '--root', ROOT, '--format', 'json'],
        cwd: process.cwd(),
        stdout: (text) => {
          out += text;
        },
        stderr: () => {},
        env: { NO_COLOR: '1' },
        isTTY: false,
      });
      const report = JSON.parse(out) as { diagnostics: { rule: string; related: unknown[] }[] };
      return report.diagnostics.filter((finding) => finding.rule === 'orphaned-obligation').map((finding) => finding.related.length);
    };
    expect(await related()).toEqual([3]);
    await writeFile(`${ROOT}/${SOURCE}`, JSON.stringify({ maxRelated: 1 }));
    expect(await related()).toEqual([1]);
  });
});

describe('a file that holds JSON but no object', () => {
  it('is a problem, never a throw and never an empty configuration', () => {
    for (const text of ['null', '[]', '42', '"strict"']) {
      expect(parseConfig(text, SOURCE), text).toEqual({ config: {}, source: SOURCE, problems: [`${SOURCE} must contain a JSON object`] });
    }
  });
});
