import { describe, expect, it } from 'vitest';

import { attr, attrList, bindItemDirectives, directiveFor, parseDirectives } from '../src/directives.js';
import { foldRelationKey, RELATION_KEYS } from '../src/extract.js';
import {
  familyFromPath,
  identify,
  isDocumentTarget,
  isExternal,
  looksLikePath,
  normaliseRef,
  parseBareRef,
  parsePrefixedRef,
  splitAnchor,
  withinOneEdit,
} from '../src/identity.js';
import {
  isRetired,
  isStatusHeading,
  normaliseStatus,
  phaseFromPath,
  phaseOf,
  receptivityOf,
  supersessionTargetsIn,
} from '../src/lifecycle.js';
import { scanMarkdown } from '../src/markdown.js';
import { basenamePosix, dirnamePosix, joinPosix, normalisePosix, resolveFrom, toPosix } from '../src/paths.js';
import type { EdgeKind } from '../src/types.js';
import { parseFrontMatter, toRecord, valuesOf } from '../src/yaml.js';

/* -------------------------------------------------------------------------- */

describe('front matter', () => {
  const parse = (raw: string) => toRecord(parseFrontMatter(raw));

  it('reads scalars, quoted values and comments', () => {
    expect(
      parse(['status: accepted', 'title: "A: colonised title"', "owner: 'platform'", 'note: value # trailing'].join('\n')),
    ).toEqual({
      status: 'accepted',
      title: 'A: colonised title',
      owner: 'platform',
      note: 'value',
    });
  });

  it('reads inline and block sequences', () => {
    expect(parse('tags: [a, b, "c, d"]\ndeps:\n  - ADR-1\n  - ADR-2\n')).toEqual({
      tags: ['a', 'b', 'c, d'],
      deps: ['ADR-1', 'ADR-2'],
    });
  });

  it('flattens one level of nesting', () => {
    expect(parse('meta:\n  owner: platform\n  tier: 1\n')).toEqual({ 'meta.owner': 'platform', 'meta.tier': '1' });
  });

  it('lower-cases keys but never values', () => {
    expect(parse('Status: Accepted\n')).toEqual({ status: 'Accepted' });
  });

  it('records the offset of each value so a status can be pointed at', () => {
    const raw = 'title: A\nstatus: accepted\n';
    const entry = parseFrontMatter(raw, 100).find((e) => e.key === 'status');
    expect(raw.slice((entry?.valueStart ?? 0) - 100, (entry?.end ?? 0) - 100)).toBe('accepted');
  });

  it('does not split a comment marker inside a quoted value', () => {
    expect(parse('title: "a # b"\n')).toEqual({ title: 'a # b' });
  });

  it('survives an empty value', () => {
    expect(parse('status:\n')).toEqual({ status: '' });
  });

  it('flattens values to a list regardless of how they were written', () => {
    const entries = parseFrontMatter('one: a\nmany: [a, b]\nnone:\n');
    const by = (key: string) => valuesOf(entries.find((e) => e.key === key));
    expect(by('one')).toEqual(['a']);
    expect(by('many')).toEqual(['a', 'b']);
    expect(by('none')).toEqual([]);
    expect(by('missing')).toEqual([]);
  });
});

