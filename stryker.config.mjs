// @ts-check
/**
 * Mutation testing configuration.
 *
 * Coverage says a line ran. Mutation testing says an assertion actually pins
 * its behaviour down. That distinction matters more here than in most projects,
 * because spec-graph is built out of heuristics - a marker vocabulary, a verb
 * classifier, a resolution policy with deliberate asymmetries - and a heuristic
 * with a test that merely executes it is a heuristic nobody can safely change.
 *
 * The interesting mutants are the boundary ones: flipping `openness !== closed`
 * to `===`, dropping a phrase from the delegation vocabulary, inverting the
 * opportunistic-reference guard. Each of those is a real behaviour change that
 * a passing suite should never tolerate.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',

  vitest: { configFile: 'vitest.mutation.config.ts' },

  // perTest is what makes this practical: only the handful of tests that
  // actually touched a mutated line get re-run for it.
  coverageAnalysis: 'perTest',

  // types.ts is type-only and index.ts is pure re-exports: nothing to mutate.
  mutate: ['src/**/*.ts', '!src/types.ts', '!src/index.ts'],

  // Stryker's sandbox rewrites relative paths in a tsconfig that reaches
  // outside the project. Ours does not, and the rewriter calls
  // ts.parseConfigFileTextToJson, which TypeScript 7's native port no longer
  // exposes. Pointing it at a file that does not exist makes that step a no-op.
  tsconfigFile: 'tsconfig.stryker-noop.json',

  // Stryker prepends "// @ts-nocheck" to every file it copies, because a mutant
  // can easily produce a type error. Its default glob covers tests/ as well,
  // which would rewrite the fixture documents and shift every line number the
  // suite asserts on. Only the mutated sources need it.
  disableTypeChecks: 'src/**/*.ts',

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  clearTextReporter: { allowColor: false, maxTestsToLog: 0 },

  timeoutMS: 60000,
  concurrency: 8,
  // `break` is a regression guard, not an aspiration: it sits below the measured
  // score so losing ground fails the build while ordinary refactoring does not.
  thresholds: { high: 90, low: 75, break: 70 },
};
