/**
 * The copy of spec-core under src/vendor/ is spec-core's, byte for byte.
 *
 * spec-core is copied into each tool rather than depended on, and the copies
 * stay one library only if nobody edits one in place (spec-core ADR-0001).
 * `VENDOR.json` holds the SHA-256 of every file as it was copied, and this
 * recomputes them: a fix made here instead of in spec-core fails the build here,
 * rather than drifting from every other tool's copy. The way to change a file is
 * to change spec-core and copy it again with its `scripts/vendor.mjs`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIRECTORY = 'src/vendor/spec-core';

interface VendorRecord {
  readonly source: string;
  readonly commit: string | null;
  readonly modules: Readonly<Record<string, { readonly files: Readonly<Record<string, string>> }>>;
}

const record = JSON.parse(readFileSync(`${DIRECTORY}/VENDOR.json`, 'utf8')) as VendorRecord;

const sha256 = (path: string): string => `sha256-${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

describe('the vendored spec-core', () => {
  it('names the commit it was copied from', () => {
    // A copy made from a working tree with uncommitted changes records no
    // commit, and then nobody can say which spec-core this is.
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds the modules spec-graph uses, and the one they import', () => {
    expect(Object.keys(record.modules).sort()).toEqual(['path', 'pattern']);
  });

  for (const [module, { files }] of Object.entries(record.modules)) {
    it(`has every file of ${module} exactly as it was copied`, () => {
      const edited = Object.entries(files)
        .filter(([name, hash]) => sha256(`${DIRECTORY}/${module}/${name}`) !== hash)
        .map(([name]) => `${module}/${name}`);
      expect(edited, 'edited in place: change spec-core and copy it again').toEqual([]);
    });

    it(`has no file in ${module} that was not copied`, () => {
      // A file added beside the copies is spec-graph code wearing spec-core's
      // name, and nothing would ever check it against anything.
      expect(readdirSync(`${DIRECTORY}/${module}`).sort()).toEqual(Object.keys(files).sort());
    });
  }
});
