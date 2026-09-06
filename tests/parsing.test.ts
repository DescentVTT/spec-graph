import { describe, expect, it } from 'vitest';

import { attr, attrList, directiveFor, parseDirectives } from '../src/directives.js';
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
} from '../src/identity.js';
import { isStatusHeading, normaliseStatus, phaseFromPath, phaseOf, receptivityOf, supersessionTargetsIn } from '../src/lifecycle.js';
import { scanMarkdown } from '../src/markdown.js';
import { basenamePosix, dirnamePosix, joinPosix, normalisePosix, resolveFrom, toPosix } from '../src/paths.js';
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
