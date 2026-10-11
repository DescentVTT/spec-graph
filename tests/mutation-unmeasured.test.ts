/**
 * What the mutation sweep does not see (scripts/mutation-unmeasured.mjs).
 *
 * Stryker makes no mutant of anything under a TypeScript `as`, so a sweep
 * holds no test to what stands there, and its score says nothing of it. The
 * script counts those places and the sweep fails on one too many. Its count
 * is held here to sources small enough to count by hand, each mutator and
 * each of its exceptions once, and the repository to the number the script
 * records as left.
 *
 * It reaches nothing under src/ a mutant could change, so the sweep leaves
 * this file out, as it does the merge's (vitest.mutation.config.ts).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { castsOf, LEFT, measure, mutatedSources, verdict } from '../scripts/mutation-unmeasured.mjs';

const sitesOf = (source: string): number[] => castsOf(source).map((cast) => cast.sites);

describe('what stands under an `as`', () => {
  it('is counted cast by cast, a cast inside another being the outer one\'s', () => {
    const source = [
      "const TABLE = { draft: 'proposed', done: ['accepted', 'final'] } as const;",
      'const last = lines[lines.length - 1] as string;',
      'const first = lines[0] as string;',
      'const both = [left as string, right.trim()] as const;',
      '',
    ].join('\n');
    expect(castsOf(source).map((cast) => [cast.line, cast.sites])).toEqual([
      // The object, its string, the array and its two: a key is no site.
      [1, 5],
      [2, 1],
      [3, 0],
      // The array and the method: `left as string` is not a cast of its own.
      [4, 2],
    ]);
    expect(castsOf(source)[1]).toMatchObject({ line: 2, column: 14, text: 'lines[lines.length - 1] as string' });
  });

  it('is not what a name, `!` or `satisfies` holds: those the sweep reads', () => {
    const source = [
      'const value = lines[lines.length - 1]!;',
      "const held = { draft: 'proposed' } satisfies Record<string, string>;",
      'const rest = text.slice(1);',
      'const cast = rest as Phase;',
      '',
    ].join('\n');
    expect(castsOf(source).map((cast) => [cast.line, cast.sites])).toEqual([[4, 0]]);
    expect(measure({ 'src/a.ts': { source } })).toMatchObject({ casts: 1, sites: 0, rows: [] });
  });

  // One line for each of Stryker's mutators and each thing one of them leaves
  // alone, as its sources have them (mutators/*.js of 10.0.0).
  it.each<[string, number]>([
    // StringLiteral: a string or a template, and not a key, a module's name or a symbol's.
    ["'text'", 1],
    ['`text`', 1],
    ["{ 'key': value }", 1],
    ["class { 'key' = 1; other = 'value'; }", 1],
    ["{ 'method'() {} }", 1],
    ["Symbol('name')", 0],
    ["require('name')", 0],
    ["import('name')", 0],
    // BooleanLiteral, and the `!` it takes off.
    ['true', 1],
    ['!flag', 1],
    // ArrayDeclaration and ObjectLiteral: an empty object is left as it is.
    ['[]', 1],
    ['new Array(3)', 1],
    ['Array(3)', 1],
    ['new Set(list)', 0],
    ['{ field }', 1],
    ['{}', 0],
    // ArithmeticOperator leaves a concatenation, and EqualityOperator the operators that compare nothing.
    ['count + 1', 1],
    ["count + 'px'", 1],
    ['left + right + `px`', 2],
    ['left & right', 0],
    ['left < right', 1],
    ['left in right', 0],
    // LogicalOperator and ConditionalExpression: a ternary is read through its test alone.
    ['left ?? right', 1],
    ['left && right', 1],
    ['flag ? left : right', 0],
    ['left === right ? one : two', 1],
    // UnaryOperator, UpdateOperator, AssignmentOperator.
    ['-count', 1],
    ['~bits', 1],
    ['typeof value', 0],
    ['count++', 1],
    ['(count += 1)', 1],
    ["(text += 'x')", 1],
    ["(text ||= 'x')", 2],
    ['(count **= 2)', 0],
    ['(count = 1)', 0],
    // OptionalChaining and MethodExpression.
    ['record?.field', 1],
    ['record.field', 0],
    ['call?.()', 1],
    ['text.trim()', 1],
    ['text?.trim()', 2],
    ['Math.min(left, right)', 1],
    ['date.setHours(1)', 1],
    ['list.concat(more)', 0],
    // Regex, counted wherever one is written.
    ['/x/', 1],
    ['1', 0],
    // ArrowFunction, BlockStatement, and the statements CallExpression drops.
    ['(value) => value', 1],
    ['() => undefined', 0],
    ['() => {}', 0],
    ['() => { run(); }', 2],
    ['() => { run?.(); }', 2],
    ['function () { throw new Error(message); }', 2],
    ['function () { throw problem; }', 1],
    // The tests of a branch and of a loop, and a case that is not a fall-through.
    ['function () { if (flag) return 1; return 2; }', 2],
    ['function () { for (;;) {} }', 2],
    ['function () { switch (kind) { case 1: return 2; case 3: default: } }', 2],
    // What TypeScript writes around a value is read through.
    ['value as unknown', 0],
    ['count! + 1', 1],
    ['[left] satisfies Kind', 1],
    // A type is not read, whatever it is written with: it holds nothing a program runs.
    ["value as 'draft' | `b${string}` | true", 0],
    ["new Map<'key', Array<true>>()", 0],
    ["(left: 'a' | 'b') => left", 1],
    ["lines[lines.length - 1] as { readonly kind: 'x'; readonly list: readonly ['a', 'b'] }", 1],
  ])('has, under (%s), sites to the number of %i', (expression, sites) => {
    expect(sitesOf(`const cast = (${expression}) as Kind;\n`)).toEqual([sites]);
  });

  it('is counted over every file, by name, with the mutants a report has inside a cast', () => {
    const span = (from: [number, number], to: [number, number]) => ({ location: { start: { line: from[0], column: from[1] }, end: { line: to[0], column: to[1] } } });
    const measured = measure({
      'src/b.ts': {
        source: ['const last = lines[lines.length - 1] as string;', 'const list = [', "  'draft',", '] as const;', ''].join('\n'),
        // In a cast that spans lines: the string on its own line, left of
        // where the cast began, the array whole, and one that runs on into
        // the line below, left of where the cast ended.
        mutants: [span([3, 3], [3, 10]), span([2, 14], [4, 2]), span([3, 3], [5, 1])],
      },
      'src/a.ts': {
        source: ['const cast = value as Kind;', "const table = ['draft'] as const;", "const other = ['final'];", ''].join('\n'),
        // The array's own mutant, then one that starts before the cast, one
        // that ends after it, one that does both, one that starts on the
        // line above, right of where the cast begins, and one on the line below.
        mutants: [span([2, 15], [2, 24]), span([2, 1], [2, 20]), span([2, 20], [2, 34]), span([2, 1], [2, 34]), span([1, 20], [2, 24]), span([3, 15], [3, 24])],
      },
    });
    expect(measured).toEqual({
      files: 2,
      casts: 4,
      sites: 5,
      inside: 3,
      rows: [
        { file: 'src/a.ts', line: 2, sites: 2, text: "['draft'] as const", mutants: 1 },
        { file: 'src/b.ts', line: 1, sites: 1, text: 'lines[lines.length - 1] as string', mutants: 0 },
        { file: 'src/b.ts', line: 2, sites: 2, text: "[ 'draft', ] as const", mutants: 2 },
      ],
    });
  });

  it('is not taken for none where a file does not parse', () => {
    expect(() => measure({ 'src/a.ts': { source: 'const value = 1;\n' }, 'src/broken.ts': { source: 'const = as;\n' } })).toThrow(
      /^src\/broken\.ts does not parse, so what stands under an `as` in it was not counted: /,
    );
  });
});

describe('the count against the number recorded as left', () => {
  const two = measure({ 'src/a.ts': { source: "const table = ['draft'] as const;\n" } });
  const none = measure({ 'src/a.ts': { source: 'const cast = value as Kind;\n' } });

  it('passes on that number and under it, and fails over it, naming each cast', () => {
    expect(verdict(two, 2)).toMatchObject({ passed: true, message: null });
    expect(verdict(two, 3).passed).toBe(true);
    const failed = verdict(two, 1);
    expect(failed.passed).toBe(false);
    expect(failed.message).toMatch(/^2 sites under an `as`, and 1 recorded as left\. /);
    expect(failed.lines).toEqual([
      '1 file, 1 `as` expression: 2 sites under 1 of them, where the sweep makes no mutant. 1 is recorded as left.',
      "  src/a.ts:1  2 sites  ['draft'] as const",
    ]);
  });

  it('says in one line that there is nothing to count', () => {
    expect(verdict(none, 0)).toEqual({
      passed: true,
      lines: ['1 file, 1 `as` expression, and nothing a mutator reads under any of them.'],
      message: null,
    });
  });

  it('says so when a report has mutants where the script says Stryker makes none', () => {
    const read = verdict({ ...two, inside: 2 }, 2);
    expect(read.passed).toBe(true);
    expect(read.lines.at(-1)).toMatch(/^The report has 2 mutants inside those expressions: this Stryker reads under an `as`/);
    expect(verdict(two, 2).lines).toHaveLength(2);
  });
});

describe('this repository', () => {
  const run = (...args: string[]): { code: number; out: string; err: string } => {
    try {
      const out = execFileSync(process.execPath, ['scripts/mutation-unmeasured.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } });
      return { code: 0, out, err: '' };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { code: failed.status, out: failed.stdout, err: failed.stderr };
    }
  };

  it('leaves under an `as` exactly what the script records as left', async () => {
    const { default: stryker } = (await import(pathToFileURL(path.resolve('stryker.config.mjs')).href)) as { default: { mutate: string[] } };
    const sources = mutatedSources(stryker.mutate);
    // Every file a shard mutates and none it does not: the vendored spec-core is spec-core's to count.
    expect(Object.keys(sources)).toContain('src/extract.ts');
    expect(Object.keys(sources).filter((name) => name.startsWith('src/vendor/') || name === 'src/types.ts')).toEqual([]);
    const measured = measure(sources);
    expect(measured.sites, verdict(measured).lines.join('\n')).toBe(LEFT);
  });

  it('fails the run that counts more, and passes the one that does not', () => {
    const directory = `tests/fixtures/.tmp/mutation-unmeasured-${process.pid}`;
    mkdirSync(directory, { recursive: true });
    try {
      const report = (source: string): string => {
        const file = `${directory}/mutation.json`;
        writeFileSync(file, JSON.stringify({ files: { 'src/a.ts': { language: 'typescript', source, mutants: [] } } }));
        return file;
      };
      const over = run(report("const table = ['draft'] as const;\n"));
      expect(over.code).toBe(1);
      expect(over.out).toContain("  src/a.ts:1  2 sites  ['draft'] as const");
      expect(over.err).toMatch(new RegExp(`^2 sites under an \`as\`, and ${LEFT} recorded as left\\. `));

      const clean = run(report("const table = ['draft'] satisfies string[];\n"));
      expect(clean).toEqual({ code: 0, out: '1 file, 0 `as` expressions, and nothing a mutator reads under any of them.\n', err: '' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the sources on disk when asked, and refuses what it does not know', () => {
    const sources = run('--sources');
    expect(sources.code).toBe(0);
    expect(sources.out).toMatch(/^\d+ files, \d+ `as` expressions, and nothing a mutator reads under any of them\.\n$/);
    expect(run('--source')).toMatchObject({ code: 2, out: '' });
    expect(run('a.json', 'b.json').code).toBe(2);
  });

  it('is counted by the sweep on the report its merge wrote, once the incremental file is published', () => {
    const workflow = readFileSync('.github/workflows/mutation.yml', 'utf8');
    const merge = workflow.indexOf('run: node scripts/mutation-shards.mjs merge reports/shards');
    const publish = workflow.indexOf('- name: Publish the incremental file');
    const count = workflow.indexOf('run: node scripts/mutation-unmeasured.mjs reports/mutation/mutation.json');
    expect(merge).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(merge);
    // After the publish: what the sweep measured is true whatever it could
    // not see, and a pull request has to be able to start from it.
    expect(count).toBeGreaterThan(publish);
  });
});