describe('lifecycle vocabulary', () => {
  it('maps the vocabularies of four ecosystems', () => {
    const cases: [string, string][] = [
      ['accepted', 'active'],
      ['implementable', 'active'],
      ['implemented', 'active'],
      ['merged', 'active'],
      ['proposed', 'draft'],
      ['provisional', 'draft'],
      ['final', 'frozen'],
      ['ratified', 'frozen'],
      ['superseded', 'retired'],
      ['superceded', 'retired'],
      ['deprecated', 'retired'],
      ['withdrawn', 'retired'],
      ['replaced', 'retired'],
    ];
    for (const [raw, expected] of cases) expect(phaseOf(raw), raw).toBe(expected);
  });

  it('returns unknown rather than guessing', () => {
    expect(phaseOf('banana')).toBe('unknown');
    expect(phaseOf('')).toBe('unknown');
    expect(phaseOf(null)).toBe('unknown');
    expect(phaseOf(undefined)).toBe('unknown');
  });

  it('strips decoration before matching', () => {
    expect(normaliseStatus('**Accepted** (2026-03-01) ✅')).toBe('accepted');
    expect(normaliseStatus('`Final`')).toBe('final');
    expect(normaliseStatus('[Accepted](x.md)')).toBe('accepted');
    expect(phaseOf('<b>Accepted</b>')).toBe('active');
  });

  it('lets a terminal word beat an earlier one', () => {
    expect(phaseOf('Accepted, superseded by ADR-9')).toBe('retired');
    expect(phaseOf('Draft, later accepted')).toBe('active');
  });

  it('maps a phase to whether it can absorb work', () => {
    expect(receptivityOf('draft')).toBe('receptive');
    expect(receptivityOf('active')).toBe('receptive');
    expect(receptivityOf('frozen')).toBe('sealed');
    expect(receptivityOf('retired')).toBe('sealed');
    expect(receptivityOf('unknown')).toBe('unknown');
  });

  it('retires a document by its directory', () => {
    expect(phaseFromPath('docs/adr/archive/0001.md')).toBe('retired');
    expect(phaseFromPath('docs/adr/superseded/0001.md')).toBe('retired');
    expect(phaseFromPath('docs/adr/0001.md')).toBe('unknown');
    // A file called archive.md is not a directory called archive.
    expect(phaseFromPath('docs/adr/archive.md')).toBe('unknown');
  });

  it('tells retirement apart from merely being sealed', () => {
    // `frozen` is also sealed, but it still binds - a frozen decision is
    // current, it just cannot be edited. Only `retired` means it no longer
    // applies, which is what makes a citation of it a stale premise.
    expect(isRetired('retired')).toBe(true);
    expect(isRetired('frozen')).toBe(false);
    expect(isRetired('active')).toBe(false);
    expect(isRetired('draft')).toBe(false);
    expect(isRetired('unknown')).toBe(false);
  });

  it('recognises a status heading', () => {
    expect(isStatusHeading('Status')).toBe(true);
    expect(isStatusHeading('  status  ')).toBe(true);
    expect(isStatusHeading('Current Status')).toBe(true);
    expect(isStatusHeading('Context')).toBe(false);
  });

  it('pulls supersession targets out of a status line', () => {
    expect(supersessionTargetsIn('Superseded by ADR-0009')).toEqual(['ADR-0009']);
    expect(supersessionTargetsIn('superseded by ADR-1 and ADR-2')).toEqual(['ADR-1', 'ADR-2']);
    expect(supersessionTargetsIn('Replaced by [ADR-3](0003.md)')).toEqual(['ADR-3']);
    expect(supersessionTargetsIn('accepted')).toEqual([]);
  });
});

