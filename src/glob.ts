/**
 * Pattern matching and directory walking.
 *
 * The patterns are the `path` dialect every spec-* tool reads, from spec-core:
 * `**`, `*`, `?`, `{a,b}`, `[abc]` and `[!a-z]`, matched against whole
 * repository-relative POSIX paths by an automaton that cannot backtrack, with
 * case respected on every host (ADR-0022). What stays here is spec-graph's own:
 * how a list with `!` entries in it reads, which directories a walk never
 * enters, and how a reference target - which is not a path - is matched.
 */

import { readdir, stat } from 'node:fs/promises';

import { isAbsolutePath, joinPosix, toPosix } from './paths.js';
import {
  compileGlob as compileFamilyGlob,
  GlobError,
  isGlobSyntax,
  parseGlob,
  parseGlobList,
  type Glob,
  type GlobList,
  type GlobOptions as FamilyGlobOptions,
  type RegexMatcher,
} from './vendor/spec-core/pattern/index.js';

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

/**
 * How a path pattern is read everywhere in spec-graph.
 *
 * A literal names a file or a directory and everything beneath it, which is
 * what `--ignore docs/drafts` has always meant. A `\` is a separator, because a
 * pattern typed on a Windows shell arrives with them and spec-graph has always
 * read them that way; it cannot also be an escape.
 */
const PATH: FamilyGlobOptions = { dialect: 'path', caseSensitive: true, literal: 'either', backslash: 'separator' };

/** True when the string contains glob syntax rather than being a literal path. */
export function isGlob(pattern: string): boolean {
  return isGlobSyntax(pattern);
}

/**
 * Compiles a glob to an anchored regular expression, in the dialect spec-graph
 * read before it adopted spec-core's.
 *
 * @deprecated Nothing matches with this. It stays for callers who want a
 * `RegExp`, and as the record of the old reading that `tests/glob.test.ts`
 * holds every difference against, each one named in ADR-0022. It no longer
 * folds case on Windows alone: an answer must not depend on the host.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`);
}

export interface GlobOptions {
  /** Fold case. Off unless asked for, on every host. */
  readonly ignoreCase?: boolean | undefined;
}

/**
 * Compiles one glob to a matcher over whole repository-relative paths.
 *
 * A pattern with no glob syntax names that path and nothing beneath it; a bare
 * directory meaning its contents is a reading of {@link createGlobMatcher}'s.
 * Throws a `GlobError` that names the glob as it was written.
 *
 * Matching is linear in the path whatever the pattern. It was not always: a
 * glob's stars are not nested, but each is a `[^/]*` to `RegExp`, and a subject
 * that fails is divided between them every way there is - `*-*-*-x` took two
 * minutes over a 10,000-character reference target (ADR-0017).
 */
export function compileGlob(pattern: string, options: GlobOptions = {}): RegexMatcher {
  const glob = compileFamilyGlob(pattern, { ...PATH, literal: 'file', caseSensitive: options.ignoreCase !== true });
  return { test: (path) => glob.match(path), size: glob.automaton.kinds.length };
}

/** The expression a glob stood for before 0.9.0, before anchors and flags. */
function globSource(pattern: string): string {
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

  // Otherwise reported as an unmatched parenthesis, in a glob that has none.
  if (braces.length > 0) throw new Error(`invalid glob "${pattern}": unclosed "{"`);
  return source;
}

function escapeClass(body: string): string {
  return body.replace(/[\\^\]]/g, '\\$&');
}

export interface GlobMatcher {
  (path: string): boolean;
}

/** Compiles a list of path patterns, or throws naming the one that is not a glob. */
function pathList(patterns: readonly string[]): GlobList {
  const parsed = parseGlobList(patterns, PATH);
  if (!parsed.ok) throw new Error(`invalid glob ${parsed.error}`);
  return parsed.list;
}

/**
 * Builds a matcher from include patterns, honouring `!` negations.
 *
 * Later patterns win, so `docs/**\/*.md` followed by `!docs/drafts/**` reads the
 * way a `.gitignore` does. A pattern with no glob syntax in it names a file, or
 * a directory and everything beneath it; `docs/` names only what is beneath.
 */
export function createGlobMatcher(patterns: readonly string[]): GlobMatcher {
  const list = pathList(patterns);
  return (path: string): boolean => list.match(path);
}

