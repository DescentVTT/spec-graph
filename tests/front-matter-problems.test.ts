import { describe, expect, it } from 'vitest';

import { extractDocument, type ExtractedDocument } from '../src/extract.js';
import type { SourceRef } from '../src/types.js';
import { parseFrontMatter } from '../src/yaml.js';

/**
 * Front matter that was not read: what it costs, and where the report points.
 *
 * ADR-0023: a line that is not `key: value`, a line indented under no key and a
 * key written twice are parse problems, like a value the reader does not read.
 * Most can wait for `--verbose`. One that left out a status, an id, an alias or
 * a relation cannot, and is counted on every run. A line that names no key
 * could have held any of them, so it counts; a key written twice left nothing
 * out, because the last one still wins.
 */

function extract(text: string): ExtractedDocument {
  const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text });
  if (extracted === null) throw new Error('opted out');
  return extracted;
}

const covered = (text: string, at: SourceRef): string => text.slice(at.span.start.offset, at.span.end.offset);

const block = (...lines: string[]): string => ['---', ...lines, '---', '', '# ADR-0001: A', ''].join('\n');

describe('a front-matter line that was not read', () => {
  // Each block holds one line with a problem. `counted` is whether a default
  // run counts it as something the graph lost.
  const cases = [
    { name: 'a status indented under no key', lines: ['status: accepted', '# a note', '  status: draft'], counted: true },
    { name: 'a title indented under no key', lines: ['status: accepted', '# a note', '  title: B'], counted: false },
    { name: 'a title spaced before its colon', lines: ['status: accepted', '# a note', '  Title : B'], counted: false },
    { name: 'a line that is not key: value', lines: ['title: A', '# a note', '- title: B'], counted: true },
    { name: 'a status written twice', lines: ['status: draft', 'status: accepted'], counted: false },
    // A key of any script is named as spec-core's reader takes one, and one
    // that is none of the keys read is lost to nobody; a line with a
    // full-width colon names no key, and could have held anything.
    { name: 'a key in Han characters indented under no key', lines: ['status: accepted', '# a note', '  狀態: 草案'], counted: false },
    { name: 'a key in Han characters with a full-width colon', lines: ['status: accepted', '標題：B'], counted: true },
    // A leading `_`, and a combining acute accent, a digit, `_`, `-` and `.`
    // inside, are all part of the key.
    {
      name: 'a title with every kind of character a key holds',
      lines: ['status: accepted', '# a note', `  _ti${String.fromCodePoint(0x301)}tulo_2-a.b: B`],
      counted: false,
    },
  ];

  for (const { name, lines, counted } of cases) {
    it(`${counted ? 'counts' : 'does not count'} ${name}, and points at the whole line`, () => {
      const text = block(...lines);
      const problems = extract(text).problems;
      expect(problems, name).toHaveLength(1);
      const [problem] = problems as [ExtractedDocument['problems'][number]];
      expect(problem.message, name).toMatch(/^front matter: /);
      expect(problem.unread === true, name).toBe(counted);
      expect(covered(text, problem.at), name).toBe(lines[lines.length - 1]);
    });
  }

  it('counts front matter never closed, and points at the line that opened it', () => {
    // Which line was meant to close it is a guess, and the opener is not, so
    // the report points there.
    const text = '---\nstatus: accepted\n....\n\n# ADR-0001: A\n';
    const problems = extract(text).problems;
    expect(problems).toHaveLength(1);
    const [problem] = problems as [ExtractedDocument['problems'][number]];
    expect(problem.message).toMatch(/^front matter: opened here and never closed/);
    expect(problem.unread).toBe(true);
    expect(covered(text, problem.at)).toBe('---');
  });

  it('reads a key of any script, so a key in Han characters is no problem', () => {
    // It was the problem `not a "key: value" line`.
    const { document, problems } = extract(block('標題: A'));
    expect(problems).toEqual([]);
    expect(document.frontMatter['標題']).toBe('A');
  });

  it('reads the last of a key written twice', () => {
    expect(extract(block('status: draft', 'status: accepted')).document.frontMatter['status']).toBe('accepted');
  });
});

describe('a nested mapping', () => {
  it('is read one level deep, as parent.child', () => {
    const { document, problems } = extract(block('status: accepted', 'review:', '  owner: alice', '  due: 2026-10-01'));
    expect(problems).toEqual([]);
    expect(document.frontMatter).toMatchObject({ 'review.owner': 'alice', 'review.due': '2026-10-01' });
  });
});

describe('the offsets parseFrontMatter returns', () => {
  it('address the key in the containing file, as they address the value', () => {
    const raw = 'title: A\nstatus: accepted\n';
    const entry = parseFrontMatter(raw, 100).find((e) => e.key === 'status');
    expect(entry).toBeDefined();
    expect(raw.slice((entry?.start ?? 0) - 100, (entry?.end ?? 0) - 100)).toBe('status: accepted');
  });
});
