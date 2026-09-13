import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compileGlob,
  createGlobMatcher,
  createReferenceFilter,
  globBase,
  globToRegExp,
  isGlob,
  walkFiles,
} from '../src/glob.js';

const ROOT = 'tests/fixtures/.tmp/glob';

// The automaton, because that is what the walk runs. `globToRegExp` is the
// oracle it is held to below, not the thing under test.
const matches = (pattern: string, path: string): boolean => compileGlob(pattern).test(path);

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
    // Folding the separator in does not make it optional inside a name.
    expect(matches('a/**/b', 'a/xb')).toBe(false);
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
    // `!` negates and is not itself a member; `^` is only a character.
    expect(matches('[!a]', '!')).toBe(true);
    expect(matches('[^a]', '^')).toBe(true);
    expect(matches('[^a]', 'b')).toBe(false);
  });

  it('treats an unmatched bracket, brace or comma as a literal', () => {
    expect(matches('a[b.md', 'a[b.md')).toBe(true);
    expect(matches('a][b]', 'a]b')).toBe(true);
    expect(matches('a}b', 'a}b')).toBe(true);
    expect(matches('a,b', 'a,b')).toBe(true);
  });

  it('escapes regex metacharacters in literal text', () => {
    expect(matches('docs/a.b.md', 'docs/aXbXmd')).toBe(false);
    expect(matches('docs/a+b.md', 'docs/a+b.md')).toBe(true);
  });

  it('recognises which strings are patterns', () => {
    expect(isGlob('docs/**/*.md')).toBe(true);
    expect(isGlob('docs/a.md')).toBe(false);
  });

  it('respects case where the host filesystem does, unless told otherwise', () => {
    expect(compileGlob('Docs/*.md', { ignoreCase: false }).test('docs/a.md')).toBe(false);
    expect(compileGlob('Docs/*.md', { ignoreCase: true }).test('docs/a.md')).toBe(true);
    expect(compileGlob('Docs/*.md').test('docs/a.md')).toBe(process.platform === 'win32');
    // The RegExp kept for callers reads case the same way by default.
    expect(globToRegExp('Docs/*.md').test('docs/a.md')).toBe(process.platform === 'win32');
  });

  it('names the glob, not the expression it became, when one does not compile', () => {
    // Before, this printed `Invalid regular expression: /^docs\/(?:a$/i:
    // Unterminated group` - a parenthesis the user never typed, in a language
    // they never wrote.
    expect(() => compileGlob('docs/{a')).toThrow('invalid glob "docs/{a": unclosed "{"');
    expect(() => compileGlob('docs/[z-a].md')).toThrow(
      'invalid glob "docs/[z-a].md": characters out of order in a character class',
    );
    expect(() => createGlobMatcher(['docs/{a'])).toThrow('invalid glob "docs/{a"');
  });

  it('finds the literal prefix so the walk can be pruned', () => {
    expect(globBase('docs/adr/**/*.md')).toBe('docs/adr');
    expect(globBase('**/*.md')).toBe('');
    expect(globBase('docs/adr/0007.md')).toBe('docs/adr');
    expect(globBase('!docs/drafts/**')).toBe('docs/drafts');
  });
});

