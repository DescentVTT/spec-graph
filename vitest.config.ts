import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is type-only: it compiles to an empty module.
      exclude: ['src/types.ts'],
      reporter: ['text', 'lcov'],
      // Floors, not targets. They sit just below the measured numbers so that
      // losing ground fails the build while ordinary refactoring does not.
      //
      // Branches is the lowest of the four and that is expected rather than a
      // gap to close. The remainder is defensive: `??` fallbacks for states the
      // type system already rules out, catch blocks that need an unreadable
      // directory or a file deleted mid-walk, and POSIX/Windows paths of which
      // only one can run on a given machine. Tests that reach those would be
      // testing the mocks. Mutation testing is the real check on the branches
      // that carry behaviour - see stryker.config.mjs.
      thresholds: {
        lines: 95,
        statements: 92,
        functions: 97,
        branches: 80,
      },
    },
  },
});
