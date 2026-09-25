import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compileGlob,
  createGlobMatcher,
  createReferenceFilter,
  globBase,
  globToRegExp,
  isGlob,
  underRoot,
  walkFiles,
} from '../src/glob.js';
import { normalisePosix, toPosix } from '../src/paths.js';

// Named for the process. Stryker runs this file in several workers at once, all
// in one sandbox, and a fixed path is one they write and delete under each other:
// the 2026-09-14 sweep counted dozens of mutants killed by ENOENT alone.
const ROOT = `tests/fixtures/.tmp/glob-${process.pid}`;

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
    // `!` negates and is not itself a member.
    expect(matches('[!a]', '!')).toBe(true);
    expect(matches('[!a]', 'a')).toBe(false);
  });

  it('reads a lone closing bracket or brace, and a comma outside braces, as itself', () => {
    expect(matches('a][b]', 'a]b')).toBe(true);
    expect(matches('a}b', 'a}b')).toBe(true);
    expect(matches('a,b', 'a,b')).toBe(true);
  });

  it('escapes regex metacharacters in literal text', () => {
    expect(matches('docs/a.b.md', 'docs/aXbXmd')).toBe(false);
    expect(matches('docs/a+b.md', 'docs/a+b.md')).toBe(true);
  });

  it('names one path with a literal, and nothing beneath it', () => {
    // A bare directory meaning its contents is the list's reading, not this.
    expect(matches('docs/a.md', 'docs/a.md')).toBe(true);
    expect(matches('docs', 'docs/a.md')).toBe(false);
  });

  it('reads a backslash as a separator, as a pattern typed on Windows means it', () => {
    expect(matches('docs\\*.md', 'docs/a.md')).toBe(true);
    expect(createGlobMatcher(['docs\\drafts'])('docs/drafts/a.md')).toBe(true);
  });

  it('recognises which strings are patterns', () => {
    expect(isGlob('docs/**/*.md')).toBe(true);
    expect(isGlob('docs/{a,b}')).toBe(true);
    expect(isGlob('docs/a.md')).toBe(false);
  });

  it('names the glob as it was written when one does not compile', () => {
    expect(() => compileGlob('docs/{a')).toThrow('invalid glob "docs/{a": a "{" is never closed');
    expect(() => compileGlob('docs/[z-a].md')).toThrow('invalid glob "docs/[z-a].md": the range "z-a" runs backwards');
    expect(() => createGlobMatcher(['docs/**', 'docs/{a'])).toThrow('invalid glob "docs/{a": a "{" is never closed');
  });

  it('counts its states, which is what a size budget reads', () => {
    expect(compileGlob('a').size).toBeLessThan(compileGlob('a/b/c').size);
  });

  it('finds the literal directory every match sits under', () => {
    expect(globBase('docs/adr/**/*.md')).toBe('docs/adr');
    expect(globBase('**/*.md')).toBe('');
    expect(globBase('docs/adr/0007.md')).toBe('docs/adr');
    expect(globBase('!docs/drafts/**')).toBe('docs/drafts');
    // A trailing slash is the directory's contents, so the directory is the base.
    expect(globBase('docs/adr/')).toBe('docs/adr');
    // Two alternatives, and the directory they share.
    expect(globBase('docs/{adr,rfcs}/*.md')).toBe('docs');
    expect(globBase('{docs,specs}/**')).toBe('');
  });
});

/*
 * What changed when spec-graph adopted spec-core's `path` dialect (ADR-0022).
 * Each is a behaviour a user can see, so each is named and tested by itself;
 * the differential below proves there are no others.
 */