describe('identity', () => {
  it('derives an id from a numbered file name', () => {
    expect(identify({ path: 'docs/adr/0007-sharding.md', declaredId: null, declaredAliases: [], heading: null }).id).toBe(
      'ADR-0007',
    );
  });

  it('reads a family prefix out of the file name itself', () => {
    const identity = identify({ path: 'keps/kep-1234-thing.md', declaredId: null, declaredAliases: [], heading: null });
    expect(identity.family).toBe('KEP');
    expect(identity.number).toBe(1234);
  });

  it('falls back to the H1 when the file name carries no number', () => {
    const identity = identify({
      path: 'docs/adr/sharding.md',
      declaredId: null,
      declaredAliases: [],
      heading: 'ADR-0007: Sharding',
    });
    expect(identity.id).toBe('ADR-0007');
  });

  it('identifies a directory-style document by its directory', () => {
    expect(
      identify({ path: 'docs/adr/0007-sharding/README.md', declaredId: null, declaredAliases: [], heading: null }).id,
    ).toBe('ADR-0007');
  });

  it('leaves a root-level README named after itself', () => {
    // There is no enclosing directory to borrow a name from, and slicing one off
    // anyway produced the id "README.m".
    expect(identify({ path: 'README.md', declaredId: null, declaredAliases: [], heading: null }).id).toBe('README');
  });

  it('registers every spelling a citation might use', () => {
    const identity = identify({
      path: 'docs/adr/0007-sharding.md',
      declaredId: null,
      declaredAliases: ['sharding'],
      heading: null,
    });
    for (const spelling of ['ADR-0007', 'adr 7', 'adr_0007', 'ADR7', '0007-sharding', 'sharding']) {
      expect(identity.aliases, spelling).toContain(normaliseRef(spelling));
    }
  });

  it('takes the nearest family directory', () => {
    expect(familyFromPath('docs/rfcs/adr/0007.md')).toBe('ADR');
    expect(familyFromPath('docs/notes/0007.md')).toBeNull();
  });

  it('folds separators and case when normalising a reference', () => {
    expect(normaliseRef('ADR-0007')).toBe('adr0007');
    expect(normaliseRef('adr 0007')).toBe('adr0007');
    expect(normaliseRef('Adr_0007')).toBe('adr0007');
    expect(normaliseRef('#ADR-0007')).toBe('adr0007');
  });

  it('splits an anchor', () => {
    expect(splitAnchor('0007.md#open-questions')).toEqual({ target: '0007.md', anchor: 'open-questions' });
    expect(splitAnchor('#local')).toEqual({ target: '', anchor: 'local' });
    expect(splitAnchor('0007.md')).toEqual({ target: '0007.md', anchor: null });
  });

  it('parses prefixed and bare references', () => {
    expect(parsePrefixedRef('ADR-0007')).toEqual({ family: 'ADR', number: 7 });
    expect(parsePrefixedRef('kep 1234')).toEqual({ family: 'KEP', number: 1234 });
    expect(parsePrefixedRef('sharding')).toBeNull();
    expect(parseBareRef('#0007')).toBe(7);
    expect(parseBareRef('ADR-7')).toBeNull();
  });

  it('recognises external targets', () => {
    expect(isExternal('https://example.com/adr-7')).toBe(true);
    expect(isExternal('mailto:a@b.c')).toBe(true);
    expect(isExternal('../adr/0007.md')).toBe(false);
    // A Windows drive letter is a path, not a URL scheme.
    expect(isExternal('C:/repo/adr.md')).toBe(false);
  });

  it('tells a specification target from a source-code one', () => {
    expect(isDocumentTarget('../adr/0007.md')).toBe(true);
    expect(isDocumentTarget('rfcs/0007')).toBe(true);
    expect(isDocumentTarget('notes.markdown')).toBe(true);
    expect(isDocumentTarget('../../src/rules.ts')).toBe(false);
    expect(isDocumentTarget('diagram.png')).toBe(false);
    // A dotted identifier keeps its dot and is still resolved as an id.
    expect(isDocumentTarget('ADR-0007.1')).toBe(true);
    expect(isDocumentTarget('v1.2')).toBe(true);
  });

  it('recognises path-shaped targets', () => {
    expect(looksLikePath('a/b')).toBe(true);
    expect(looksLikePath('0007.md')).toBe(true);
    expect(looksLikePath('ADR-0007')).toBe(false);
  });
});

