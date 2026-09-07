import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGlobMatcher, globBase, globToRegExp, isGlob, walkFiles } from '../src/glob.js';

const ROOT = 'tests/fixtures/.tmp/glob';

const matches = (pattern: string, path: string): boolean => globToRegExp(pattern).test(path);

describe('glob compilation', () => {
  it('matches a single segment with *', () => {
    expect(matches('docs/*.md', 'docs/a.md')).toBe(true);
    expect(matches('docs/*.md', 'docs/adr/a.md')).toBe(false);
  });

  it('crosses directories with **', () => {
    expect(matches('docs/**/*.md', 'docs/adr/a.md')).toBe(true);
    expect(matches('docs/**/*.md', 'docs/adr/deep/a.md')).toBe(true);
    // `a/**/b` must also match `a/b`, which is what people expect from the form.
    expect(matches('docs/**/*.md', 'docs/a.md')).toBe(true);
  });

  it('matches one character with ?', () => {
    expect(matches('adr/000?.md', 'adr/0007.md')).toBe(true);
    expect(matches('adr/000?.md', 'adr/00007.md')).toBe(false);
  });

  it('expands braces', () => {
    expect(matches('docs/*.{md,mdx}', 'docs/a.mdx')).toBe(true);
    expect(matches('docs/*.{md,mdx}', 'docs/a.txt')).toBe(false);
  });

  it('handles character classes, negated ones included', () => {
    expect(matches('adr/[01]*.md', 'adr/0007.md')).toBe(true);
    expect(matches('adr/[!0]*.md', 'adr/0007.md')).toBe(false);
    expect(matches('adr/[!0]*.md', 'adr/x.md')).toBe(true);
  });

  it('treats an unmatched bracket as a literal', () => {
    expect(matches('a[b.md', 'a[b.md')).toBe(true);
  });

  it('escapes regex metacharacters in literal text', () => {
    expect(matches('docs/a.b.md', 'docs/aXbXmd')).toBe(false);
    expect(matches('docs/a+b.md', 'docs/a+b.md')).toBe(true);
  });

  it('recognises which strings are patterns', () => {
    expect(isGlob('docs/**/*.md')).toBe(true);
    expect(isGlob('docs/a.md')).toBe(false);
  });

  it('finds the literal prefix so the walk can be pruned', () => {
    expect(globBase('docs/adr/**/*.md')).toBe('docs/adr');
    expect(globBase('**/*.md')).toBe('');
    expect(globBase('docs/adr/0007.md')).toBe('docs/adr');
    expect(globBase('!docs/drafts/**')).toBe('docs/drafts');
  });
});

describe('matcher', () => {
  it('lets a later negation override an earlier include', () => {
    const matcher = createGlobMatcher(['docs/**/*.md', '!docs/drafts/**']);
    expect(matcher('docs/adr/a.md')).toBe(true);
    expect(matcher('docs/drafts/a.md')).toBe(false);
  });

  it('lets a later include override an earlier negation', () => {
    const matcher = createGlobMatcher(['docs/**/*.md', '!docs/drafts/**', 'docs/drafts/keep.md']);
    expect(matcher('docs/drafts/keep.md')).toBe(true);
    expect(matcher('docs/drafts/other.md')).toBe(false);
  });

  it('treats a bare directory as everything beneath it', () => {
    const matcher = createGlobMatcher(['docs']);
    expect(matcher('docs/adr/a.md')).toBe(true);
    expect(matcher('other/a.md')).toBe(false);
  });

  it('matches an exact file path', () => {
    const matcher = createGlobMatcher(['README.md']);
    expect(matcher('README.md')).toBe(true);
    expect(matcher('docs/README.md')).toBe(false);
  });
});

describe('walking', () => {
  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(`${ROOT}/docs/adr`, { recursive: true });
    await mkdir(`${ROOT}/docs/drafts`, { recursive: true });
    await mkdir(`${ROOT}/node_modules/pkg/docs`, { recursive: true });
    await mkdir(`${ROOT}/dist`, { recursive: true });
    await writeFile(`${ROOT}/docs/adr/0001.md`, '# One\n');
    await writeFile(`${ROOT}/docs/adr/0002.md`, '# Two\n');
    await writeFile(`${ROOT}/docs/drafts/0003.md`, '# Three\n');
    await writeFile(`${ROOT}/docs/adr/notes.txt`, 'not markdown\n');
    await writeFile(`${ROOT}/node_modules/pkg/docs/evil.md`, '# Should never be walked\n');
    await writeFile(`${ROOT}/dist/built.md`, '# Should never be walked\n');
    await writeFile(`${ROOT}/README.md`, '# Root\n');
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('returns matching files in a stable order', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(files.map((f) => f.path)).toEqual([
      'docs/adr/0001.md',
      'docs/adr/0002.md',
      'docs/drafts/0003.md',
    ]);
  });

  it('never descends into node_modules or build output', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['**/*.md'] });
    expect(files.map((f) => f.path)).not.toContain('node_modules/pkg/docs/evil.md');
    expect(files.map((f) => f.path)).not.toContain('dist/built.md');
    expect(files.map((f) => f.path)).toContain('README.md');
  });

  it('honours a bare-name ignore by pruning that directory at any depth', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], ignore: ['drafts'] });
    expect(files.map((f) => f.path)).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md']);
  });

  it('honours a path-shaped ignore as the glob it is documented to be', async () => {
    // A bare name is a `.gitignore`-style directory filter; anything with a
    // separator or glob syntax is a path pattern. Treating the second as the
    // first excludes nothing, silently, while the user believes it worked.
    for (const pattern of ['docs/drafts/**', 'docs/drafts', 'docs/**/000[3]*.md']) {
      const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], ignore: [pattern] });
      expect(files.map((f) => f.path), pattern).not.toContain('docs/drafts/0003.md');
      expect(files.map((f) => f.path), pattern).toContain('docs/adr/0001.md');
    }
  });

  it('leaves everything alone when no ignore is given', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], ignore: [] });
    expect(files.map((f) => f.path)).toContain('docs/drafts/0003.md');
  });

  it('honours a negated pattern', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md', '!docs/drafts/**'] });
    expect(files.map((f) => f.path)).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md']);
  });

  it('skips files larger than the limit', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], maxFileSize: 1 });
    expect(files).toHaveLength(0);
  });

  it('returns nothing rather than throwing for a missing root', async () => {
    expect(await walkFiles({ root: `${ROOT}/nope`, patterns: ['**/*.md'] })).toEqual([]);
  });

  it('reports each file once even when two patterns match it', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md', 'docs/adr/*.md'] });
    expect(files.filter((f) => f.path === 'docs/adr/0001.md')).toHaveLength(1);
  });
});
