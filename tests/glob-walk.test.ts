import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_IGNORED_DIRECTORIES, walkFiles } from '../src/glob.js';

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

/** The backticked names of the README sentence that lists what a walk skips. */
function documentedSkips(): string[] {
  const readme = readFileSync('README.md', 'utf8');
  const at = readme.indexOf('The walk never enters');
  if (at === -1) throw new Error('the README does not list the directories a walk skips');
  const sentence = readme.slice(at, readme.indexOf('on its way', at));
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

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

describe('the directories a walk skips', () => {
  const root = `${ROOT}/skips`;

  beforeAll(async () => {
    await write(`${root}/docs/kept.md`, '# Kept\n');
    for (const name of documentedSkips()) {
      await write(`${root}/${name}/a.md`, '# Skipped\n');
      await write(`${root}/docs/${name}/b.md`, '# Skipped\n');
    }
  });

  it('are the ones the README lists, and the README lists every one', () => {
    const listed = documentedSkips();
    // A sentence that failed to parse would pass the check below vacuously.
    expect(listed.length).toBeGreaterThan(15);
    expect([...listed].sort()).toEqual([...DEFAULT_IGNORED_DIRECTORIES].sort());
  });

  it('are never entered on the way to what the patterns name, at any depth', async () => {
    expect(await paths(root, ['**/*.md'])).toEqual(['docs/kept.md']);
  });

  it('are read from inside by a pattern that starts there, whatever the other patterns reach', async () => {
    const names = documentedSkips();
    const found = await paths(root, ['**/*.md', ...names.map((name) => `${name}/*.md`)]);
    expect(found).toEqual(['docs/kept.md', ...names.map((name) => `${name}/a.md`)].sort());
  });
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

describe('a brace alternative that ends in /', () => {
  const root = `${ROOT}/braces`;

  beforeAll(async () => {
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${root}/docs/vendor/specs/b.md`, '# B\n');
    await write(`${root}/notes`, '# Notes\n');
  });

  it('is read from inside, as the same directory written alone is, and names no file of its name', async () => {
    // The slash inside braces was dropped, so `docs/{vendor/,x}` held the
    // literal `docs/vendor`, a file or a directory: its walk started at `docs`
    // and pruned `vendor` there, and `{notes/,docs/*.md}` read a file called
    // `notes` (spec-core f9ce375).
    expect(await paths(root, ['docs/vendor/'])).toEqual(['docs/vendor/specs/b.md']);
    expect(await paths(root, ['docs/{vendor/,x}'])).toEqual(['docs/vendor/specs/b.md']);
    expect(await paths(root, ['{notes/,docs/*.md}'])).toEqual(['docs/a.md']);
    expect(await paths(root, ['{notes,docs/*.md}'])).toEqual(['docs/a.md', 'notes']);
  });

  it('is what an ignore takes out, and a file of its name is not', async () => {
    const patterns = ['docs/**/*.md', 'docs/vendor/specs/*.md', 'notes'];
    expect(await paths(root, patterns)).toEqual(['docs/a.md', 'docs/vendor/specs/b.md', 'notes']);
    expect(await paths(root, patterns, ['{notes/,docs/vendor/}'])).toEqual(['docs/a.md', 'notes']);
  });
});

describe('a plain name for a directory the walk skips', () => {
  const root = `${ROOT}/plain`;
  const vendored = ['docs/vendor/specs/s.md', 'docs/vendor/v.md'];

  beforeAll(async () => {
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${root}/docs/drafts/d.md`, '# D\n');
    await write(`${root}/docs/vendor/v.md`, '# V\n');
    await write(`${root}/docs/vendor/specs/s.md`, '# S\n');
    await write(`${root}/docs/vendor/node_modules/n.md`, '# N\n');
    await write(`${root}/vendor/r.md`, '# R\n');
    await write(`${root}/vendor/dist/built.md`, '# Built\n');
    await write(`${root}/notes/vendor`, 'a file called vendor\n');
  });

  it('reads that directory, as the same name ending in / does', async () => {
    // A plain name may be a file, so its walk starts in the directory above,
    // and that walk pruned `vendor` on its way in: `docs/vendor` and `vendor`
    // found nothing, while `docs/vendor/` read the directory.
    expect(await paths(root, ['docs/vendor/'])).toEqual(vendored);
    expect(await paths(root, ['docs/vendor'])).toEqual(vendored);
    expect(await paths(root, ['vendor/'])).toEqual(['vendor/r.md']);
    expect(await paths(root, ['vendor'])).toEqual(['vendor/r.md']);
    expect(await paths(root, ['docs/{vendor,drafts}'])).toEqual(['docs/drafts/d.md', ...vendored]);
  });

  it('reads one skipped directory named inside another', async () => {
    expect(await paths(root, ['vendor/dist'])).toEqual(['vendor/dist/built.md']);
    expect(await paths(root, ['docs/vendor/node_modules'])).toEqual(['docs/vendor/node_modules/n.md']);
  });

  it('reads a file of that name as the file, and nothing beside it', async () => {
    expect(await paths(root, ['notes/vendor'])).toEqual(['notes/vendor']);
    expect(await paths(root, ['{notes,docs}/vendor'])).toEqual([...vendored, 'notes/vendor']);
  });

  it('gives way for the directory named and no other, whatever the other patterns reach', async () => {
    // The skip list still holds for every directory a pattern does not name:
    // another `vendor`, one inside the named directory, and all of them for a
    // negated name, which takes files back and names nothing to read.
    const elsewhere = ['docs/a.md', 'docs/drafts/d.md'];
    expect(await paths(root, ['**/*.md', 'docs/vendor'])).toEqual([...elsewhere, ...vendored]);
    expect(await paths(root, ['**/*.md', 'vendor'])).toEqual([...elsewhere, 'vendor/r.md']);
    expect(await paths(root, ['!vendor', '**/*.md'])).toEqual(elsewhere);
    expect(await paths(root, ['!docs/vendor', '**/*.md'])).toEqual(elsewhere);
  });

  it("is pruned by an --ignore all the same, which is the user's", async () => {
    expect(await paths(root, ['docs/vendor', 'vendor/dist'])).toEqual([...vendored, 'vendor/dist/built.md']);
    expect(await paths(root, ['docs/vendor', 'vendor/dist'], ['vendor'])).toEqual([]);
    expect(await paths(root, ['docs/vendor', 'vendor/dist'], ['dist'])).toEqual(vendored);
    expect(await paths(root, ['docs/vendor', 'vendor/dist'], ['specs'])).toEqual(['docs/vendor/v.md', 'vendor/dist/built.md']);
    expect(await paths(root, ['docs/vendor', 'docs/drafts'], ['drafts'])).toEqual(vendored);
    // A path takes the directory out as it takes it out of a walk that passes
    // through: the plain name is read from `docs`, where `docs/*` prunes it.
    expect(await paths(root, ['docs/vendor'], ['docs/*'])).toEqual([]);
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

describe('the answer', () => {
  beforeAll(async () => {
    await write(`${ROOT}/order/specs/rfcs/0004.md`, '# Four\n');
    await write(`${ROOT}/order/docs/adr/0001.md`, '# One\n');
    await write(`${ROOT}/order/docs/adr/0002.md`, '# Two\n');
  });

  it('comes back sorted by path, not in the order the patterns were walked', async () => {
    expect(await paths(`${ROOT}/order`, ['specs/**/*.md', 'docs/**/*.md'])).toEqual([
      'docs/adr/0001.md',
      'docs/adr/0002.md',
      'specs/rfcs/0004.md',
    ]);
  });

  it('is the same for a root written with a trailing separator, and so is where each file is read from', async () => {
    for (const root of [`${ROOT}/order/`, `${ROOT}/order//`, `${ROOT}\\order\\`]) {
      const files = await walkFiles({ root, patterns: ['docs/**/*.md'] });
      expect(files.map((file) => [file.path, file.absolute]), root).toEqual([
        ['docs/adr/0001.md', `${ROOT}/order/docs/adr/0001.md`],
        ['docs/adr/0002.md', `${ROOT}/order/docs/adr/0002.md`],
      ]);
    }
  });

  it('keeps a file exactly as large as the limit, which it is not larger than', async () => {
    const size = '# One\n'.length;
    const read = async (maxFileSize: number) =>
      (await walkFiles({ root: `${ROOT}/order`, patterns: ['docs/adr/0001.md'], maxFileSize })).map((file) => file.size);
    expect(await read(size)).toEqual([size]);
    expect(await read(size - 1)).toEqual([]);
  });
});

describe('an ignore with glob syntax in it', () => {
  it('is a pattern over paths, even where a directory is spelled like one', async () => {
    // Next.js names route directories `[slug]`. As a pattern that is a class,
    // one of four letters at the root; the directory is `[[]slug]`.
    const root = `${ROOT}/routes`;
    await write(`${root}/app/[slug]/page.md`, '# Slug\n');
    await write(`${root}/app/about/page.md`, '# About\n');
    expect(await paths(root, ['**/*.md'], ['[slug]'])).toEqual(['app/[slug]/page.md', 'app/about/page.md']);
    expect(await paths(root, ['**/*.md'], ['app/[[]slug]'])).toEqual(['app/about/page.md']);
  });
});

describe('links', () => {
  // A directory link is made as a junction, which Windows allows without
  // privilege and every other host reads as an ordinary symbolic link.
  const root = `${ROOT}/links/tree`;
  const elsewhere = `${ROOT}/links/elsewhere`;

  beforeAll(async () => {
    await write(`${root}/docs/b.md`, '# B\n');
    await write(`${elsewhere}/c.md`, '# C\n');
    // No larger than the limit below, so only its name keeps it out.
    await write(`${elsewhere}/notes.txt`, 'txt\n');
    await write(`${elsewhere}/big.md`, '# A larger file\n');
    await symlink(resolve(elsewhere), `${root}/docs/shared`, 'junction');
  });

  const walk = (options: { followSymlinks?: boolean; maxFileSize?: number } = {}) =>
    walkFiles({ root, patterns: ['docs/**/*.md'], ...options });

  it('are not followed unless asked, since a link can lead back up the tree', async () => {
    expect((await walk()).map((file) => file.path)).toEqual(['docs/b.md']);
    expect((await walk({ followSymlinks: false })).map((file) => file.path)).toEqual(['docs/b.md']);
  });

  it('lead into the directory they name when followed, which is walked as if it were there', async () => {
    const files = await walk({ followSymlinks: true });
    expect(files.map((file) => file.path)).toEqual(['docs/b.md', 'docs/shared/big.md', 'docs/shared/c.md']);
  });

  it('to a file are read as that file when followed: matched, ignored and measured by the link', async (context) => {
    try {
      await symlink(resolve(`${elsewhere}/c.md`), `${root}/docs/c-link.md`, 'file');
      await symlink(resolve(`${elsewhere}/notes.txt`), `${root}/docs/notes-link.txt`, 'file');
      await symlink(resolve(`${elsewhere}/big.md`), `${root}/docs/big-link.md`, 'file');
      await symlink(resolve(`${elsewhere}/c.md`), `${root}/docs/skip-link.md`, 'file');
    } catch (error) {
      // Windows refuses a file link without Developer Mode or elevation. The
      // hosted runners that measure the mutation score are Linux.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw error;
    }
    const size = '# C\n'.length;
    const files = await walkFiles({
      root,
      patterns: ['docs/*.md'],
      ignore: ['docs/skip-*'],
      followSymlinks: true,
      maxFileSize: size,
    });
    expect(files.map((file) => [file.path, file.absolute, file.size])).toEqual([
      ['docs/b.md', `${root}/docs/b.md`, size],
      ['docs/c-link.md', `${root}/docs/c-link.md`, size],
    ]);
  });
});

describe('an entry that is neither a file nor a directory', () => {
  it('is never read, since reading a named pipe waits for a writer', async (context) => {
    if (process.platform === 'win32') context.skip();
    const root = `${ROOT}/pipes`;
    await write(`${root}/docs/a.md`, '# A\n');
    execFileSync('mkfifo', [`${root}/docs/pipe.md`]);
    expect(await paths(root, ['docs/*.md'])).toEqual(['docs/a.md']);
  });
});