describe('a title is not a name', () => {
  // A title is prose about a document. An identifier it opens with belongs to
  // the document it is about, and reading it as the title's own name attributed
  // 27 of 232 rows of one register to the wrong entity.
  const row = (declaredId: string, heading: string) =>
    identify({ path: 'docs/issues/README.md', declaredId, declaredAliases: [], heading, includePathAliases: false });

  it('does not let a heading override a declared id', () => {
    expect(row('OI-V-05', "ADR-040's enforcement point has no browser test").id).toBe('OI-V-05');
    expect(row('CUSTOM-ITEM', 'STAGE-1: Bar').id).toBe('CUSTOM-ITEM');
  });

  it('does not let the overridden identifier reach the row as an alias either', () => {
    // The alias is the same hijack one step removed, and it lands somewhere
    // worse: every citation of the real ADR-040 resolving to the row raised
    // against it, or going ambiguous between the two.
    expect(row('OI-V-05', "ADR-040's enforcement point has no browser test").aliases).toEqual(['oiv05']);
  });

  it('invents no family from a title that opens with a noun phrase', () => {
    // STAGE-1, GUARDRAIL-5, CLAUSE-4 and Q-046 all parse as family and number,
    // and each one became an open document nobody had written - which then drew
    // a ghost-handover finding against a phantom.
    for (const heading of [
      'STAGE-1 needs a gate',
      'GUARDRAIL-5 is unenforced',
      'CLAUSE-4 contradicts it',
      'Q-046 remains open',
    ]) {
      const identity = row('OI-V-11', heading);
      expect(identity.id, heading).toBe('OI-V-11');
      expect(identity.family, heading).toBeNull();
      expect(identity.number, heading).toBeNull();
    }
  });

  it('still takes the number from the file name when the declaration carries none', () => {
    // A declaration and a file name both name the same file, so the name may
    // spell what the declaration left out. `slug:` is in ID_KEYS, and a Jekyll
    // ADR carrying one must stay ADR-0007 rather than become its slug.
    const identity = identify({
      path: 'docs/adr/0007-sharding.md',
      declaredId: 'sharding-the-write-path',
      declaredAliases: [],
      heading: 'Sharding the write path',
    });
    expect(identity.id).toBe('ADR-0007');
    expect(identity.aliases).toContain('shardingthewritepath');
  });

  it('still lets an H1 name a whole file that nothing else numbered', () => {
    // The limit of the rule, and it is deliberate. A file's front matter is an
    // open vocabulary - `slug:` is in ID_KEYS and holds a URL segment, not an
    // id - so an unnumbered declaration there says nothing about the number,
    // and the H1 is the file's own title by convention. `id: MY-THING` under
    // `# ADR-0040 considered harmful` has the same shape and still becomes
    // ADR-0040; telling the two apart needs a rule about what follows the
    // identifier that no repository has written down, which is the trade
    // ADR-0009 declined for `<dl>`.
    const identity = identify({
      path: 'docs/adr/sharding.md',
      declaredId: 'sharding',
      declaredAliases: [],
      heading: 'ADR-0007: Sharding the write path',
    });
    expect(identity.id).toBe('ADR-0007');
    expect(identity.aliases).toContain('sharding');
  });

  it('holds that limit to files, and not to the rows of a register', () => {
    // The same three inputs on a region go the other way, because a row's id
    // column exists to hold an identifier while its title cell is prose about
    // the rest of the corpus. This is the whole fix: it is the shape every one
    // of the 27 misfiled rows had.
    const identity = identify({
      path: 'docs/adr/sharding.md',
      declaredId: 'sharding',
      declaredAliases: [],
      heading: 'ADR-0007: Sharding the write path',
      includePathAliases: false,
    });
    expect(identity.id).toBe('sharding');
    expect(identity.aliases).not.toContain('adr0007');
  });

  it('drops the title alias once the file name has named the document', () => {
    // No declaration is involved here: the file name named it, so the H1 is
    // already prose, and `adr0040` as an alias of ADR-0007 is a citation of
    // ADR-0040 arriving at the wrong document.
    const identity = identify({
      path: 'docs/adr/0007-sharding.md',
      declaredId: null,
      declaredAliases: [],
      heading: 'ADR-0040 considered harmful',
    });
    expect(identity.id).toBe('ADR-0007');
    expect(identity.aliases).not.toContain('adr0040');
  });

  it('reads a region without reading the file it sits in', () => {
    // ADR-0009 says a region does not claim the file's path. The file's name is
    // the same claim spelled differently: every row of a register kept in
    // `0042-open-issues.md` answered to ADR-0042, and so did the file.
    const identity = identify({
      path: 'docs/adr/0042-open-issues.md',
      declaredId: 'OI-V-05',
      declaredAliases: [],
      heading: 'Ordinary prose title',
      includePathAliases: false,
    });
    expect(identity.id).toBe('OI-V-05');
    expect(identity.number).toBeNull();
  });
});

