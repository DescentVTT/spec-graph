/**
 * Pattern matching and directory walking.
 *
 * A dependency-free glob, because pulling in a matcher for `docs/**\/*.md` would
 * be the single largest thing in the package. The supported syntax is the
 * portion people actually type - `**`, `*`, `?`, `{a,b}`, `[abc]`, and a leading
 * `!` for negation - and everything is matched against repository-relative
 * POSIX paths so results do not depend on the host platform.
 */

import { readdir, stat } from 'node:fs/promises';

import { joinPosix, normalisePosix, toPosix } from './paths.js';

/** Directories skipped unless a pattern explicitly names them. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
]);

/** Files larger than this are skipped: a specification is not a binary. */
export const MAX_FILE_SIZE = 4 * 1024 * 1024;

export interface WalkedFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** Absolute host path, for reading. */
  readonly absolute: string;
  readonly size: number;
}

export interface WalkOptions {
  readonly root: string;
  readonly patterns: readonly string[];
  readonly ignore?: readonly string[] | undefined;
  readonly maxFileSize?: number | undefined;
  /** Follow directory symlinks. Off by default: cycles are real. */
  readonly followSymlinks?: boolean | undefined;
}

/** True when the string contains glob syntax rather than being a literal path. */
export function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * Compiles a glob to an anchored regular expression.
 *
 * `**` crosses directory separators; `*` and `?` do not. A trailing `/` or a
 * bare directory name matches everything beneath it, which is what people mean
 * when they write `--ignore drafts`.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  let i = 0;
  const braces: number[] = [];

  while (i < pattern.length) {
    const ch = pattern[i] as string;

    if (ch === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        const slashAfter = pattern[i + 2] === '/';
        // `a/**/b` must also match `a/b`, so the separator is folded in.
        source += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
      } else {
        source += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        source += '\\[';
        i += 1;
        continue;
      }
      const body = pattern.slice(i + 1, close);
      source += `[${body.startsWith('!') ? `^${escapeClass(body.slice(1))}` : escapeClass(body)}]`;
      i = close + 1;
      continue;
    }

    if (ch === '{') {
      braces.push(source.length);
      source += '(?:';
      i += 1;
      continue;
    }
    if (ch === '}' && braces.length > 0) {
      braces.pop();
      source += ')';
      i += 1;
      continue;
    }
    if (ch === ',' && braces.length > 0) {
      source += '|';
      i += 1;
      continue;
    }

    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

function escapeClass(body: string): string {
  return body.replace(/[\\^\]]/g, '\\$&');
}

export interface GlobMatcher {
  (path: string): boolean;
}

/**
 * Builds a matcher from include patterns, honouring `!` negations.
 *
 * Later patterns win, so `docs/**\/*.md` followed by `!docs/drafts/**` reads the
 * way a `.gitignore` does.
 */
export function createGlobMatcher(patterns: readonly string[]): GlobMatcher {
  const compiled = patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    const normalised = normalisePosix(toPosix(body));
    // A bare directory means everything under it.
    const expanded = isGlob(normalised) ? normalised : `${normalised}/**`;
    return {
      negated,
      exact: isGlob(normalised) ? null : normalised.toLowerCase(),
      expression: globToRegExp(expanded),
      direct: globToRegExp(normalised),
    };
  });

  return (path: string): boolean => {
    let included = false;
    for (const entry of compiled) {
      const hit =
        entry.direct.test(path) ||
        entry.expression.test(path) ||
        (entry.exact !== null && entry.exact === path.toLowerCase());
      if (hit) included = !entry.negated;
    }
    return included;
  };
}

/**
 * Builds a predicate over reference *targets*, not paths.
 *
 * Separate from {@link createGlobMatcher} on purpose. That one is
 * path-oriented: it expands a bare name to `name/**` because a directory means
 * everything under it. A reference target has no such structure - `trap 55` is
 * a name, not a location - so a bare pattern must match it literally and
 * nothing else.
 *
 * Matching is case-insensitive on every platform. Path matching inherits the
 * host filesystem's case rules, which is right for paths and wrong here: a
 * repository's findings must not depend on which machine ran the check.
 */
