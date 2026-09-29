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

import type { Dirent } from 'node:fs';
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
  // `literal: 'file'` is the dialect's reading of any value but `directory`
  // and `either`, so a mutant that blanks it reads the same. It is spelled out
  // because what an unknown value means is spec-core's to change.
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
  // A blank pattern reaches the dialect, which refuses it, as every pattern
  // spec-graph reads is refused when it names nothing. It used to be dropped,
  // so an unset variable in `--ignore-ref "$TAGS"` went unnoticed.
  const globs: Glob[] = patterns.map((pattern) => {
    const literalDots = pattern
      .trim()
      .split('/')
      .map((segment) => (segment === '.' ? '\\.' : segment === '..' ? '\\.\\.' : segment))
      .join('/');
    // Every option spelled out, though the dialect reads `{}` the same way
    // today: its defaults are spec-core's to change, and this reading is
    // spec-graph's to keep. A mutant that drops one is equivalent until then.
    const parsed = parseGlob(literalDots, { dialect: 'path', caseSensitive: false, literal: 'file' });
    if (!parsed.ok) throw new GlobError(pattern, parsed.error);
    return parsed.glob;
  });
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
    // `<=` would read one past the end, where both sides are undefined and
    // equal, and slice the same prefix: an equivalent mutant, left untested.
    while (same < length && base[same] === shared[same]) same += 1;
    length = same;
  }
  return shared.slice(0, length).join('/');
}

/**
 * Whether a base names directories the walk from the root would reach, each
 * with exactly that spelling and none a link it would not follow.
 *
 * A walk starts where a pattern's literal prefix points rather than at the
 * root, and on a filesystem that ignores case, `readdir('Docs')` lists `docs`.
 * Every file under it would come back spelled `Docs/...` - a node id, a
 * baseline key - and `Docs/**` would find it on Windows and macOS and nothing
 * on Linux. Asking each parent for the name gives git's answer on every host. A
 * base with an empty segment is rooted at `/`, which is never inside the root.
 *
 * Reading a directory by its path follows every link in the path, so
 * `docs/linked/*.md` was read through the link `docs/linked`, which the walk
 * from the root passes over. Asking each parent for the entry says which it
 * is, and a base beyond a link is left as silently as the walk leaves the link.
 */
async function reachable(root: string, base: string, followSymlinks: boolean | undefined): Promise<boolean> {
  if (base.length === 0) return true;
  let directory = root;
  for (const segment of base.split('/')) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Answering `true` here would change nothing a test can see: the walk
      // would then read a directory beneath this one, fail the same way, and
      // find nothing.
      return false;
    }
    const entry = entries.find((candidate) => candidate.name === segment);
    if (entry === undefined || (entry.isSymbolicLink() && !followSymlinks)) return false;
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
  // A mutant that defaults this to `['Stryker was here']` prunes directories of
  // that name, which no repository has: equivalent, and left untested.
  const ignores = options.ignore ?? [];
  // The empty pattern is no directory's name, so it goes to the dialect, which
  // refuses it as it refuses an empty include: a pattern that names nothing is
  // a typo or an unset variable, and was an ignore that ignored nothing.
  const bare = (pattern: string): boolean => pattern.length > 0 && !isGlob(pattern) && !pattern.includes('/');
  const named = new Set(ignores.filter(bare));
  const skippedByDefault = new Set(DEFAULT_IGNORED_DIRECTORIES);
  const ignoreList = pathList(ignores.filter((pattern) => !bare(pattern)));
  const excluded = (path: string): boolean => ignoreList.match(path);

  // Only walk the directories the patterns can possibly reach: each pattern's
  // literal prefix, one per brace alternative. A negated pattern adds none: it
  // takes files back, and starting a walk at its prefix would enter what the
  // walk skips - `!node_modules/**/*.txt` beside `**/*.md` would read every
  // Markdown file in `node_modules`. No positive pattern at all walks nothing,
  // which is the answer.
  const bases = new Set<string>();
  // The paths a positive pattern names outright: `docs/vendor`, or each literal
  // a brace expands to. Such a name may be a file, so its walk starts in the
  // directory above, which pruned `vendor` on its way in: `docs/vendor` found
  // nothing where `docs/vendor/` read the directory. The default list gives way
  // to the directory a pattern names as it gives way to one a pattern starts
  // inside. A negated name adds none, for the reason it adds no base.
  const literals = new Set<string>();
  for (const entry of patterns.entries) {
    if (entry.negated) continue;
    for (const base of entry.glob.bases) bases.add(base);
    // The dialect is what knows a literal when it reads one, so each pattern
    // is compiled a second time to be told of them. That glob is thrown away:
    // the reading answered here decides nothing, and a mutant that changes it
    // is equivalent.
    parseGlob(entry.glob.source, {
      ...PATH,
      literal: (path) => {
        literals.add(path);
        return 'either';
      },
    });
  }
  // Every base is walked, even one inside another, because the outer walk
  // prunes `vendor` and the rest of the default list on its way down, and a
  // pattern that starts inside one of those is read from there. Dropping the
  // inner base as already covered meant `docs/**/*.md` beside
  // `docs/vendor/specs/*.md` found less than the second pattern alone. An
  // `--ignore` is not overruled that way: it is the user's. A walk that starts
  // at a base never passed through the directories above it, so each of them,
  // and the base, is asked what the walk from the root would have asked on its
  // way down. A bare name prunes at any depth - `--ignore adr` still takes out
  // `adr/`, which the default `adr/**/*.md` starts inside - and a path takes
  // out what it matches, so under `--ignore "docs/*"` `docs/drafts/**/*.md`
  // finds what `docs/**/*.md` finds, which is nothing there. The root is not
  // asked, as the walk from it never asks: `*` matches the empty path, and
  // `**/*.md` under `--ignore "*" --ignore "!{docs,specs}"` would read nothing
  // where it reads those two.
  const startable = (base: string): boolean => {
    if (base.length === 0) return true;
    const segments = base.split('/');
    return !segments.some((segment, i) => named.has(segment) || excluded(segments.slice(0, i + 1).join('/')));
  };
  const out = new Map<string, WalkedFile>();
  // Where two walks overlap, whichever reaches a directory first reads it and
  // the other stops there. Reading it twice would find the same files under
  // the same keys, so the two mutants that drop this are equivalent.
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
        // A bare `--ignore` name prunes a directory a pattern names as well:
        // only the default list gives way.
        if (named.has(entry.name) || (skippedByDefault.has(entry.name) && !literals.has(child)) || excluded(child)) continue;
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
          // A link to nothing has nothing to read.
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
        // Gone between the listing and the look: there is nothing to read.
      }
    }
  };

  for (const base of bases) if (startable(base) && (await reachable(root, base, options.followSymlinks))) await walk(base);

  // No two paths are equal, since they are the keys of `out`, so the order
  // needs only `<`, and `<=` would read the same.
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
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
