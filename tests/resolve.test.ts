import { describe, expect, it } from 'vitest';

import { extractDocument } from '../src/extract.js';
import { documentOf, resolveCorpus, type ResolveOptions } from '../src/resolve.js';
import type { Edge } from '../src/types.js';

/** Resolves a corpus given as `path -> text`. */
function resolve(files: Record<string, string>, options: ResolveOptions = {}) {
  const extracted = Object.entries(files)
    .map(([path, text]) => extractDocument({ path, text }))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return resolveCorpus(extracted, options);
}

const edgesOf = (edges: readonly Edge[], kind: string): Edge[] => edges.filter((edge) => edge.kind === kind);

/* -------------------------------------------------------------------------- */

describe('inverted relations', () => {
  it('records superseded-by as a supersession owned by the other document', () => {
    const { edges } = resolve({
      'docs/adr/0002-old.md': '---\nstatus: superseded\nsuperseded-by: ADR-0003\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\n---\n\n# New\n',
    });
    const [edge] = edgesOf(edges, 'supersedes');
    expect(edge?.from).toBe('ADR-0003');
    expect(edge?.to).toBe('ADR-0002');
    // The line a human must go and fix is in the *superseded* document.
    expect(edge?.declaredAt.file).toBe('docs/adr/0002-old.md');
  });

  it('records blocks as the inverse of blocked-by', () => {
    const { edges } = resolve({
      'docs/adr/0001-a.md': '---\nblocks: ADR-0002\n---\n\n# A\n',
      'docs/adr/0002-b.md': '# B\n',
    });
    const [edge] = edgesOf(edges, 'blocked-by');
    expect(edge?.from).toBe('ADR-0002');
    expect(edge?.to).toBe('ADR-0001');
  });
});