describe('the dialect every spec-* tool reads', () => {
  it('respects case on every host, Windows included', () => {
    // It used to fold case where the filesystem did, so one repository gave
    // one answer on a Windows checkout and another in Linux CI.
    expect(compileGlob('Docs/*.md').test('docs/a.md')).toBe(false);
    expect(createGlobMatcher(['Docs/**'])('docs/a.md')).toBe(false);
    expect(compileGlob('Docs/*.md', { ignoreCase: true }).test('docs/a.md')).toBe(true);
    expect(compileGlob('Docs/*.md', { ignoreCase: false }).test('docs/a.md')).toBe(false);
    // The RegExp kept for callers reads case the same way on every host too.
    expect(globToRegExp('Docs/*.md').test('docs/a.md')).toBe(false);
  });

  it('respects case in a literal path, which folded on every host', () => {
    // Worse than the host-dependent case: a literal pattern was compared
    // lower-cased on Linux as well, so `README.md` also took `readme.md`.
    const matcher = createGlobMatcher(['README.md', 'docs/adr']);
    expect(matcher('README.md')).toBe(true);
    expect(matcher('readme.md')).toBe(false);
    expect(matcher('docs/adr/0001.md')).toBe(true);
    expect(matcher('docs/ADR/0001.md')).toBe(false);
  });

  it('reads ** inside a segment as *, which no longer crosses directories', () => {
    expect(matches('docs/**.md', 'docs/a.md')).toBe(true);
    expect(matches('docs/**.md', 'docs/adr/a.md')).toBe(false);
    expect(matches('a**b', 'axxb')).toBe(true);
    expect(matches('a**b', 'a/x/b')).toBe(false);
  });

  it('refuses an unclosed [ rather than reading it as a literal', () => {
    // A typo read as a literal is a scope that silently matches nothing.
    expect(() => compileGlob('docs/[draft.md')).toThrow('invalid glob "docs/[draft.md": a "[" is never closed');
    expect(() => createGlobMatcher(['a[b.md'])).toThrow('a "[" is never closed');
  });

  it('reads a trailing / as the directory\'s contents, glob or not', () => {
    // It was normalised away, so `draft*/` named a file called `drafts`.
    const matcher = createGlobMatcher(['docs/draft*/']);
    expect(matcher('docs/drafts/a.md')).toBe(true);
    expect(matcher('docs/drafts')).toBe(false);
    expect(createGlobMatcher(['docs/'])('docs/a.md')).toBe(true);
    expect(createGlobMatcher(['docs/'])('docs')).toBe(false);
  });

  it('expands braces to literals, each naming a file or a directory', () => {
    // `{docs,specs}` was a glob matching two names exactly; now it is two
    // literals, and a literal covers what is beneath it.
    const matcher = createGlobMatcher(['{docs,specs}']);
    expect(matcher('docs/a.md')).toBe(true);
    expect(matcher('specs/deep/b.md')).toBe(true);
    expect(matcher('other/a.md')).toBe(false);
    expect(matcher('docsx/a.md')).toBe(false);
  });

  it('drops a . segment, and refuses a pattern that names no path or climbs out', () => {
    expect(createGlobMatcher(['./docs/./adr'])('docs/adr/a.md')).toBe(true);
    expect(() => createGlobMatcher(['.'])).toThrow('invalid glob ".": the pattern names no path');
    expect(() => createGlobMatcher(['docs/..'])).toThrow('a pattern cannot climb out of its root');
    expect(() => createGlobMatcher(['../elsewhere/**'])).toThrow('a pattern cannot climb out of its root');
  });

  it('never matches a separator with a class, negated or not', () => {
    // `[!b]` was `[^b]` to RegExp, which matches a `/`.
    expect(matches('a[!b]c', 'a/c')).toBe(false);
    expect(matches('a[!b]c', 'axc')).toBe(true);
  });

  it('reads a ^ opening a class as negation, as ! is', () => {
    // It was a member: `[^a]` took `^` and `a`.
    expect(matches('[^a]', 'b')).toBe(true);
    expect(matches('[^a]', 'a')).toBe(false);
    expect(matches('[^a]', '^')).toBe(true);
  });
});

/**
 * spec-graph's `createGlobMatcher` before it adopted spec-core, rebuilt on the
 * deprecated `globToRegExp` as it was in 0.8.0 - on a host that did not fold
 * case in globs, since folding is the first change and is tested apart.
 */