export function createReferenceFilter(patterns: readonly string[]): (target: string) => boolean {
  if (patterns.length === 0) return () => false;
  const compiled = patterns
    .filter((pattern) => pattern.trim().length > 0)
    .map((pattern) => globToRegExp(pattern.trim().toLowerCase()));
  if (compiled.length === 0) return () => false;
  return (target: string): boolean => {
    const value = target.trim().toLowerCase();
    return compiled.some((expression) => expression.test(value));
  };
}

/** The literal directory prefix of a pattern, used to avoid walking the world. */
export function globBase(pattern: string): string {
  const normalised = normalisePosix(toPosix(pattern.startsWith('!') ? pattern.slice(1) : pattern));
  const segments = normalised.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (isGlob(segment)) break;
    literal.push(segment);
  }
  // The last literal segment may be the file itself rather than a directory.
  if (literal.length === segments.length && literal.length > 0) literal.pop();
  return literal.join('/');
}

/**
 * Walks the tree and returns every file matching the patterns.
 *
 * Directories are pruned as early as possible: a repository with a 2 GB
 * `node_modules` should cost nothing to scan.
 */
export async function walkFiles(options: WalkOptions): Promise<WalkedFile[]> {
  const root = toPosix(options.root).replace(/\/+$/, '');
  const matcher = createGlobMatcher(options.patterns);
  const maxSize = options.maxFileSize ?? MAX_FILE_SIZE;

  // Ignores come in two shapes and both are documented. A bare name prunes any
  // directory called that, at any depth, the way a `.gitignore` line does.
  // Anything carrying a separator or glob syntax is matched against the
  // repository-relative path, which is what `--ignore "docs/drafts/**"` means -
  // and treating that as a directory name silently excluded nothing at all.
  const ignores = options.ignore ?? [];
  const ignoredNames = new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...ignores.filter((pattern) => !isGlob(pattern) && !pattern.includes('/')),
  ]);
  const pathIgnores = ignores.filter((pattern) => isGlob(pattern) || pattern.includes('/'));
  const ignoreMatcher = pathIgnores.length > 0 ? createGlobMatcher(pathIgnores) : null;
  const excluded = (path: string): boolean => ignoreMatcher !== null && ignoreMatcher(path);

  // Only walk the directories the patterns can possibly reach.
  const bases = new Set<string>();
  for (const pattern of options.patterns) {
    if (pattern.startsWith('!')) continue;
    bases.add(globBase(pattern));
  }
  if (bases.size === 0) bases.add('');
  // Drop any base already contained in another: walking it again would only
  // repeat work. The empty base is the repository root, which contains
  // everything, so when it is present it is the only root worth walking.
  const roots = bases.has('')
    ? ['']
    : [...bases].filter((base) => ![...bases].some((other) => other !== base && base.startsWith(`${other}/`)));

  const out = new Map<string, WalkedFile>();
  const visited = new Set<string>();

  const walk = async (relative: string): Promise<void> => {
    const absolute = relative.length === 0 ? root : `${root}/${relative}`;
    if (visited.has(absolute)) return;
    visited.add(absolute);

    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      // An unreadable directory is not a reason to fail the whole run.
      return;
    }

    for (const entry of entries) {
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        // Pruning a whole subtree is an optimisation; a pattern that only
        // matches the files inside it is still honoured when they are filtered.
        if (ignoredNames.has(entry.name) || excluded(child)) continue;
        await walk(child);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const info = await stat(`${root}/${child}`);
          if (info.isDirectory()) {
            await walk(child);
            continue;
          }
          if (!matcher(child) || excluded(child) || info.size > maxSize) continue;
          out.set(child, { path: child, absolute: `${root}/${child}`, size: info.size });
        } catch {
          continue;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!matcher(child) || excluded(child)) continue;

      try {
        const info = await stat(`${root}/${child}`);
        if (info.size > maxSize) continue;
        out.set(child, { path: child, absolute: `${root}/${child}`, size: info.size });
      } catch {
        continue;
      }
    }
  };

  for (const base of roots) await walk(base);

  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Resolves a repository-relative path against the root, in POSIX form. */
export function underRoot(root: string, relative: string): string {
  return joinPosix(toPosix(root), relative);
}
