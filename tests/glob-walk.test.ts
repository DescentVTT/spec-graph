import { mkdir, rm, writeFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkFiles } from '../src/glob.js';

/**
 * What a walk reads, held to the README's account of it.
 *
 * The README lists the directories a walk never enters and says a pattern that
 * starts inside one is read from there. Everything else here is a decision the
 * walk makes about the tree in front of it: which entries are files, where a
 * link leads, how big is too big, and what order the answer comes back in.
 */

// Named for the process: Stryker runs this file in several workers at once, in
// one sandbox (ADR-0007).
const ROOT = `tests/fixtures/.tmp/glob-walk-${process.pid}`;

const paths = async (root: string, patterns: string[], ignore?: string[]): Promise<string[]> =>
  (await walkFiles({ root, patterns, ignore })).map((file) => file.path);

async function write(path: string, text: string): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, text);
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('a pattern that starts inside a skipped directory', () => {
  beforeAll(async () => {
    await write(`${ROOT}/nested/docs/a.md`, '# A\n');
    await write(`${ROOT}/nested/docs/vendor/specs/b.md`, '# B\n');
    await write(`${ROOT}/nested/node_modules/pkg/c.md`, '# C\n');
  });

  it('finds as much beside a broader pattern as it finds alone', async () => {
    // The broader walk prunes `vendor` on its way down, and the narrower
    // pattern's own start was dropped as already covered by it: adding a
    // pattern took a file away.
    const root = `${ROOT}/nested`;
    expect(await paths(root, ['docs/vendor/specs/*.md'])).toEqual(['docs/vendor/specs/b.md']);
    expect(await paths(root, ['docs/**/*.md', 'docs/vendor/specs/*.md'])).toEqual(['docs/a.md', 'docs/vendor/specs/b.md']);
    expect(await paths(root, ['docs/vendor/specs/*.md', 'docs/**/*.md'])).toEqual(['docs/a.md', 'docs/vendor/specs/b.md']);
    expect(await paths(root, ['**/*.md', 'docs/vendor/specs/*.md'])).toEqual(['docs/a.md', 'docs/vendor/specs/b.md']);
  });

  it('is never started by a negated pattern, which only takes files back', async () => {
    expect(await paths(`${ROOT}/nested`, ['**/*.md', '!node_modules/**/*.txt'])).toEqual(['docs/a.md']);
  });
});

describe('a bare --ignore name', () => {
  beforeAll(async () => {
    await write(`${ROOT}/named/docs/a.md`, '# A\n');
    await write(`${ROOT}/named/docs/drafts/keep/b.md`, '# B\n');
    await write(`${ROOT}/named/adr/0001.md`, '# One\n');
    await write(`${ROOT}/named/README.md`, '# Root\n');
  });

  it('prunes at any depth, where a pattern starts inside it as much as on the way down', async () => {
    // Unlike the default list, the user's own word is not overruled by a
    // pattern: it used to be, for a pattern whose walk started inside it,
    // unless another pattern's walk passed through first and pruned it there.
    const root = `${ROOT}/named`;
    expect(await paths(root, ['docs/drafts/keep/*.md'], ['drafts'])).toEqual([]);
    expect(await paths(root, ['docs/drafts/keep/*.md'], ['keep'])).toEqual([]);
    expect(await paths(root, ['docs/**/*.md', 'docs/drafts/keep/*.md'], ['drafts'])).toEqual(['docs/a.md']);
    // The default patterns start one walk inside `adr` and one at the root.
    expect(await paths(root, ['adr/**/*.md', '*.md'], ['adr'])).toEqual(['README.md']);
    expect(await paths(root, ['adr/**/*.md', '*.md'])).toEqual(['README.md', 'adr/0001.md']);
  });
});
