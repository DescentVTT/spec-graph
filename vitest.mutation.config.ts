import { defineConfig } from 'vitest/config';

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
 * splits and merges the sweep, which reaches nothing under src/, so it cannot
 * kill a mutant - and more than half of this sweep's mutants are static and run
 * the whole suite, so it would run thousands of times for nothing. bin.test.ts
 * is the one test that does spawn the launcher, for the exit code only a
 * process has: it runs what was compiled into dist/, which no mutant is.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/mutation-shards.test.ts', 'tests/bin.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
