import { relative } from 'node:path';

import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * The order a mutant's test files run in: a file that failed in the worker's
 * last run first, as vitest has it, then the quickest first, where vitest
 * runs the longest first.
 *
 * Stryker runs a mutant's files one after another in one worker and stops at
 * the first test that fails: every file for a static mutant, the files of the
 * tests that cover it for any other. What a mutant costs is the files that
 * run before the one that kills it. Vitest's order suits a run that reports
 * every failure and wants the long files started early. Here fourteen files
 * cover a mutant that is not static, and the longest of all,
 * `tests/cli.test.ts`, twice as long as any other, covers seven such mutants
 * in ten. In the three sweeps before this order one mutant in seven was
 * killed only after tests of another file had completed: 135 such tests for
 * a mutant that is not static, and 50 in the first sweep in this order
 * (ADR-0007, 2026-10-11).
 *
 * No test leaves the run and none is added: a mutant survives when every
 * file has passed, in any order. That sweep read the score of the three
 * before it, 96.50% over 8,832 mutants with the same 293 survivors, and its
 * mutants that are not static took 33 minutes of the four shards where they
 * had taken 41 to 43. The static ones took the 13 they had taken: one killed
 * late had 700 tests ahead of its killer in either order.
 *
 * A file the worker has not run yet has no time to go by. It runs after
 * those that have, the smaller first, and has a time from then on. The time
 * is the file's last run in that worker, which for a mutant that is not
 * static is the tests that cover it and no others.
 */
export class QuickestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { cache, config } = this.ctx;
    const rank = (file: TestSpecification): [number, number] => {
      // The key vitest's own sequencer reads its cache by; a test holds the two together.
      const key = `${file.project.name}:${relative(config.root, file.moduleId).replaceAll('\\', '/')}`;
      const last = cache.getFileTestResults(key);
      if (last === undefined) return [2, cache.getFileStats(key)?.size ?? 0];
      return [last.failed ? 0 : 1, last.duration];
    };
    const ranked = files.map((file) => ({ file, rank: rank(file) }));
    return ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map(({ file }) => file);
  }
}

/**
 * Vitest configuration for mutation runs.
 *
 * The same suite as the normal run, minus the coverage instrumentation and its
 * thresholds: Stryker measures its own coverage per test, and leaving v8
 * coverage on would slow every one of the thousands of mutant runs for a number
 * nobody reads.
 *
 * The CLI tests drive `main()` in process rather than spawning
 * `node bin/spec-graph.js`, so unlike a subprocess end-to-end suite they load
 * the mutated source and can genuinely kill mutants. They stay.
 *
 * Two files are excluded. mutation-shards.test.ts tests the CI script that
 * splits and merges the sweep, and the order above, which reaches nothing under
 * src/, so it cannot kill a mutant - and a static mutant runs the whole suite,
 * so it would run thousands of times for nothing. bin.test.ts is the one test
 * that does spawn the launcher, for the exit code only a process has: it runs
 * what was compiled into dist/, which no mutant is.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/mutation-shards.test.ts', 'tests/bin.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { sequencer: QuickestFirst },
  },
});
