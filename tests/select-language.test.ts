import { describe, expect, it } from 'vitest';

import { parseQuery, QueryError, type StepSpec } from '../src/select.js';

/**
 * The selector grammar, read on its own.
 *
 * This file imports the parser and nothing else, and that is what it is for.
 * `rules.ts` parses its two selectors when it is imported, so a parser fault
 * that breaks either of them fails every test file reaching the runner before
 * one of its tests has run - and a file that fails to load fails no test.
 * Stryker counted each such mutant a survivor: the constructor emptied,
 * whitespace no longer skipped, the node-type table cleared, about seventy in
 * one sweep, none of which a user could have missed. Here nothing can fail
 * before the grammar is asked. Keep the imports to `select.ts`.
 *
 * Expectations come from the README's grammar and the parser's own usage
 * errors, which the CLI prints with a caret under `offset`.
 */

/** The usage error a selector is refused with. */
const failure = (selector: string): QueryError => {
  try {
    parseQuery(selector);
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error(`"${selector}" parsed`);
};

const step = (selector: string, index = 0): StepSpec | undefined => parseQuery(selector).steps[index];

describe('node types', () => {
  it('reads each node type the grammar names, in any case', () => {
    const KINDS: readonly (readonly [string, 'document' | 'item' | null])[] = [
      ['document', 'document'],
      ['documents', 'document'],
      ['doc', 'document'],
      ['docs', 'document'],
      ['item', 'item'],
      ['items', 'item'],
      ['node', null],
      ['nodes', null],
      ['any', null],
      ['*', null],
    ];
    for (const [word, kind] of KINDS) {
      expect(parseQuery(word)).toEqual({ start: { kind, predicates: [] }, steps: [] });
      expect(parseQuery(word.toUpperCase()).start.kind).toBe(kind);
    }
  });

  it('starts at a predicate when no type is named, and then matches either kind', () => {
    expect(parseQuery('[phase=active]')).toEqual({
      start: { kind: null, predicates: [{ key: 'phase', operator: '=', value: 'active' }] },
      steps: [],
    });
    expect(parseQuery('[title*=draft]').start).toEqual({
      kind: null,
      predicates: [{ key: 'title', operator: '*=', value: 'draft' }],
    });
    expect(step('document -assumes-> [phase=retired]')?.node).toEqual({
      kind: null,
      predicates: [{ key: 'phase', operator: '=', value: 'retired' }],
    });
  });

  it('refuses what is neither a type nor a predicate, at the character', () => {
    const error = failure('7 -assumes-> document');
    expect(error.message).toBe('expected a node type (document, item or *) or a [predicate]');
    expect(error.offset).toBe(0);
  });

  it('names the real types when it meets an unknown one, where it meets it', () => {
    const error = failure('document -assumes-> widget');
    expect(error.message).toBe('unknown node type "widget", expected one of: document, item, * (any)');
    expect(error.offset).toBe(20);
  });

  it('reports a usage error as a QueryError, by name as well as by class', () => {
    // A caller that logs or serialises the error sees the name, not the class.
    const error = failure('widget');
    expect(error.name).toBe('QueryError');
    expect(String(error)).toBe(`QueryError: ${error.message}`);
  });
});

describe('predicates', () => {
  it('reads every operator the grammar has', () => {
    for (const operator of ['=', '!=', '^=', '$=', '*=', '~='] as const) {
      expect(parseQuery(`document[title${operator}draft]`).start.predicates).toEqual([
        { key: 'title', operator, value: 'draft' },
      ]);
    }
  });

  it('reads a key in any case, with the characters a front-matter key uses', () => {
    expect(parseQuery('document[FM.Review_Board-Chair=ops]').start.predicates[0]?.key).toBe('fm.review_board-chair');
  });

  it('reads predicates side by side as one conjunction', () => {
    expect(parseQuery('document[phase=active][id$=0004][fm.owner]').start.predicates).toEqual([
      { key: 'phase', operator: '=', value: 'active' },
      { key: 'id', operator: '$=', value: '0004' },
      { key: 'fm.owner', operator: 'exists', value: '' },
    ]);
  });

  it('reads an unquoted value up to the bracket, slashes and all', () => {
    expect(parseQuery('*[path^=docs/adr] -blocked-by-> item').start.predicates).toEqual([
      { key: 'path', operator: '^=', value: 'docs/adr' },
    ]);
  });

  it('refuses a predicate with no key', () => {
    const error = failure('document[=active]');
    expect(error.message).toBe('expected an attribute name after "["');
    expect(error.offset).toBe(9);
  });

  it('refuses an operator the grammar does not have, rather than reading part of it', () => {
    // There is no numeric comparison. Reading the `=` of `>=` would compare
    // the line with the text "=10" and match nothing, silently.
    const error = failure('document[line>=10]');
    expect(error.message).toBe('expected an operator (=, !=, ^=, $=, *=, ~=) or "]" after "line"');
    expect(error.offset).toBe(13);
  });

  it('refuses a predicate that is never closed', () => {
    const error = failure('document[phase=active');
    expect(error.message).toBe('expected "]" to close the predicate');
    expect(error.offset).toBe(21);
  });

  it('points past the end at a quote that is never closed', () => {
    const selector = 'document[title="unterminated';
    const error = failure(selector);
    expect(error.message).toBe('unterminated quoted value');
    expect(error.offset).toBe(selector.length);
  });

  it('reads only `~=` as a pattern', () => {
    // `C++` is not a regular expression, and nothing but `~=` asks for one.
    expect(parseQuery('document[title*=C++]').start.predicates[0]?.value).toBe('C++');
    expect(() => parseQuery('document[title~=C++]')).toThrow(QueryError);
  });

  it('points at the character of a pattern that failed, however it was quoted', () => {
    for (const selector of ['document[id~=ab(c]', "document[id~='ab(c']", 'document[id~="ab(c"]']) {
      expect(selector[failure(selector).offset]).toBe('(');
    }
  });
});

describe('steps', () => {
  it('reads every arrow form, spaced or not', () => {
    const FORMS: readonly (readonly [string, StepSpec])[] = [
      ['document -assumes-> item', { direction: 'out', kinds: ['assumes'], transitive: false, node: { kind: 'item', predicates: [] } }],
      ['document =supersedes=> document', { direction: 'out', kinds: ['supersedes'], transitive: true, node: { kind: 'document', predicates: [] } }],
      ['item <-delegates-to- document', { direction: 'in', kinds: ['delegates-to'], transitive: false, node: { kind: 'document', predicates: [] } }],
      ['document <=supersedes= *', { direction: 'in', kinds: ['supersedes'], transitive: true, node: { kind: null, predicates: [] } }],
      ['document-assumes->item', { direction: 'out', kinds: ['assumes'], transitive: false, node: { kind: 'item', predicates: [] } }],
      ['document<-assumes-item', { direction: 'in', kinds: ['assumes'], transitive: false, node: { kind: 'item', predicates: [] } }],
      ['document <-assumes-[phase=draft]', { direction: 'in', kinds: ['assumes'], transitive: false, node: { kind: null, predicates: [{ key: 'phase', operator: '=', value: 'draft' }] } }],
    ];
    for (const [selector, expected] of FORMS) expect(step(selector)).toEqual(expected);
  });

  it('reads a relation list in any case', () => {
    expect(step('document -Assumes,DEPENDS-ON-> document')?.kinds).toEqual(['assumes', 'depends-on']);
    expect(step('document <-Delegates-To,blocked-by- item')?.kinds).toEqual(['delegates-to', 'blocked-by']);
  });

  it('ignores a stray comma in a relation list', () => {
    expect(step('document -assumes,-> document')?.kinds).toEqual(['assumes']);
  });

  it('reads a chain of steps, with space around it or not', () => {
    const spec = parseQuery('  document -contains-> item   -delegates-to-> document[phase=retired]  ');
    expect(spec.start.kind).toBe('document');
    expect(spec.steps.map((s) => [s.kinds, s.node.kind])).toEqual([
      [['contains'], 'item'],
      [['delegates-to'], 'document'],
    ]);
  });

  it('asks for the node a step is missing, in either direction', () => {
    for (const selector of ['document -assumes->', 'document <-assumes-']) {
      const error = failure(selector);
      expect(error.message).toBe('expected a node type (document, item or *) or a [predicate]');
      expect(error.offset).toBe(selector.length);
    }
  });

  it('refuses words where a step belongs, even with an arrow after them', () => {
    for (const selector of ['document then -assumes-> document', 'document then <-assumes- document', 'document depends-on-> document']) {
      const error = failure(selector);
      expect(error.message).toBe('expected a relation step such as -delegates-to->, <-assumes- or =supersedes=>');
      expect(error.offset).toBe(9);
    }
  });

  it('refuses a mismatched arrow in either direction', () => {
    expect(failure('document -supersedes=> document').message).toBe(
      'mismatched arrow: use -kind-> for one hop or =kind=> for transitive',
    );
    expect(failure('document =supersedes-> document').message).toBe(
      'mismatched arrow: use -kind-> for one hop or =kind=> for transitive',
    );
    for (const selector of ['document <-supersedes= document', 'document <=supersedes- document']) {
      const error = failure(selector);
      expect(error.message).toBe('mismatched arrow: use <-kind- for one hop or <=kind= for transitive');
      expect(error.offset).toBe(9);
    }
  });

  it('points at an unknown relation and lists the real ones, in either direction', () => {
    for (const selector of ['document -invents-> document', 'document <-invents- document', 'document =invents=> document']) {
      const error = failure(selector);
      expect(selector.slice(error.offset)).toMatch(/^invents/);
      expect(error.message).toMatch(/^unknown relation "invents", expected one of: (?:[a-z-]+, )+[a-z-]+$/);
      for (const kind of ['assumes', 'depends-on', 'blocked-by', 'amends', 'delegates-to', 'relates-to', 'supersedes']) {
        expect(error.message).toContain(kind);
      }
    }
  });
});
