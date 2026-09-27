import { describe, expect, it } from 'vitest';

import { extnamePosix, normalisePosix, resolveFrom } from '../src/paths.js';

/**
 * The POSIX path arithmetic the API exports, held to what each function's
 * documentation promises: a path the same on every host, with `..` resolved as
 * far as it can be and no further.
 */

describe('normalising a path', () => {
  it('keeps the .. of a relative path that climbs above where it starts', () => {
    expect(normalisePosix('../a')).toBe('../a');
    expect(normalisePosix('a/../../b')).toBe('../b');
  });

  it('drops the .. of an absolute path at its root, which has nothing above it', () => {
    expect(normalisePosix('/../a')).toBe('/a');
    expect(normalisePosix('/a/../../b')).toBe('/b');
  });
});

describe('resolving a link', () => {
  it('leaves a target that is already absolute where it points, however deep the linking file', () => {
    expect(resolveFrom('docs/adr/0004.md', '/docs/rfcs/0001.md')).toBe('/docs/rfcs/0001.md');
    expect(resolveFrom('docs/adr/0004.md', '/docs/../0001.md')).toBe('/0001.md');
  });
});

describe('the extension of a path', () => {
  it('includes its dot, and is lower-cased', () => {
    expect(extnamePosix('docs/adr/0007.md')).toBe('.md');
    expect(extnamePosix('docs/adr/0007.MD')).toBe('.md');
    expect(extnamePosix('docs/archive.tar.GZ')).toBe('.gz');
  });

  it('is empty for a name with no dot, or whose only dot opens it', () => {
    expect(extnamePosix('docs/README')).toBe('');
    expect(extnamePosix('docs.v2/README')).toBe('');
    expect(extnamePosix('docs/.gitignore')).toBe('');
  });
});