describe('declaration sites', () => {
  it('collapses a relation stated twice into one edge that remembers both', () => {
    const { edges } = resolve({
      'docs/adr/0002-old.md': '---\nstatus: superseded\nsuperseded-by: ADR-0003\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    const supersessions = edgesOf(edges, 'supersedes');
    expect(supersessions).toHaveLength(1);
    expect([...(supersessions[0]?.declaredIn ?? [])].sort()).toEqual([
      'docs/adr/0002-old.md',
      'docs/adr/0003-new.md',
    ]);
  });

  it('keeps a single declaration site when only one document says it', () => {
    const { edges } = resolve({
      'docs/adr/0002-old.md': '---\nstatus: archived\n---\n\n# Old\n',
      'docs/adr/0003-new.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n',
    });
    expect(edgesOf(edges, 'supersedes')[0]?.declaredIn).toEqual(['docs/adr/0003-new.md']);
  });
});

describe('anchors', () => {
  const target = [
    '# Target',
    '',
    '## Open Questions',
    '',
    '<!-- @spec-item id="shard-key" -->',
    '- [ ] Which shard key?',
  ].join('\n');

  it('binds an anchor to an item when one answers to it', () => {
    const { edges } = resolve({
      'docs/adr/0001-target.md': target,
      'docs/adr/0002-src.md': '# Src\n\nSee [the question](0001-target.md#shard-key).\n',
    });
    expect(edges.some((edge) => edge.to === 'ADR-0001#shard-key' && edge.from === 'ADR-0002')).toBe(true);
  });

  it('binds an anchor to the document when it names a heading', () => {
    const { edges, dangling } = resolve({
      'docs/adr/0001-target.md': target,
      'docs/adr/0002-src.md': '# Src\n\nSee [the section](0001-target.md#open-questions).\n',
    });
    expect(dangling).toHaveLength(0);
    expect(edges.some((edge) => edge.to === 'ADR-0001' && edge.from === 'ADR-0002')).toBe(true);
  });

  it('tolerates a differently slugified anchor', () => {
    const { dangling } = resolve({
      'docs/adr/0001-target.md': target,
      'docs/adr/0002-src.md': '# Src\n\nSee [it](0001-target.md#Open_Questions).\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('reports an anchor that names nothing', () => {
    const { dangling } = resolve({
      'docs/adr/0001-target.md': target,
      'docs/adr/0002-src.md': '# Src\n\nSee [it](0001-target.md#nope).\n',
    });
    expect(dangling[0]?.reason).toBe('unknown-anchor');
  });

  it('resolves a bare in-document anchor against the citing document', () => {
    const { edges, dangling } = resolve({
      'docs/adr/0001-target.md': `${target}\n\nBack to [the questions](#open-questions).\n`,
    });
    expect(dangling).toHaveLength(0);
    expect(edges.some((edge) => edge.reflexive)).toBe(true);
  });
});

describe('path resolution', () => {
  it('resolves a relative path against the citing document', () => {
    const { dangling } = resolve({
      'docs/rfcs/0001-a.md': '# A\n',
      'docs/adr/0002-b.md': '# B\n\nSee [A](../rfcs/0001-a.md).\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('resolves a directory-style document by its folder', () => {
    const { dangling } = resolve({
      'docs/adr/0001-a/README.md': '# A\n',
      'docs/adr/0002-b.md': '# B\n\nSee [A](0001-a).\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('resolves a path written without its extension', () => {
    const { dangling } = resolve({
      'docs/adr/0001-a.md': '# A\n',
      'docs/adr/0002-b.md': '# B\n\nSee [A](./0001-a).\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('distinguishes a missing document from one outside the patterns', () => {
    const files = { 'docs/adr/0002-b.md': '# B\n\nSee [notes](notes.md).\n' };
    expect(resolve(files).dangling[0]?.reason).toBe('unknown-target');
    expect(resolve(files, { fileExists: (p) => p === 'docs/adr/notes.md' }).dangling[0]?.reason).toBe('not-a-spec');
  });
});

describe('what never becomes a reference', () => {
  it('external URLs', () => {
    const { dangling, edges } = resolve({
      'docs/adr/0001-a.md': '# A\n\n[spec](https://example.com/adr-0099) and <mailto:a@b.c>.\n',
    });
    expect(dangling).toHaveLength(0);
    expect(edges.filter((e) => e.kind !== 'contains')).toHaveLength(0);
  });

  it('source files and images', () => {
    const { dangling } = resolve({
      'docs/adr/0001-a.md': '# A\n\n[code](../../src/x.ts), [pic](d.png), [data](x.json).\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('a document naming itself in its own heading', () => {
    const { edges } = resolve({ 'docs/adr/0001-a.md': '# ADR-0001: A\n\nADR-0001 is this document.\n' });
    expect(edges.filter((edge) => edge.kind !== 'contains')).toHaveLength(0);
  });

  it('a bare token whose family is not in the corpus', () => {
    const { dangling } = resolve({
      'docs/adr/0001-a.md': '# A\n\nWe use SHA-256, UTF-8 and TLS-13 over HTTP-2.\n',
    });
    expect(dangling).toHaveLength(0);
  });

  it('a bare token whose family is present but whose number is not', () => {
    const { dangling } = resolve({ 'docs/adr/0001-a.md': '# A\n\nAs decided in ADR-0099.\n' });
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.target).toBe('ADR-0099');
  });
});

describe('corpus integrity', () => {
  it('reports two documents claiming the same id, and keeps the first', () => {
    const { problems, documents } = resolve({
      'docs/adr/0001-a.md': '---\nid: ADR-0001\n---\n\n# A\n',
      'docs/adr/other.md': '---\nid: ADR-0001\n---\n\n# Other\n',
    });
    expect(problems[0]?.message).toContain('duplicate document id');
    expect(documents).toHaveLength(1);
    expect(documents[0]?.path).toBe('docs/adr/0001-a.md');
  });

  it('reports an ambiguous alias rather than choosing', () => {
    const { dangling } = resolve({
      'docs/adr/0001-a.md': '---\naliases: [shared]\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\naliases: [shared]\n---\n\n# B\n',
      'docs/adr/0003-c.md': '# C\n\nSee [[shared]].\n',
    });
    expect(dangling[0]?.reason).toBe('ambiguous');
    expect([...(dangling[0]?.candidates ?? [])].sort()).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('creates a contains edge for every item', () => {
    const { edges, items } = resolve({
      'docs/adr/0001-a.md': '# A\n\n## Open Questions\n\n- [ ] one\n- [ ] two\n',
    });
    expect(items).toHaveLength(2);
    expect(edgesOf(edges, 'contains')).toHaveLength(2);
  });

  it('marks an edge inside one document as reflexive', () => {
    const { edges } = resolve({
      'docs/adr/0001-a.md': '# A\n\nDepends on [itself](0001-a.md).\n',
    });
    expect(edgesOf(edges, 'depends-on')[0]?.reflexive).toBe(true);
  });

  it('honours a spec-ignore directive', () => {
    const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text: '<!-- @spec-ignore -->\n\n# A\n' });
    expect(extracted).toBeNull();
  });
});

describe('documentOf', () => {
  it('strips the item suffix from a node id', () => {
    expect(documentOf('ADR-0007#q.1')).toBe('ADR-0007');
    expect(documentOf('ADR-0007')).toBe('ADR-0007');
  });
});

describe('a path spelled inexactly', () => {
  // `docs/A` is two things at once: `docs/A.md` with its extension dropped, and
  // `docs/A/README.md` standing for its directory. The index that answered such
  // spellings kept a single id per key, so a collision was an overwrite and the
  // link went to whichever file happened to be indexed last, silently.
  const DOC = ['# ADR-0001: The doc', '', '## Status', '', 'accepted'].join('\n');
  const INDEX = ['# ADR-0002: The folder index', '', '## Status', '', 'accepted'].join('\n');
  const cite = (link: string): string => ['# B', '', `See ${link}.`].join('\n');

  const both = (link: string) => resolve({ 'docs/A.md': DOC, 'docs/A/README.md': INDEX, 'B.md': cite(link) });

  it('is reported as ambiguous when two files answer to it', () => {
    const { dangling } = both('[x](docs/A)');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.reason).toBe('ambiguous');
    expect([...(dangling[0]?.candidates ?? [])].sort()).toEqual(['ADR-0001', 'ADR-0002']);
  });

  it('never makes naming the file exactly ambiguous', () => {
    // The literal path has one owner by construction, whatever else is spelled
    // the same way, so an exact link must not be dragged into the ambiguity.
    expect(edgesOf(both('[y](docs/A.md)').edges, 'references').map((edge) => edge.to)).toEqual(['ADR-0001']);
    expect(edgesOf(both('[z](docs/A/README.md)').edges, 'references').map((edge) => edge.to)).toEqual(['ADR-0002']);
  });

  it('still resolves silently when only one file answers to it', () => {
    // The id comes from the directory here, not from the H1: that is what makes
    // `docs/adr/0007` the natural way to write the link in the first place.
    const parent = resolve({ 'docs/adr/0007/README.md': DOC, 'B.md': cite('[a](docs/adr/0007)') });
    expect(parent.dangling).toEqual([]);
    expect(edgesOf(parent.edges, 'references').map((edge) => edge.to)).toEqual(['ADR-0007']);

    const stem = resolve({ 'docs/A.md': DOC, 'B.md': cite('[b](docs/A)') });
    expect(stem.dangling).toEqual([]);
    expect(edgesOf(stem.edges, 'references').map((edge) => edge.to)).toEqual(['ADR-0001']);
  });

  it('is ambiguous when one directory holds both a README and an index', () => {
    const { dangling } = resolve({
      'docs/A/README.md': DOC,
      'docs/A/index.md': INDEX,
      'B.md': cite('[c](docs/A)'),
    });
    expect(dangling[0]?.reason).toBe('ambiguous');
  });

  it('says nothing about an ambiguity nobody wrote down', () => {
    // Prose is inferred, not declared. An identifier picked out of a sentence
    // that turns out to name two files is not a mistake the author made, and
    // reporting it is the false positive ADR-0006 exists to prevent.
    const { dangling } = resolve({
      'docs/A.md': DOC,
      'docs/A/README.md': INDEX,
      'B.md': ['# B', '', 'This depends on docs/A for its ordering.'].join('\n'),
    });
    expect(dangling).toEqual([]);
  });
});

describe('a path spelling is matched against paths, not basenames', () => {
  it('does not confuse two files that share a name in different directories', () => {
    // There is a looser fallback below this one, matching the last segment of a
    // path against the alias table, for identifiers written in a nested folder
    // layout. It cannot tell `docs/A.md` from `other/A.md`, and would call this
    // ambiguous. Matching the spelling against whole paths first is what makes
    // `docs/A` mean the file in `docs/` - and losing that index does not fail
    // quietly, it invents an ambiguity and drops the edge.
    const here = ['# ADR-0001: Here', '', '## Status', '', 'accepted'].join('\n');
    const elsewhere = ['# ADR-0002: Elsewhere', '', '## Status', '', 'accepted'].join('\n');
    const { edges, dangling } = resolve({
      'docs/A.md': here,
      'other/A.md': elsewhere,
      'B.md': ['# B', '', 'See [x](docs/A).'].join('\n'),
    });
    expect(dangling).toEqual([]);
    expect(edgesOf(edges, 'references').map((edge) => edge.to)).toEqual(['ADR-0001']);
  });
});