describe('directives', () => {
  const parse = (md: string) => parseDirectives(scanMarkdown(md).comments);

  it('reads attributes in either quote style, and bare flags', () => {
    const [directive] = parse(`<!-- @spec-node id="ADR-1" title='One' kind -->`);
    expect(attr(directive!, 'id')?.value).toBe('ADR-1');
    expect(attr(directive!, 'title')?.value).toBe('One');
    expect(attr(directive!, 'kind')?.value).toBe('true');
  });

  it('reads a directive spread over several lines', () => {
    const [directive] = parse('<!-- @spec-node\n  id="ADR-1"\n  status="accepted"\n-->');
    expect(attr(directive!, 'status')?.value).toBe('accepted');
  });

  it('records the offset of a value so it can be pointed at', () => {
    const md = '<!-- @spec-node status="accepted" -->';
    const [directive] = parse(md);
    const found = attr(directive!, 'status');
    expect(md.slice(found?.start ?? 0, found?.end ?? 0)).toBe('accepted');
  });

  it('splits a list attribute', () => {
    const [directive] = parse('<!-- @spec-node aliases="a, b c;d" -->');
    expect(attrList(directive!, 'aliases')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores comments that are not directives', () => {
    expect(parse('<!-- an ordinary comment -->')).toHaveLength(0);
    expect(parse('<!-- @unrelated-tool foo="bar" -->')).toHaveLength(0);
  });

  it('reports an attribute the directive does not define', () => {
    const [directive] = parse('<!-- @spec-node id="ADR-1" colour="red" -->');
    expect(directive?.unknownAttributes).toEqual(['colour']);
  });

  it('returns null for a blank attribute', () => {
    const [directive] = parse('<!-- @spec-item state="  " -->');
    expect(attr(directive!, 'state')).toBeNull();
    expect(attr(directive!, 'missing')).toBeNull();
  });

  it('binds a directive to the region it annotates', () => {
    const md = ['<!-- @spec-item id="one" -->', '- [ ] first', '', '- [ ] second'].join('\n');
    const doc = scanMarkdown(md);
    const directives = parseDirectives(doc.comments);
    const first = doc.listItems[0];
    const second = doc.listItems[1];
    expect(directiveFor(directives, 'spec-item', { start: first!.start, end: first!.end }, 200)?.name).toBe('spec-item');
    // The look-behind must not reach past the item it belongs to.
    expect(directiveFor(directives, 'spec-item', { start: second!.start, end: second!.end }, 5)).toBeNull();
  });

  /** The id of the `@spec-item` bound to each list item, in document order. */
  const boundIds = (...lines: string[]): (string | null)[] => {
    const doc = scanMarkdown(lines.join('\n'));
    const bound = bindItemDirectives(doc, parseDirectives(doc.comments));
    // A directive that annotates nothing is left out, not bound to a missing item.
    expect([...bound.keys()].every((item) => doc.listItems.includes(item))).toBe(true);
    return doc.listItems.map((item) => {
      const directive = bound.get(item);
      return directive === undefined ? null : (attr(directive, 'id')?.value ?? null);
    });
  };

  it('binds a @spec-item to the item directly below it, and not to the one after', () => {
    expect(boundIds('<!-- @spec-item id="one" -->', '- [ ] first', '- [ ] second')).toEqual(['one', null]);
    expect(boundIds('<!-- @spec-item id="one" -->', '- [ ] first', '', '- [ ] second')).toEqual(['one', null]);
    expect(boundIds('<!-- @spec-item id="one" -->', '- [ ] first', '  - [ ] nested')).toEqual(['one', null]);
  });

  it('reaches the item below across blank lines and other comments, and across nothing else', () => {
    expect(boundIds('<!-- @spec-item id="one" -->', '', '<!-- prettier-ignore -->', '- [ ] first')).toEqual(['one']);
    expect(boundIds('> <!-- @spec-item id="one" -->', '> - [ ] first', '> - [ ] second')).toEqual(['one', null]);
    expect(boundIds('<!-- @spec-item id="one" -->', 'Prose.', '- [ ] first')).toEqual([null]);
    expect(boundIds('<!-- @spec-item id="one" -->', '## Next', '- [ ] first')).toEqual([null]);
    expect(boundIds('<!-- @spec-item id="one" -->', '```', '', '```', '- [ ] first')).toEqual([null]);
    // A <pre> block is no more Markdown than a fence is.
    expect(boundIds('<!-- @spec-item id="one" -->', '<pre>', '</pre>', '- [ ] first')).toEqual([null]);
    // Ending a paragraph, it stands above nothing, whatever follows the blank line.
    expect(boundIds('Prose. <!-- @spec-item id="one" -->', '', '- [ ] first')).toEqual([null]);
  });

  it('binds only @spec-item, so another directive above a bullet does not make it an obligation', () => {
    expect(boundIds('<!-- @spec-node id="ADR-0001" -->', '- first')).toEqual([null]);
  });

  it('does not bind a @spec-item to an item that ended before it', () => {
    expect(boundIds('- [ ] first', '', 'Prose. <!-- @spec-item id="one" -->')).toEqual([null]);
    expect(boundIds('- [ ] first', '', 'Prose.', '', '  - [ ] second', '  <!-- @spec-item id="two" -->')).toEqual([
      null,
      'two',
    ]);
  });

  it('binds a @spec-item written on an item, or indented under it, to that item and not the sibling below', () => {
    expect(boundIds('- [ ] first <!-- @spec-item id="one" -->', '- [ ] second')).toEqual(['one', null]);
    expect(boundIds('- [ ] first', '  <!-- @spec-item id="one" -->', '- [ ] second')).toEqual(['one', null]);
  });

  it('reads a @spec-item written flush between two items as the second one', () => {
    expect(boundIds('- [ ] first', '<!-- @spec-item id="two" -->', '- [ ] second')).toEqual([null, 'two']);
    // With no item below it, the line continues the item above.
    expect(boundIds('- [ ] first', '<!-- @spec-item id="one" -->')).toEqual(['one']);
  });

  it('keeps a parent and the item nested in it to their own @spec-item', () => {
    expect(
      boundIds('<!-- @spec-item id="parent" -->', '- [ ] parent', '  <!-- @spec-item id="child" -->', '  - [ ] child'),
    ).toEqual(['parent', 'child']);
    expect(boundIds('- [ ] parent', '  - [ ] child <!-- @spec-item id="child" -->')).toEqual([null, 'child']);
    // Indented to the parent's text and not the child's, it is the parent's.
    expect(
      boundIds('- [ ] parent', '  - [ ] child', '  <!-- @spec-item id="parent" -->', '- [ ] next'),
    ).toEqual(['parent', null, null]);
  });

  it('gives an item with two @spec-item directives above it the nearer one', () => {
    expect(boundIds('<!-- @spec-item id="far" -->', '<!-- @spec-item id="near" -->', '- [ ] first')).toEqual(['near']);
  });

  it('reads a directive from a comment, and nothing else the comment holds', () => {
    // The checklist commented out is not an item, so the directive above it
    // reaches across the comment to the item that is.
    expect(boundIds('<!-- @spec-item id="one" -->', '<!--', '- [ ] parked', '-->', '- [ ] first')).toEqual(['one']);
  });

  it('reads no directive from a comment that never closes', () => {
    // One that opens a line runs to the end of the document, and all of it
    // would be read as the directive's attributes.
    expect(parse('<!-- @spec-ignore\n\n# Title\n')).toHaveLength(0);
    expect(parse('<!-- @spec-node id="A" title=x\n\nkey=value\n')).toHaveLength(0);
    expect(parse('<!-- @spec-ignore -->\n\n# Title\n')).toHaveLength(1);
  });

  it('does not read a directive quoted in inline code', () => {
    // A document explaining the directive is not annotated by it. ADR-0011 and
    // the README both mark themselves records this way, if it is.
    expect(parse('Mark a log with `<!-- @spec-history -->` at its top.')).toHaveLength(0);
    expect(parse('Mark a log with ``<!-- @spec-history -->`` at its top.')).toHaveLength(0);
    expect(parse('A `span`, then <!-- @spec-history -->')).toHaveLength(1);
  });
});

describe('posix paths', () => {
  it('converts and normalises', () => {
    expect(toPosix('docs\\adr\\0007.md')).toBe('docs/adr/0007.md');
    expect(normalisePosix('docs/./adr/../adr/0007.md')).toBe('docs/adr/0007.md');
    expect(normalisePosix('../../a')).toBe('../../a');
    expect(normalisePosix('/a/b/../c')).toBe('/a/c');
  });

  it('resolves a link against the document that contains it', () => {
    expect(resolveFrom('docs/adr/0004.md', '0002.md')).toBe('docs/adr/0002.md');
    expect(resolveFrom('docs/adr/0004.md', '../rfcs/0001.md')).toBe('docs/rfcs/0001.md');
  });

  it('splits directory and base names', () => {
    expect(dirnamePosix('docs/adr/0007.md')).toBe('docs/adr');
    expect(dirnamePosix('0007.md')).toBe('');
    expect(basenamePosix('docs/adr/0007.md')).toBe('0007.md');
    expect(joinPosix('docs', 'adr', '0007.md')).toBe('docs/adr/0007.md');
  });
});

/* -------------------------------------------------------------------------- */

describe('relation vocabulary', () => {
  const fold = (key: string) => foldRelationKey(key);

  it('folds separators and case to one key', () => {
    const one = fold('depends-on');
    expect([fold('depends_on'), fold('dependsOn'), fold('Depends On'), fold('DEPENDS-ON')]).toEqual([
      one,
      one,
      one,
      one,
    ]);
  });

  it('keeps distinct relations distinct once folded', () => {
    const folded = Object.keys(RELATION_KEYS).map(fold);
    expect(new Set(folded).size).toBe(folded.length);
  });

  it('spells every directional relation in both directions', () => {
    // The invariant the mandate for this release was written about. A kind
    // spelled only one way silently drops the edges written the other way.
    const directions = new Map<EdgeKind, Set<boolean>>();
    for (const relation of Object.values(RELATION_KEYS)) {
      const seen = directions.get(relation.kind) ?? new Set<boolean>();
      seen.add(relation.inverted);
      directions.set(relation.kind, seen);
    }
    const oneWay = [...directions].filter(([, seen]) => seen.size < 2).map(([kind]) => kind);
    // `relates-to` is symmetric: there is no other direction to spell.
    // `contains` is structural and never written by hand, so it is not here.
    expect(oneWay).toEqual(['relates-to']);
  });
});

describe('near-miss keys', () => {
  it('counts a substitution, an insertion, a deletion and a swap as one edit', () => {
    expect(withinOneEdit('supercedesby', 'supercededby')).toBe(true);
    expect(withinOneEdit('dependson', 'dependsonn')).toBe(true);
    expect(withinOneEdit('dependson', 'depndson')).toBe(true);
    expect(withinOneEdit('dependson', 'depnedson')).toBe(true);
  });

  it('needs the two differences to be an actual swap', () => {
    // Two substitutions are two edits however adjacent they are, and a swap of
    // characters that are not adjacent is not a slip of the finger.
    expect(withinOneEdit('abcd', 'axyd')).toBe(false);
    expect(withinOneEdit('abcd', 'dbca')).toBe(false);
    expect(withinOneEdit('abcde', 'bacdx')).toBe(false);
    // In a swap both characters move. One landing where the other's neighbour
    // was is two substitutions that happen to share a letter.
    expect(withinOneEdit('ab', 'bc')).toBe(false);
    expect(withinOneEdit('ab', 'za')).toBe(false);
  });

  it('stops at one', () => {
    expect(withinOneEdit('dependson', 'dependson')).toBe(false);
    expect(withinOneEdit('categories', 'dependencies')).toBe(false);
    expect(withinOneEdit('tags', 'refs')).toBe(false);
    expect(withinOneEdit('dependson', 'dependsoff')).toBe(false);
    expect(withinOneEdit('abc', 'abcde')).toBe(false);
    // Two swaps are two edits, however adjacent each of them is.
    expect(withinOneEdit('abcd', 'badc')).toBe(false);
  });
});

describe('a declared id that is not a name', () => {
  it('is discarded rather than honoured', () => {
    // `id=\"ADR-9\"` inside a JavaScript string parses its bare value as a lone
    // backslash. A document whose id is punctuation collides with every other
    // one that made the same mistake and names itself in findings nobody can act
    // on, so the declaration loses to the file name.
    // The path must carry no number of its own, or the declaration never had a
    // chance to win and the test passes for the wrong reason.
    for (const junk of ['\\', '-', '---', '  ']) {
      expect(
        identify({ path: 'docs/sharding.md', declaredId: junk, declaredAliases: [], heading: null }).id,
        junk,
      ).toBe('sharding');
    }
    // And a real declaration still beats the file name.
    expect(identify({ path: 'docs/sharding.md', declaredId: 'ADR-7', declaredAliases: [], heading: null }).id)
      .toBe('ADR-7');
  });

  it('keeps a declaration in any script', () => {
    expect(identify({ path: 'docs/決策.md', declaredId: '決策-7', declaredAliases: [], heading: null }).id)
      .toBe('決策-7');
  });
});