describe('the automaton against the RegExp it replaced', () => {
  const backslash = String.fromCharCode(92);
  const GLOBS = [
    '*', '**', '?', '**/*', 'docs/*.md', 'docs/**/*.md', '**/*.md', 'a/**/b', 'a/**', '**/b', 'a/**/',
    'docs/**/drafts/**/*-*.md', '**/*-*-*-*.md', '*.{md,mdx}', '{docs,rfcs}/**/*.{md,markdown}',
    '{a,{b,c}}d', '{,a}b', '{a,}b', '{}', '[abc]*', '[!abc]*', '[a-c]?', '[!a-c]', '[]', '[!]', '[a-]',
    '[-a]', '[]a]', '[!]a]', '[^a]', 'a[b', 'a]b', 'a}b', 'a,b', 'a.b', 'a+b', 'a(b)', 'a|b', 'a^b',
    'a$b', `a${backslash}b`, `[${backslash}]`, 'Docs/ADR/*.MD', 'DOCS/**', '*.MD', '[A-Z]*',
    'a**b', '***', '*?*', '?*?', '**?', 'a/*/b', 'a/*/*/b', '.*', '*.', '/**', '**/', '{a', '[z-a]',
  ];
  const PATHS = [
    '', 'a', 'b', 'c', 'd', 'ab', 'bd', 'cd', 'ad', 'a/b', 'a/x/b', 'a/x/y/b', 'a/', 'a//b', '/a',
    'docs/a.md', 'docs/adr/a.md', 'DOCS/A.MD', 'Docs/ADR/x.md', 'docs/adr/0001.mdx', 'docs/x/drafts/y/a-b.md',
    'docs/drafts/a-b.md', 'docs/drafts/ab.md', 'rfcs/a.markdown', 'rfcs/deep/a.md', 'a[b', 'a]b', 'a}b',
    'a,b', 'a.b', 'aXb', 'a+b', 'a(b)', 'a|b', 'a^b', 'a$b', `a${backslash}b`, backslash, '-', ']', '!',
    '^', 'x-y-z-w.md', 'dir/x-y-z-w.md', 'x-y.md', '.md', 'a.', 'axxb', 'a/xb', 'Z', 'zed',
  ];

  // An invalid glob must be invalid to both, so refusal is compared too.
  const outcome = (run: () => boolean): string => {
    try {
      return String(run());
    } catch {
      return 'refused';
    }
  };

  for (const flags of ['', 'i'] as const) {
    it(`gives the same answer on every glob and path${flags === 'i' ? ', case folded' : ''}`, () => {
      const disagreements: string[] = [];
      for (const glob of GLOBS) {
        for (const path of PATHS) {
          const mine = outcome(() => compileGlob(glob, { ignoreCase: flags === 'i' }).test(path));
          const theirs = outcome(() => new RegExp(globToRegExp(glob).source, flags).test(path));
          if (mine !== theirs) disagreements.push(`${glob} against ${JSON.stringify(path)}: ${mine} vs ${theirs}`);
        }
      }
      expect(disagreements).toEqual([]);
    });
  }
});

describe('termination', () => {
  // A blow-up detector, not a benchmark, with the same bound as the one in
  // regex.test.ts. Each of these took `RegExp` between two and nine seconds and
  // takes the automaton well under a millisecond: stars that are not nested
  // still multiply the ways a failing subject can be divided between them.
  const BLOW_UP = 2000;

  it('finishes on globs whose stars a backtracking engine divides a subject between', () => {
    const name = `${Array.from({ length: 321 }, () => 'x').join('-')}.txt`;
    const started = performance.now();
    expect(createGlobMatcher(['**/*-*-*-*.md'])(`docs/${name}`)).toBe(false);
    expect(createGlobMatcher(['*a*a*a*a*a*a*b'])('a'.repeat(80))).toBe(false);
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
  });

  it('finishes on a reference target, which no filesystem limits the length of', () => {
    const started = performance.now();
    expect(createReferenceFilter(['*-*-*-x'])('a-'.repeat(2000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
  });
});

describe('reference filter', () => {
  it('ignores case the same way on every platform', () => {
    expect(createReferenceFilter(['ADR-*'])('adr-0001')).toBe(true);
    expect(createReferenceFilter(['adr-*'])('ADR-0001')).toBe(true);
    expect(createReferenceFilter(['adr-*'])('rfc-0001')).toBe(false);
    // U+00B5 (micro sign) and U+03BC (mu) are different characters that the `i`
    // flag folds together. Lower-casing does not, and the filter used to add the
    // flag on Windows alone.
    expect(createReferenceFilter([String.fromCharCode(0xb5)])(String.fromCharCode(0x3bc))).toBe(false);
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
