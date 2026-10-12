import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Each module of the source loads, by itself, inside a test.
 *
 * A module builds its tables while it loads, and a mutant that breaks one
 * throws there. Every test file that imports the module at its top then fails
 * to load, before it has a test to fail, and a mutation sweep counts failed
 * tests: a file that did not load is none of them, so the mutant is scored as
 * survived while nothing works. Nothing at the top of this file reaches the
 * source. Imported inside a test, the failure is that test's, whichever other
 * file imports the module and however it does (ADR-0007, 2026-10-12).
 *
 * Each import is written out, since the test runner resolves no import whose
 * path is computed. The directory is what holds the list to every module.
 */
const LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  baseline: () => import('../src/baseline.js'),
  cli: () => import('../src/cli.js'),
  config: () => import('../src/config.js'),
  diff: () => import('../src/diff.js'),
  directives: () => import('../src/directives.js'),
  extract: () => import('../src/extract.js'),
  glob: () => import('../src/glob.js'),
  graph: () => import('../src/graph.js'),
  identity: () => import('../src/identity.js'),
  index: () => import('../src/index.js'),
  lifecycle: () => import('../src/lifecycle.js'),
  markdown: () => import('../src/markdown.js'),
  paths: () => import('../src/paths.js'),
  'project-rules': () => import('../src/project-rules.js'),
  report: () => import('../src/report.js'),
  resolve: () => import('../src/resolve.js'),
  rules: () => import('../src/rules.js'),
  runner: () => import('../src/runner.js'),
  sections: () => import('../src/sections.js'),
  select: () => import('../src/select.js'),
  source: () => import('../src/source.js'),
  state: () => import('../src/state.js'),
  types: () => import('../src/types.js'),
  yaml: () => import('../src/yaml.js'),
};

describe('each module of the source', () => {
  it('is on the list, which is the directory', () => {
    const modules = readdirSync('src')
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.slice(0, -'.ts'.length));
    expect(Object.keys(LOADERS).sort()).toEqual(modules.sort());
  });

  it.each(Object.entries(LOADERS))('%s loads', async (_name, load) => {
    await expect(load()).resolves.toBeTypeOf('object');
  });
});
