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

/**
 * Links a directory: a junction on Windows, which allows one without
 * privilege, and a symbolic link on every other host, which ignores the type.
 * False where the host refuses it, for the tests that need one to skip.
 */
async function linkDirectory(target: string, path: string): Promise<boolean> {
  try {
    await symlink(resolve(target), path, 'junction');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
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

  it('refuses a brace alternative that names no path before it asks for literals', async () => {
    // `{./,docs}` read every path, `vendor` included, and as an ignore took
    // every path out (spec-core 56c7e54). The list is compiled before the
    // literals are asked for, so the refusal comes first.
    const refusal = 'invalid glob "{./,docs}": the braces expand to "./", which names no path';
    await expect(paths(root, ['{./,docs}'])).rejects.toThrow(refusal);
    await expect(paths(root, ['docs/vendor', '{./,docs}'])).rejects.toThrow(refusal);
    await expect(paths(root, ['docs/vendor'], ['{./,docs}'])).rejects.toThrow(refusal);
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

describe('a ! before a bare --ignore name', () => {
  const root = `${ROOT}/negated`;
  const drafts = ['docs/adr/drafts/n.md', 'docs/drafts/d.md', 'docs/drafts/keep/k.md'];
  const vendored = ['docs/vendor/v.md', 'vendor/r.md'];

  beforeAll(async () => {
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${root}/docs/drafts/d.md`, '# D\n');
    await write(`${root}/docs/drafts/keep/k.md`, '# K\n');
    await write(`${root}/docs/adr/drafts/n.md`, '# N\n');
    await write(`${root}/docs/vendor/v.md`, '# V\n');
    await write(`${root}/docs/vendor/dist/x.md`, '# X\n');
    await write(`${root}/vendor/r.md`, '# R\n');
    await write(`${ROOT}/bang/!drafts/b.md`, '# B\n');
    await write(`${ROOT}/bang/drafts/d.md`, '# D\n');
    await write(`${ROOT}/spaced/docs/a.md`, '# A\n');
    await write(`${ROOT}/spaced/my drafts/d.md`, '# D\n');
  });

  it('gives back a directory an earlier bare name prunes, at any depth, and the last to name it decides', async () => {
    // It was read as a directory called `!drafts`, so the name stayed pruned.
    expect(await paths(root, ['**/*.md'], ['drafts'])).toEqual(['docs/a.md']);
    expect(await paths(root, ['**/*.md'], ['drafts', '!drafts'])).toEqual(['docs/a.md', ...drafts]);
    expect(await paths(root, ['**/*.md'], ['!drafts', 'drafts'])).toEqual(['docs/a.md']);
    expect(await paths(root, ['**/*.md'], ['drafts', 'keep', '!drafts'])).toEqual(['docs/a.md', 'docs/adr/drafts/n.md', 'docs/drafts/d.md']);
  });

  it('gives back a starting point inside the name as it gives back the walk passing through', async () => {
    expect(await paths(root, ['docs/drafts/keep/*.md'], ['drafts', '!drafts'])).toEqual(['docs/drafts/keep/k.md']);
    expect(await paths(root, ['docs/drafts/keep/*.md'], ['!drafts', 'drafts'])).toEqual([]);
    expect(await paths(root, ['docs/adr/**/*.md'], ['drafts', '!drafts'])).toEqual(['docs/adr/drafts/n.md']);
  });

  it('gives back a directory the default list skips, whose own list still holds inside it', async () => {
    const everything = ['docs/a.md', ...drafts];
    expect(await paths(root, ['**/*.md'], ['!vendor'])).toEqual([...everything, ...vendored].sort());
    expect(await paths(root, ['**/*.md'], ['vendor', '!vendor'])).toEqual([...everything, ...vendored].sort());
    expect(await paths(root, ['**/*.md'], ['!vendor', '!dist'])).toEqual([...everything, ...vendored, 'docs/vendor/dist/x.md'].sort());
    // A later bare name is the user's word, which a pattern naming the
    // directory does not overrule.
    expect(await paths(root, ['**/*.md', 'docs/vendor'], ['!vendor', 'vendor'])).toEqual(everything);
  });

  it('leaves a path negation as it was: it takes back what a path took out, and nothing a name or the default list prunes', async () => {
    expect(await paths(root, ['**/*.md'], ['docs/*', '!docs/drafts'])).toEqual(['docs/drafts/d.md', 'docs/drafts/keep/k.md']);
    expect(await paths(root, ['**/*.md'], ['drafts', '!docs/drafts'])).toEqual(['docs/a.md']);
    expect(await paths(root, ['**/*.md'], ['!docs/vendor'])).toEqual(['docs/a.md', ...drafts]);
    // And a name gives back nothing a path took out.
    expect(await paths(root, ['**/*.md'], ['docs/*', '!drafts'])).toEqual([]);
  });

  it('names no directory that begins with !, and a ! that names nothing is refused', async () => {
    // `--ignore "!drafts"` pruned the directory called `!drafts`; braces name it.
    expect(await paths(`${ROOT}/bang`, ['**/*.md'], ['!drafts'])).toEqual(['!drafts/b.md', 'drafts/d.md']);
    expect(await paths(`${ROOT}/bang`, ['**/*.md'], ['**/{!drafts}'])).toEqual(['drafts/d.md']);
    await expect(paths(root, ['**/*.md'], ['!'])).rejects.toThrow('invalid glob "!": the pattern is empty');
    // A blank was a directory called " ", which ignored nothing and said so
    // nowhere. A name with a space in it is still a name.
    await expect(paths(root, ['**/*.md'], ['  '])).rejects.toThrow('invalid glob "  ": the pattern is empty');
    await expect(paths(root, ['**/*.md'], ['! '])).rejects.toThrow('invalid glob "! "');
    expect(await paths(`${ROOT}/spaced`, ['**/*.md'], ['my drafts'])).toEqual(['docs/a.md']);
    await expect(paths(root, ['**/*.md'], ['!!drafts'])).rejects.toThrow('invalid glob "!!drafts": a negated pattern is a list entry');
  });
});

describe('a path --ignore', () => {
  const root = `${ROOT}/pathed`;
  const drafts = ['docs/drafts/d.md', 'docs/drafts/deep/e.md'];

  beforeAll(async () => {
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${root}/docs/drafts/d.md`, '# D\n');
    await write(`${root}/docs/drafts/deep/e.md`, '# E\n');
    await write(`${root}/docs/vendor/v.md`, '# V\n');
    await write(`${root}/README.md`, '# Root\n');
  });

  it('takes out a directory a pattern starts inside, as it takes it out of a walk that passes through', async () => {
    // The walk from `docs` prunes `docs/drafts`, but a pattern that started
    // there, or below it, was read: the answer depended on where the walk began.
    expect(await paths(root, ['docs/**/*.md'], ['docs/*'])).toEqual([]);
    expect(await paths(root, ['docs/drafts/**/*.md'], ['docs/*'])).toEqual([]);
    expect(await paths(root, ['docs/drafts/deep/*.md'], ['docs/*'])).toEqual([]);
    expect(await paths(root, ['docs/drafts/d.md'], ['docs/*'])).toEqual([]);
    expect(await paths(root, ['docs/vendor/'], ['docs/*'])).toEqual([]);
    expect(await paths(root, ['docs/vendor'], ['docs/*'])).toEqual([]);
  });

  it('gives back a directory a later ! entry takes back, wherever the walk starts', async () => {
    const ignore = ['docs/*', '!docs/drafts'];
    expect(await paths(root, ['docs/**/*.md'], ignore)).toEqual(drafts);
    expect(await paths(root, ['docs/drafts/**/*.md'], ignore)).toEqual(drafts);
    expect(await paths(root, ['docs/drafts/deep/*.md'], ignore)).toEqual(['docs/drafts/deep/e.md']);
  });

  it('leaves a starting point it does not match, and the root, which nothing matches it against', async () => {
    expect(await paths(root, ['docs/drafts/**/*.md'], ['docs/drafts/*.md'])).toEqual(['docs/drafts/deep/e.md']);
    // `*` matches the empty path. Everything at the top is out and `docs` back
    // in, so a pattern that starts at the root reads what is under `docs`.
    expect(await paths(root, ['**/*.md'], ['*', '!{docs,specs}'])).toEqual(['docs/a.md', ...drafts]);
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
    // Syntax only at its start makes a pattern all the same, and not the name
    // that follows it: `*pp` takes out `app`.
    expect(await paths(root, ['**/*.md'], ['*pp'])).toEqual([]);
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

describe('a pattern that starts beyond a link', () => {
  const root = `${ROOT}/beyond/tree`;
  let linked = false;

  beforeAll(async () => {
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${ROOT}/beyond/elsewhere/c.md`, '# C\n');
    await write(`${ROOT}/beyond/elsewhere/specs/s.md`, '# S\n');
    linked = await linkDirectory(`${ROOT}/beyond/elsewhere`, `${root}/docs/linked`);
  });

  const walk = (patterns: string[], followSymlinks?: boolean) =>
    walkFiles({ root, patterns, followSymlinks }).then((files) => files.map((file) => file.path));

  it('is not read through a link the walk does not follow, where the walk from the root stops', async (context) => {
    if (!linked) context.skip();
    // Reading a directory by its path follows every link in it, so these were
    // read through `docs/linked`, which `docs/**/*.md` passes over.
    for (const followSymlinks of [undefined, false]) {
      expect(await walk(['docs/**/*.md'], followSymlinks)).toEqual(['docs/a.md']);
      expect(await walk(['docs/linked/*.md'], followSymlinks)).toEqual([]);
      expect(await walk(['docs/linked/'], followSymlinks)).toEqual([]);
      expect(await walk(['docs/linked/specs/*.md'], followSymlinks)).toEqual([]);
      expect(await walk(['docs/linked/c.md'], followSymlinks)).toEqual([]);
    }
  });

  it('is read through a link the walk follows, as the walk from the root reads it', async (context) => {
    if (!linked) context.skip();
    expect(await walk(['docs/**/*.md'], true)).toEqual(['docs/a.md', 'docs/linked/c.md', 'docs/linked/specs/s.md']);
    expect(await walk(['docs/linked/*.md'], true)).toEqual(['docs/linked/c.md']);
    expect(await walk(['docs/linked/specs/*.md'], true)).toEqual(['docs/linked/specs/s.md']);
  });
});

describe('a followed link to a directory', () => {
  const root = `${ROOT}/followed/tree`;
  let linked = false;

  beforeAll(async () => {
    await write(`${root}/docs/b.md`, '# B\n');
    await write(`${ROOT}/followed/elsewhere/c.md`, '# C\n');
    // pnpm writes `node_modules` as links; the other two are named by an ignore.
    linked = true;
    for (const name of ['node_modules', 'private', 'shared']) {
      linked &&= await linkDirectory(`${ROOT}/followed/elsewhere`, `${root}/docs/${name}`);
    }
  });

  const walk = (patterns: string[], ignore?: string[]) =>
    walkFiles({ root, patterns, ignore, followSymlinks: true }).then((files) => files.map((file) => file.path));

  it('is pruned as a directory of its name and path is: by the default list, a bare --ignore name and a path', async (context) => {
    if (!linked) context.skip();
    // It was entered whatever its name, and whatever an ignore said of it.
    expect(await walk(['docs/**/*.md'])).toEqual(['docs/b.md', 'docs/private/c.md', 'docs/shared/c.md']);
    expect(await walk(['docs/**/*.md'], ['private'])).toEqual(['docs/b.md', 'docs/shared/c.md']);
    expect(await walk(['docs/**/*.md'], ['docs/p*'])).toEqual(['docs/b.md', 'docs/shared/c.md']);
    expect(await walk(['docs/node_modules'], ['node_modules'])).toEqual([]);
  });

  it('is read where a pattern names it or starts inside it, as a directory the default list skips is', async (context) => {
    if (!linked) context.skip();
    expect(await walk(['docs/node_modules'])).toEqual(['docs/node_modules/c.md']);
    expect(await walk(['docs/node_modules/*.md'])).toEqual(['docs/node_modules/c.md']);
    expect(await walk(['**/*.md', 'docs/node_modules/'])).toEqual(['docs/b.md', 'docs/node_modules/c.md', 'docs/private/c.md', 'docs/shared/c.md']);
  });
});

describe('a followed link back into a directory the walk is inside', () => {
  // One cycle to a tree: two in one tree multiply, and the walk before this
  // took minutes to go round them rather than failing on what it read.
  const root = `${ROOT}/cycles/tree`;
  const rooted = `${ROOT}/cycles/rooted`;
  let linked = false;

  beforeAll(async () => {
    await write(`${root}/top.md`, '# Top\n');
    await write(`${root}/docs/a.md`, '# A\n');
    await write(`${root}/docs/sub/s.md`, '# S\n');
    await write(`${root}/docs/other/o.md`, '# O\n');
    await write(`${ROOT}/cycles/elsewhere/e.md`, '# E\n');
    await write(`${rooted}/r.md`, '# R\n');
    await write(`${rooted}/docs/d.md`, '# D\n');
    // A link to the directory above it, one to a sibling inside the tree, two
    // to one directory outside it, and in a tree of its own, one to the root.
    linked = true;
    for (const [target, path] of [
      [`${root}/docs`, `${root}/docs/sub/up`],
      [`${root}/docs/other`, `${root}/docs/sibling`],
      [`${ROOT}/cycles/elsewhere`, `${root}/docs/one`],
      [`${ROOT}/cycles/elsewhere`, `${root}/docs/two`],
      [rooted, `${rooted}/docs/back`],
    ] as const) {
      linked &&= await linkDirectory(target, path);
    }
  });

  const walk = (patterns: string[], followSymlinks = true, at = root) =>
    walkFiles({ root: at, patterns, followSymlinks }).then((files) => files.map((file) => file.path));

  it('is not followed, so each file is read once under its own path', async (context) => {
    if (!linked) context.skip();
    // Each time round the cycle read the same files again under a longer
    // path, until the host refused one: on Windows, 64 copies of each.
    expect(await walk(['**/*.md'])).toEqual([
      'docs/a.md',
      'docs/one/e.md',
      'docs/other/o.md',
      'docs/sibling/o.md',
      'docs/sub/s.md',
      'docs/two/e.md',
      'top.md',
    ]);
    expect(await walk(['docs/sub/**/*.md'])).toEqual(['docs/sub/s.md']);
    expect(await walk(['**/*.md'], true, rooted)).toEqual(['docs/d.md', 'r.md']);
  });

  it('is not walked through by a pattern that starts beyond it, as the walk from the root is not', async (context) => {
    if (!linked) context.skip();
    expect(await walk(['docs/sub/up/*.md'])).toEqual([]);
    expect(await walk(['docs/sub/up/sub/*.md'])).toEqual([]);
    // Beyond the cycle, where the starting point is itself no directory the
    // walk is inside: `docs/other`, reached round it.
    expect(await walk(['docs/sub/up/other/*.md'])).toEqual([]);
    expect(await walk(['docs/back/'], true, rooted)).toEqual([]);
    expect(await walk(['docs/back/docs/*.md'], true, rooted)).toEqual([]);
  });

  it('leaves a link to a directory the walk is not inside followed, a sibling and one read already included', async (context) => {
    if (!linked) context.skip();
    expect(await walk(['docs/sibling/*.md'])).toEqual(['docs/sibling/o.md']);
    expect(await walk(['docs/other/*.md', 'docs/sibling/*.md'])).toEqual(['docs/other/o.md', 'docs/sibling/o.md']);
    expect(await walk(['docs/*/e.md'])).toEqual(['docs/one/e.md', 'docs/two/e.md']);
    expect(await walk(['docs/one/*.md', 'docs/two/*.md'])).toEqual(['docs/one/e.md', 'docs/two/e.md']);
  });

  it('is passed over as every link is when links are not followed', async (context) => {
    if (!linked) context.skip();
    expect(await walk(['**/*.md'], false)).toEqual(['docs/a.md', 'docs/other/o.md', 'docs/sub/s.md', 'top.md']);
    expect(await walk(['**/*.md'], false, rooted)).toEqual(['docs/d.md', 'r.md']);
  });

  it('leaves the run standing where a real path cannot be had, as an unreadable directory does', async () => {
    // A root that is not there has no real path, and reads nothing either way.
    for (const followSymlinks of [false, true]) {
      expect(await walk(['**/*.md'], followSymlinks, `${ROOT}/cycles/missing`)).toEqual([]);
    }
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
