import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for mutation runs.
 *
 * The same suite as the normal run, minus the coverage instrumentation and its
 * thresholds: Stryker measures its own coverage per test, and leaving v8
 * coverage on would slow every one of the thousands of mutant runs for a number
 * nobody reads.
 *
 * Nothing is excluded. The CLI tests drive `main()` in process rather than
 * spawning `node bin/spec-graph.js`, so unlike a subprocess end-to-end suite
 * they load the mutated source and can genuinely kill mutants.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