function legacyMatcher(patterns: readonly string[], foldLiterals: boolean): (path: string) => boolean {
  const compiled = patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const normalised = normalisePosix(toPosix(negated ? pattern.slice(1) : pattern));
    const literal = !isGlob(normalised);
    return {
      negated,
      exact: literal ? normalised : null,
      expression: globToRegExp(literal ? `${normalised}/**` : normalised),
      direct: globToRegExp(normalised),
    };
  });
  const same = (a: string, b: string): boolean => (foldLiterals ? a.toLowerCase() === b.toLowerCase() : a === b);
  return (path: string): boolean => {
    let included = false;
    for (const entry of compiled) {
      const hit = entry.direct.test(path) || entry.expression.test(path) || (entry.exact !== null && same(entry.exact, path));
      if (hit) included = !entry.negated;
    }
    return included;
  };
}

describe('the dialect spec-graph read before, against the one it reads now', () => {
  /** mulberry32: small, seeded, the same on every host. */
  const random = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // spec-core's differential pieces, and the ones only spec-graph's wrapper
  // reads: case, a `^` class, a backslash, a negation.
  const PIECES = ['a', 'b', 'ab', 'A', '.', '*', '?', '[ab]', '[!a]', '[^a]', 'a*', '*b', '**', 'x**', '[a', '{a,b}', '{a,{b,.x}}', '{[,]a,b}', 'a\\b'];

  const PATTERNS = (() => {
    const rand = random(7);
    const out = new Set<string>(['docs', 'docs/', 'README.md', '*.md', 'docs/**', 'a/**/b', '**/b', '**.b', 'a**b', 'a/[!b]', '*[!a]*', '{a,b}/**', 'a/', 'A', '[^a]/b', '{.,a}/b', 'a/../b', '.', './']);
    while (out.size < 400) {
      const segments = 1 + Math.floor(rand() * 3);
      const parts: string[] = [];
      for (let i = 0; i < segments; i += 1) {
        let name = '';
        const pieces = 1 + Math.floor(rand() * 2);
        for (let j = 0; j < pieces; j += 1) name += PIECES[Math.floor(rand() * PIECES.length)] as string;
        parts.push(name);
      }
      let pattern = parts.join('/');
      if (rand() < 0.1) pattern += '/';
      if (rand() < 0.1) pattern = `!${pattern}`;
      out.add(pattern);
    }
    return [...out];
  })();

  const PATHS = (() => {
    const names = ['a', 'b', 'ab', 'ba', 'A', '.x', 'a.b', 'x', '^', 'docs', 'README.md', 'readme.md'];
    const out: string[] = [...names];
    for (const a of names) for (const b of names) out.push(`${a}/${b}`);
    for (const a of ['a', 'ab', 'A']) for (const b of names) for (const c of ['a', 'b', 'x']) out.push(`${a}/${b}/${c}`);
    return out;
  })();

  const GLOBSTAR_IN_SEGMENT = /(?:[^/{,]\*\*|\*\*[^/},])/;
  const UNCLOSED_CLASS = /\[(?![^\]/]*\])/;
  const CARET_CLASS = /\[\^/;
  const NEGATED_CLASS = /\[[!^]/;
  const DOT_SEGMENT = /(?:^!?|\/)\.(?:\/|$)/;
  const CLIMB = /(?:^!?|\/)\.\.(?:\/|$)/;

  /** The change that explains a difference, or null when none does. */
  function explain(pattern: string, path: string, legacy: boolean | 'error', core: boolean | 'error'): string | null {
    if (core === 'error') {
      if (UNCLOSED_CLASS.test(pattern)) return 'an unclosed class is an error';
      if (CLIMB.test(pattern) || DOT_SEGMENT.test(pattern)) return 'a pattern that names no path, or climbs out, is an error';
      return null;
    }
    if (legacy === 'error') return null;
    // Normalised away before it was read, so `dir*/` named `dirx` and not what
    // is in it, and `docs/` named `docs` itself as well as its contents.
    if (pattern.endsWith('/')) return "a trailing slash names a directory's contents";
    if (GLOBSTAR_IN_SEGMENT.test(pattern)) return 'a globstar inside a segment is a star';
    if (CARET_CLASS.test(pattern)) return 'a ^ opening a class negates it';
    if (NEGATED_CLASS.test(pattern) && path.includes('/')) return 'a class never matches a separator';
    if (/\{/.test(pattern) && legacy === false && core === true) return 'braces expand to literals';
    return null;
  }

  const outcome = (build: () => (path: string) => boolean): ((path: string) => boolean) | 'error' => {
    try {
      return build();
    } catch {
      return 'error';
    }
  };

  // The corpus is built here rather than inside the test, and that is not the
  // static work ADR-0007 warns about: it is patterns and paths, strings that
  // reach nothing under src/ until the test runs them.
  it('differs only where ADR-0022 says it does, and in each of those ways', () => {
    const unexplained: string[] = [];
    const seen = new Map<string, number>();
    const record = (category: string | null, row: string): void => {
      if (category === null) unexplained.push(row);
      else seen.set(category, (seen.get(category) ?? 0) + 1);
    };

    for (const pattern of PATTERNS) {
      const folding = outcome(() => legacyMatcher([pattern], true));
      const legacy = outcome(() => legacyMatcher([pattern], false));
      const core = outcome(() => createGlobMatcher([pattern]));
      if (legacy === 'error' || core === 'error') {
        if ((legacy === 'error') !== (core === 'error')) {
          record(explain(pattern, '', legacy === 'error' ? 'error' : true, core === 'error' ? 'error' : true), `${pattern}: legacy ${legacy === 'error' ? 'refused' : 'read'} it, core ${core === 'error' ? 'refused' : 'read'} it`);
        }
        continue;
      }
      for (const path of PATHS) {
        const now = core(path);
        const before = legacy(path);
        if ((folding as (path: string) => boolean)(path) !== before) record('a literal no longer ignores case', path);
        if (before !== now) record(explain(pattern, path, before, now), `${pattern} against ${path}: legacy ${before}, core ${now}`);
      }
    }

    expect(unexplained.slice(0, 12), `${unexplained.length} unexplained`).toEqual([]);
    // Every change ADR-0022 names shows up in the corpus, so the list is not
    // longer than what actually happens either.
    expect([...seen.keys()].sort()).toEqual([
      "a ^ opening a class negates it",
      "a class never matches a separator",
      "a globstar inside a segment is a star",
      "a literal no longer ignores case",
      "a pattern that names no path, or climbs out, is an error",
      "a trailing slash names a directory's contents",
      "an unclosed class is an error",
      "braces expand to literals",
    ]);
  });

  it('agrees on the patterns the documentation shows', () => {
    const shown = ['docs/**/*.md', '!docs/drafts/**', 'docs/drafts', 'docs/**/000[3]*.md', '**/JOURNAL_*.md', 'archive/**', '*.md', 'README.md'];
    for (const path of PATHS.concat(['docs/drafts/0003.md', 'docs/adr/0001.md', 'archive/x.md', 'j/JOURNAL_2024.md'])) {
      expect(createGlobMatcher(shown)(path), path).toBe(legacyMatcher(shown, false)(path));
    }
  });
});

describe('termination', () => {
  // A blow-up detector, not a benchmark. Each of these took `RegExp` between two
  // and nine seconds and takes the automaton well under a millisecond: stars
  // that are not nested still multiply the ways a failing subject can be
  // divided between them.
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
    // flag folds together. Simple case mapping does not, and the filter used
    // to add the flag on Windows alone.
    expect(createReferenceFilter([String.fromCharCode(0xb5)])(String.fromCharCode(0x3bc))).toBe(false);
    expect(createReferenceFilter([String.fromCharCode(0x3bc)])(String.fromCharCode(0xb5))).toBe(false);
  });

  it('matches a bare pattern literally, and nothing beneath it', () => {
    const filter = createReferenceFilter(['trap 55', '  ', 'docs/notes']);
    expect(filter('trap 55')).toBe(true);
    expect(filter('  Trap 55  ')).toBe(true);
    expect(filter('trap 5')).toBe(false);
    expect(filter('docs/notes/a.md')).toBe(false);
    expect(createReferenceFilter([])('anything')).toBe(false);
    expect(createReferenceFilter(['   '])('anything')).toBe(false);
  });

  it('reads . and .. as the text of a link, not as directions', () => {
    // In a path pattern `..` climbs out of the root and is refused. In a
    // target it is part of what the author wrote.
    expect(createReferenceFilter(['../../notes/*'])('../../notes/gone.md')).toBe(true);
    expect(createReferenceFilter(['./scratch/*'])('./scratch/a.md')).toBe(true);
    expect(createReferenceFilter(['./scratch/*'])('scratch/a.md')).toBe(false);
    expect(createReferenceFilter(['a/../b'])('a/../b')).toBe(true);
  });

  it('escapes with a backslash, since a target is not a host path', () => {
    expect(createReferenceFilter(['trap \\*'])('trap *')).toBe(true);
    expect(createReferenceFilter(['trap \\*'])('trap 55')).toBe(false);
  });

  it('names the pattern as written when it does not compile', () => {
    expect(() => createReferenceFilter(['../Trap [55'])).toThrow('invalid glob "../Trap [55": a "[" is never closed');
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

  it('matches nothing when given nothing', () => {
    expect(createGlobMatcher([])('docs/a.md')).toBe(false);
  });
});

describe('resolving a path against the root', () => {
  it('joins a repository-relative path, in POSIX form whatever it was given in', () => {
    expect(underRoot('/repo', '.spec-graph-baseline.json')).toBe('/repo/.spec-graph-baseline.json');
    expect(underRoot('C:\\repo', 'docs/b.json')).toBe('C:/repo/docs/b.json');
    expect(underRoot('/repo', './docs/../b.json')).toBe('/repo/b.json');
  });

  it('leaves an absolute path where it points, in either platform spelling', () => {
    // `--baseline /tmp/b.json` used to read `<root>/tmp/b.json`: a write that
    // lands where nobody looks, and a read that accepts nothing without saying
    // so. Both spellings are checked on either platform, because one repository
    // is read on a Windows checkout and in Linux CI from the same file.
    expect(underRoot('/repo', '/tmp/b.json')).toBe('/tmp/b.json');
    expect(underRoot('/repo', '\\tmp\\b.json')).toBe('/tmp/b.json');
    expect(underRoot('/repo', 'C:/tmp/b.json')).toBe('C:/tmp/b.json');
    expect(underRoot('C:/repo', 'D:\\tmp\\b.json')).toBe('D:/tmp/b.json');
  });
});

describe('walking', () => {
  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(`${ROOT}/docs/adr`, { recursive: true });
    await mkdir(`${ROOT}/docs/drafts`, { recursive: true });
    await mkdir(`${ROOT}/specs/rfcs`, { recursive: true });
    await mkdir(`${ROOT}/node_modules/pkg/docs`, { recursive: true });
    await mkdir(`${ROOT}/dist`, { recursive: true });
    await writeFile(`${ROOT}/docs/adr/0001.md`, '# One\n');
    await writeFile(`${ROOT}/docs/adr/0002.md`, '# Two\n');
    await writeFile(`${ROOT}/docs/drafts/0003.md`, '# Three\n');
    await writeFile(`${ROOT}/docs/adr/notes.txt`, 'not markdown\n');
    await writeFile(`${ROOT}/specs/rfcs/0004.md`, '# Four\n');
    await writeFile(`${ROOT}/node_modules/pkg/docs/evil.md`, '# Should never be walked\n');
    await writeFile(`${ROOT}/dist/built.md`, '# Should never be walked\n');
    await writeFile(`${ROOT}/README.md`, '# Root\n');
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  const paths = async (patterns: string[], ignore?: string[]): Promise<string[]> =>
    (await walkFiles({ root: ROOT, patterns, ignore })).map((f) => f.path);

  it('returns matching files in a stable order', async () => {
    expect(await paths(['docs/**/*.md'])).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md', 'docs/drafts/0003.md']);
  });

  it('never descends into node_modules or build output', async () => {
    const files = await paths(['**/*.md']);
    expect(files).not.toContain('node_modules/pkg/docs/evil.md');
    expect(files).not.toContain('dist/built.md');
    expect(files).toContain('README.md');
  });

  it('honours a bare-name ignore by pruning that directory at any depth', async () => {
    expect(await paths(['docs/**/*.md'], ['drafts'])).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md']);
  });

  it('honours a path-shaped ignore as the glob it is documented to be', async () => {
    // A bare name is a `.gitignore`-style directory filter; anything with a
    // separator or glob syntax is a path pattern. Treating the second as the
    // first excludes nothing, silently, while the user believes it worked.
    for (const pattern of ['docs/drafts/**', 'docs/drafts', 'docs/drafts/', 'docs/**/000[3]*.md']) {
      const files = await paths(['docs/**/*.md'], [pattern]);
      expect(files, pattern).not.toContain('docs/drafts/0003.md');
      expect(files, pattern).toContain('docs/adr/0001.md');
    }
  });

  it('leaves everything alone when no ignore is given', async () => {
    expect(await paths(['docs/**/*.md'], [])).toContain('docs/drafts/0003.md');
  });

  it('honours a negated pattern', async () => {
    expect(await paths(['docs/**/*.md', '!docs/drafts/**'])).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md']);
  });

  it('walks each directory a brace names', async () => {
    // Two literals, each a directory and what is beneath it.
    expect(await paths(['{docs/adr,specs}'])).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md', 'docs/adr/notes.txt', 'specs/rfcs/0004.md']);
    expect(await paths(['{docs,specs}/**/*.md', '!docs/drafts/**'])).toEqual([
      'docs/adr/0001.md',
      'docs/adr/0002.md',
      'specs/rfcs/0004.md',
    ]);
  });

  it('finds a directory only as it is spelled on disk, on every host', async () => {
    // The walk starts at a pattern's literal prefix, and a filesystem that
    // ignores case lists `docs` for `Docs`: every file under it came back as
    // `Docs/...`, matched, on Windows and macOS, while Linux found nothing.
    expect(await paths(['Docs/**/*.md'])).toEqual([]);
    expect(await paths(['docs/ADR/*.md'])).toEqual([]);
    expect(await paths(['docs/adr/*.md'])).toEqual(['docs/adr/0001.md', 'docs/adr/0002.md']);
  });

  it('finds nothing under the root for a pattern rooted at /', async () => {
    // A leading slash names the filesystem's root. The walk read it as the
    // repository's and reported `/docs/...`, a path no node can have.
    expect(await paths(['/docs/**/*.md'])).toEqual([]);
  });

  it('skips files larger than the limit', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], maxFileSize: 1 });
    expect(files).toHaveLength(0);
  });

  it('returns nothing rather than throwing for a missing root', async () => {
    expect(await walkFiles({ root: `${ROOT}/nope`, patterns: ['**/*.md'] })).toEqual([]);
    expect(await walkFiles({ root: `${ROOT}/nope`, patterns: ['docs/**/*.md'] })).toEqual([]);
  });

  it('reports each file once even when two patterns match it', async () => {
    const files = await walkFiles({ root: ROOT, patterns: ['docs/**/*.md', 'docs/adr/*.md'] });
    expect(files.filter((f) => f.path === 'docs/adr/0001.md')).toHaveLength(1);
  });

  it('refuses an invalid ignore as it refuses an invalid pattern', async () => {
    await expect(walkFiles({ root: ROOT, patterns: ['docs/**/*.md'], ignore: ['docs/[a'] })).rejects.toThrow(
      'invalid glob "docs/[a": a "[" is never closed',
    );
  });
});
