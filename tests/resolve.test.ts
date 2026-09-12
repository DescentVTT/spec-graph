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

describe('percent-escaped destinations', () => {
  const A = '---\nid: ADR-0001\nstatus: accepted\n---\n\n# ADR-0001: Target\n';
  const citing = (id: string, target: string) =>
    `---\nid: ${id}\nstatus: accepted\n---\n\n# ${id}\n\nDepends on [d](${target}).\n`;

  it('reads the escapes when the written spelling names nothing', () => {
    // What a renderer, a docs site and GitHub's "copy link" all produce for a
    // file with a space in its name.
    const { edges, dangling } = resolve({ 'my design.md': A, 'B.md': citing('ADR-0002', 'my%20design.md') });
    expect(dangling).toEqual([]);
    expect(edgesOf(edges, 'depends-on').map((e) => e.to)).toEqual(['ADR-0001']);
  });

  it('prefers the spelling as written', () => {
    // A file whose name really does contain a percent escape keeps winning,
    // which is why the decode is a fallback and not a normalisation.
    const { edges, dangling } = resolve({
      'a%20b.md': A,
      'a b.md': '---\nid: ADR-0003\nstatus: accepted\n---\n\n# ADR-0003\n',
      'C.md': citing('ADR-0002', 'a%20b.md'),
    });
    expect(dangling).toEqual([]);
    expect(edgesOf(edges, 'depends-on').map((e) => e.to)).toEqual(['ADR-0001']);
  });

  it('leaves a stray percent alone rather than throwing', () => {
    const { dangling } = resolve({ 'B.md': citing('ADR-0002', 'docs/100%-uptime.md') });
    expect(dangling.map((d) => d.target)).toEqual(['docs/100%-uptime.md']);
  });
});

/* -------------------------------------------------------------------------- */


/**
 * "Did you mean ADR-0009?" - and, far more often, the deliberate silence.
 *
 * Every case below that expects `[]` is the point of the feature: a suggestion
 * is only worth printing when the spelling pins one document down, and a number
 * never pins anything down because every number has neighbours. See ADR-0004.
 */
describe('near-miss suggestions', () => {
  const CORPUS: Record<string, string> = {
    'docs/adr/0001-sharding.md': `---
status: accepted
---

# ADR-0001: Sharding
`,
    'docs/adr/0002-caching.md': `---
status: accepted
---

# ADR-0002: Caching
`,
    'docs/rfc/0002-transport.md': `---
id: RFC-0002
status: accepted
---

# RFC-0002: Transport
`,
    'docs/notes/abcd.md': `---
id: abcd
status: accepted
---

# Notes
`,
  };

  const ADX = `---
id: ADX-0002
status: accepted
---

# ADX-0002: Elsewhere
`;

  /** The candidates offered for one unresolved reference in a fresh document. */
  const suggest = (target: string, body?: string, extra: Record<string, string> = {}): readonly string[] => {
    const line = body ?? `See [it](${target}).`;
    const { dangling } = resolve({
      ...CORPUS,
      ...extra,
      'docs/adr/0009-probe.md': `---
status: accepted
---

# ADR-0009: Probe

## Context

${line}
`,
    });
    const entry = dangling.find((candidate) => candidate.target === target);
    expect(entry, `nothing was reported for "${target}"`).toBeDefined();
    return entry?.candidates ?? [];
  };

  it('suggests the family a mistyped prefix is one edit from', () => {
    expect(suggest('ARD-0002')).toEqual(['ADR-0002']);
  });

  it('suggests nothing when the number is what is wrong', () => {
    // The whole discipline in one assertion: ADR-0001 and ADR-0002 are each one
    // edit from ADR-0003, and neither of them is what the author meant.
    expect(suggest('ADR-0003')).toEqual([]);
    expect(suggest('ADR-0004')).toEqual([]);
  });

  it('suggests nothing when a mistyped family fits two corpora equally', () => {
    // `ADQ` is one edit from `ADR` and one edit from `ADX`, and both families
    // hold a document numbered 0002.
    expect(suggest('ADQ-0002', undefined, { 'docs/adx/0002-x.md': ADX })).toEqual([]);
    // With only one of the two families present it is a suggestion again, which
    // is what makes the case above about ambiguity rather than about distance.
    expect(suggest('ADQ-0002')).toEqual(['ADR-0002']);
  });

  it('suggests the sibling a mistyped basename is one edit from', () => {
    expect(suggest('0002-cacheing.md')).toEqual(['ADR-0002']);
  });

  it('does not reach into another directory for a basename typo', () => {
    // `0001-shardng.md` is one edit from a real file - in `docs/adr`, not here.
    // A path names a place, and a typo that also moved the place is two guesses
    // stacked on one another.
    expect(suggest('../rfc/0001-shardng.md')).toEqual([]);
  });

  it('suggests the document a mistyped slug is one edit from', () => {
    // A letter too many, so the written key is longer than the spelling that
    // resolves.
    expect(suggest('0001-shardingg', 'See [[0001-shardingg]].')).toEqual(['ADR-0001']);
  });

  it('suggests it when the typo dropped a letter rather than adding one', () => {
    // And a letter too few, so the written key is *shorter*. The scan walks
    // three length buckets for exactly this reason, and only one of them is
    // reachable from the case above.
    expect(suggest('0001-shardin', 'See [[0001-shardin]].')).toEqual(['ADR-0001']);
  });

  it('suggests nothing for a folded spelling too short to mean anything', () => {
    // `abcd` is a real document here and `abce` is one edit from it. Four
    // characters is not enough evidence to send anybody anywhere.
    expect(suggest('abce', 'See [[abce]].')).toEqual([]);
  });

  it('suggests nothing for a bare number, however long it is written', () => {
    // Six digits clears the length floor, so this is the bare-number gate on
    // its own: `000002` sits one edit from a document that really is `000001`,
    // and the only thing they differ in is the identity.
    const bare = {
      'notes/000001.md': `---
status: accepted
---

# Rule One
`,
      'notes/index.md': `---
status: accepted
---

# Index

## Context

See [it](000002).
`,
    };
    const { dangling } = resolve(bare);
    expect(dangling.map((entry) => entry.target)).toEqual(['000002']);
    expect(dangling.flatMap((entry) => entry.candidates)).toEqual([]);
  });

  it('costs nothing on a reference that resolves', () => {
    // Suggestions are computed after failure, never before it.
    const { edges, dangling } = resolve({
      ...CORPUS,
      'docs/adr/0009-probe.md': `---
status: accepted
depends-on: ADR-0001
---

# ADR-0009: Probe
`,
    });
    expect(dangling).toEqual([]);
    expect(edges.some((edge) => edge.to === 'ADR-0001')).toBe(true);
  });
});
