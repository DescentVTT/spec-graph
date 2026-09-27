import { existsSync, type PathLike } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { analyse } from '../src/runner.js';

/**
 * The run against a filesystem less obliging than the one under the test:
 * reads that finish out of order, and a disk that tells `Notes.md` from
 * `notes.md`.
 *
 * Both are ordinary conditions on a hosted Linux runner, and neither is
 * reliably this machine's - a handful of small reads usually finishes in the
 * order it started, and a Windows or macOS disk answers for either spelling.
 * So the two calls that meet them are put under the test's control here, in a
 * file of their own, and every other call reaches the real filesystem.
 */

interface Order {
  /** The read that, once done, waits for the other. */
  readonly first: string;
  readonly second: string;
  started: boolean;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

const disk = vi.hoisted(() => ({
  // Named for the process: Stryker runs a test file in several workers at
  // once, in one sandbox, and a fixed path is one they write and delete under
  // each other.
  root: `tests/fixtures/.tmp/runner-filesystem-${process.pid}`,
  order: null as Order | null,
  caseSensitive: false,
}));

const posix = (path: PathLike): string => String(path).replace(/\\/g, '/');

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = async (...args: Parameters<typeof real.readFile>): Promise<string | Buffer> => {
    const path = posix(args[0] as PathLike);
    const order = disk.order;
    if (order !== null && path.endsWith(order.second)) order.started = true;
    const text = await real.readFile(...args);
    // Only a read already under way is waited for, so a run that reads one
    // file at a time is never stalled on a read it has not begun.
    if (order !== null && path.endsWith(order.first) && order.started) await order.done;
    if (order !== null && path.endsWith(order.second)) order.finish();
    return text;
  };
  return { ...real, readFile };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const existsSync = (path: PathLike): boolean => {
    const wanted = posix(path);
    if (!disk.caseSensitive || !wanted.startsWith(`${disk.root}/`)) return real.existsSync(path);
    // As a case-sensitive disk answers: every segment below the root spelled
    // exactly as the directory holding it spells it.
    let directory = disk.root;
    for (const segment of wanted.slice(disk.root.length + 1).split('/')) {
      if (!real.readdirSync(directory).includes(segment)) return false;
      directory = `${directory}/${segment}`;
    }
    return true;
  };
  return { ...real, existsSync };
});

const ROOT = disk.root;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(`${ROOT}/docs`, { recursive: true });
  await mkdir(`${ROOT}/skipped`, { recursive: true });
  await writeFile(`${ROOT}/docs/0001-first.md`, '# ADR-0001: First\n\nSee [the notes](../skipped/Notes.md).\n');
  await writeFile(`${ROOT}/docs/0002-second.md`, '# ADR-0002: Second\n\nSee [the plan](../skipped/plan.md).\n');
  await writeFile(`${ROOT}/skipped/notes.md`, '<!-- @spec-ignore -->\n\n# Notes\n');
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  disk.order = null;
  disk.caseSensitive = false;
});

describe('reads that finish out of order', () => {
  it('still give the corpus in path order', async () => {
    // Document order decides which of two documents claiming one id wins, so
    // it is part of the result. Here the second file's read finishes first,
    // every time, and the corpus must not notice.
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    disk.order = { first: '0001-first.md', second: '0002-second.md', started: false, done, finish };
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'], concurrency: 2 });
    expect(result.corpus.documents.map((document) => document.path)).toEqual(['docs/0001-first.md', 'docs/0002-second.md']);
  });
});

describe('a disk that tells two spellings apart', () => {
  it('is what this file runs on', () => {
    disk.caseSensitive = true;
    expect(existsSync(`${ROOT}/skipped/notes.md`)).toBe(true);
    expect(existsSync(`${ROOT}/skipped/Notes.md`)).toBe(false);
  });

  it('still finds a file the walk saw, named in another case, as present', async () => {
    // Resolution matches a link to a document without regard to case, so a
    // link to a file the walk found - one that opted out, and so is no
    // document - is read the same way: a file that is there and is not a
    // specification, rather than a link to nothing. A plan on no disk at all is
    // still broken.
    disk.caseSensitive = true;
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md', 'skipped/**/*.md'] });
    const found = result.diagnostics.map((finding) => `${finding.rule} ${finding.target}`);
    expect(found).toContain('reference-outside-corpus ../skipped/Notes.md');
    expect(found).toContain('broken-reference ../skipped/plan.md');
    expect(found).not.toContain('broken-reference ../skipped/Notes.md');
  });
});