/**
 * Builds a predicate over reference *targets*, not paths.
 *
 * Separate from {@link createGlobMatcher} on purpose. That one is
 * path-oriented: a bare name there is a directory and everything under it. A
 * reference target has no such structure - `trap 55` is a name, not a location
 * - so a bare pattern matches it literally and nothing else.
 *
 * Case is ignored, on every platform, because a citation's spelling is the
 * author's and not the filesystem's. The fold is simple case mapping, one code
 * point at a time and without a locale, so every host gives the same answer:
 * U+00B5 (micro sign) and U+03BC (mu) stay two targets, as they have been since
 * a Windows-only `i` flag made them one there (ADR-0017).
 *
 * A target is text a document holds rather than a path on this host, and two
 * things follow. A `\` escapes the character after it: there is no Windows
 * separator to allow for. And a `.` or `..` segment is text: in a path the
 * dialect drops the one and refuses the other as climbing out of the root, but
 * `../../notes/gone.md` is a link somebody wrote and may want left alone.
 */
export function createReferenceFilter(patterns: readonly string[]): (target: string) => boolean {
  const globs: Glob[] = patterns
    .filter((pattern) => pattern.trim().length > 0)
    .map((pattern) => {
      const literalDots = pattern
        .trim()
        .split('/')
        .map((segment) => (segment === '.' ? '\\.' : segment === '..' ? '\\.\\.' : segment))
        .join('/');
      const parsed = parseGlob(literalDots, { dialect: 'path', caseSensitive: false, literal: 'file' });
      if (!parsed.ok) throw new GlobError(pattern, parsed.error);
      return parsed.glob;
    });
  if (globs.length === 0) return () => false;
  return (target: string): boolean => {
    const value = target.trim();
    return globs.some((glob) => glob.match(value));
  };
}

/**
 * The literal directory a pattern's matches all sit under, or `''` for the root.
 *
 * `{docs,specs}/**` has two, and this is the directory they share; the walk
 * itself starts at each.
 */
export function globBase(pattern: string): string {
  const { glob } = pathList([pattern]).entries[0] as { readonly glob: Glob };
  const bases = glob.bases.map((base) => base.split('/'));
  const shared = bases[0] as string[];
  let length = shared.length;
  for (const base of bases) {
    let same = 0;
    while (same < length && base[same] === shared[same]) same += 1;
    length = same;
  }
  return shared.slice(0, length).join('/');
}

/**
 * Whether a base names directories that exist with exactly that spelling.
 *
 * A walk starts where a pattern's literal prefix points rather than at the
 * root, and on a filesystem that ignores case, `readdir('Docs')` lists `docs`.
 * Every file under it would come back spelled `Docs/...` - a node id, a
 * baseline key - and `Docs/**` would find it on Windows and macOS and nothing
 * on Linux. Asking each parent for the name gives git's answer on every host. A
 * base with an empty segment is rooted at `/`, which is never inside the root.
 */
async function spelledAsOnDisk(root: string, base: string): Promise<boolean> {
  if (base.length === 0) return true;
  let directory = root;
  for (const segment of base.split('/')) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    directory = `${directory}/${segment}`;
  }
  return true;
}

/**
 * Walks the tree and returns every file matching the patterns.
 *
 * Directories are pruned as early as possible: a repository with a 2 GB
 * `node_modules` should cost nothing to scan.
 */
export async function walkFiles(options: WalkOptions): Promise<WalkedFile[]> {
  const root = toPosix(options.root).replace(/\/+$/, '');
  const patterns = pathList(options.patterns);
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
  const ignoreList = pathIgnores.length > 0 ? pathList(pathIgnores) : null;
  const excluded = (path: string): boolean => ignoreList !== null && ignoreList.match(path);

  // Only walk the directories the patterns can possibly reach: each pattern's
  // literal prefix, one per brace alternative.
  const bases = new Set<string>();
  for (const entry of patterns.entries) {
    if (entry.negated) continue;
    for (const base of entry.glob.bases) bases.add(base);
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
          if (!patterns.match(child) || excluded(child) || info.size > maxSize) continue;
          out.set(child, { path: child, absolute: `${root}/${child}`, size: info.size });
        } catch {
          continue;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!patterns.match(child) || excluded(child)) continue;

      try {
        const info = await stat(`${root}/${child}`);
        if (info.size > maxSize) continue;
        out.set(child, { path: child, absolute: `${root}/${child}`, size: info.size });
      } catch {
        continue;
      }
    }
  };

  for (const base of roots) if (await spelledAsOnDisk(root, base)) await walk(base);

  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Resolves a repository-relative path against the root, in POSIX form.
 *
 * An absolute path already names one place, and joining it under the root names
 * another: `--baseline /tmp/b.json` read `<root>/tmp/b.json`, found nothing
 * there, and accepted nothing without saying so.
 */
export function underRoot(root: string, relative: string): string {
  if (isAbsolutePath(relative)) return toPosix(relative);
  return joinPosix(toPosix(root), relative);
}
