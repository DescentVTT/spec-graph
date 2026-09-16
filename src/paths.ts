/**
 * POSIX path arithmetic, independent of the host platform.
 *
 * Every path inside spec-graph is a repository-relative POSIX path, on Windows
 * as much as on Linux. Node's `path` module would happily produce
 * `docs\adr\0007.md` on one machine and `docs/adr/0007.md` on another, and a
 * graph whose node identities depend on which laptop built it is not a graph.
 */

/** Converts a host path to POSIX form. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

const ABSOLUTE = /^(?:[/\\]|[A-Za-z]:)/;

/**
 * Whether a path names a place outright rather than a place relative to one.
 *
 * Both platforms' spellings, whichever this is running on: one repository is
 * read on a Windows checkout and in Linux CI, so a path is absolute where it
 * was written rather than where it is being read. `C:docs` counts, because it
 * is relative to a drive rather than to a root, and prefixing it with a root
 * produces a third place that is neither.
 */
export function isAbsolutePath(value: string): boolean {
  return ABSOLUTE.test(value);
}

/** Removes `.` and `..` segments. Leading `..` are preserved. */
export function normalisePosix(value: string): string {
  const absolute = value.startsWith('/');
  const out: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/** The directory containing `value`, or `''` at the root. */
export function dirnamePosix(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash === -1 ? '' : value.slice(0, slash);
}

/** The final segment of `value`. */
export function basenamePosix(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

/** Joins segments and normalises the result. */
export function joinPosix(...segments: readonly string[]): string {
  return normalisePosix(segments.filter((segment) => segment.length > 0).join('/'));
}

/** Resolves `target` against the directory holding `from`. */
export function resolveFrom(from: string, target: string): string {
  if (target.startsWith('/')) return normalisePosix(target);
  return joinPosix(dirnamePosix(from), target);
}

/** The extension including the dot, lower-cased, or `''`. */
export function extnamePosix(value: string): string {
  const base = basenamePosix(value);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}
