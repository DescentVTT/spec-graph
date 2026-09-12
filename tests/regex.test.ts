/**
 * Tests for the non-backtracking matcher.
 *
 * The heart of this file is not the unit tests, it is
 * `agrees with RegExp`: a hand-written engine replacing a built-in one has an
 * oracle available, so the useful question is not "does it do what I think" but
 * "does it do what the thing it replaced did". Every pattern here is run
 * through both and the answers compared, over a corpus written to be awkward
 * and over a generated one written to be unimaginative.
 *
 * The generator is seeded, so a failure reproduces. See ADR-0017.
 */

import { describe, expect, it } from 'vitest';

import { compilePattern, PatternError } from '../src/regex.js';

const test = (pattern: string, subject: string): boolean => compilePattern(pattern).test(subject);

/* -------------------------------------------------------------------------- */
/* The dialect                                                                */
/* -------------------------------------------------------------------------- */

describe('matching', () => {
  it('matches anywhere in the subject, like the .test() it replaced', () => {
    expect(test('adr', 'docs/adr/0001.md')).toBe(true);
    expect(test('^adr', 'docs/adr/0001.md')).toBe(false);
    expect(test('^docs', 'docs/adr/0001.md')).toBe(true);
    expect(test('md$', 'docs/adr/0001.md')).toBe(true);
    expect(test('md$', 'docs/adr/0001.md.bak')).toBe(false);
  });

  it('ignores case, because `~=` has always been a case-insensitive test', () => {
    expect(test('ADR', 'docs/adr/0001.md')).toBe(true);
    expect(test('[a-z]+', 'ADR')).toBe(true);
    expect(test('[^a-z]', 'ADR')).toBe(false);
  });

  it('reads the empty pattern as matching everything', () => {
    expect(test('', '')).toBe(true);
    expect(test('', 'anything')).toBe(true);
  });

  it('runs the classes, the quantifiers and the anchors', () => {
    expect(test('^\\d{4}$', '0007')).toBe(true);
    expect(test('^\\d{4}$', '007')).toBe(false);
    expect(test('^\\d{2,4}$', '007')).toBe(true);
    expect(test('^\\d{2,}$', '00071')).toBe(true);
    expect(test('^a?b+c*$', 'abbb')).toBe(true);
    expect(test('^(adr|rfc)-\\d+$', 'rfc-2119')).toBe(true);
    expect(test('^(adr|rfc)-\\d+$', 'kep-2119')).toBe(false);
    expect(test('\\bdraft\\b', 'a draft document')).toBe(true);
    expect(test('\\bdraft\\b', 'redrafted')).toBe(false);
    expect(test('\\Bdraft', 'redrafted')).toBe(true);
  });

  it('reads a group as a group and never as a capture', () => {
    // `(a)` and `(?:a)` and `(?<x>a)` are one automaton: nothing downstream can
    // ask what a group caught, so there is nothing for the name to label.
    for (const pattern of ['(ab)+$', '(?:ab)+$', '(?<pair>ab)+$']) {
      expect(test(pattern, 'xabab')).toBe(true);
      expect(test(pattern, 'xaba')).toBe(false);
    }
  });

  it('treats a lazy quantifier as its greedy twin', () => {
    // Laziness picks which match is found; this only reports whether one is.
    expect(test('^a+?$', 'aaa')).toBe(true);
    expect(test('^a{2,4}?$', 'aaa')).toBe(true);
  });

  it('keeps the JavaScript reading of an empty character class', () => {
    // Surprising, and what every engine does: the class closes at the first ],
    // so `[]` can never match and `[^]` always can.
    expect(test('[]', 'a')).toBe(false);
    expect(test('[^]', 'a')).toBe(true);
    expect(test('[]]', 'a]')).toBe(false);
  });

  it('keeps a hyphen that is not between two characters', () => {
    expect(test('^[-a]+$', '-a-')).toBe(true);
    expect(test('^[a-]+$', '-a-')).toBe(true);
    // Either side of a \d-style set has no endpoint, so the dash is literal.
    expect(test('^[\\d-x]+$', '7-x')).toBe(true);
    expect(test('^[\\d-x]+$', 'w')).toBe(false);
  });

  it('takes a quantifier on a group that holds only an assertion', () => {
    // `RegExp` rejects `\b*` and accepts `(\b)*`, which is the same nothing
    // said twice - a group makes its contents quantifiable. Repeating a
    // zero-width assertion is as meaningless as it sounds, and both engines
    // read it as matching the empty string. Found by probing the degenerate
    // shapes a pattern generator will never produce.
    expect(test('(\\b)*a', 'a')).toBe(true);
    expect(new RegExp('(\\b)*a', 'i').test('a')).toBe(true);
    expect(() => compilePattern('\\b*a')).toThrow(PatternError);
    expect(() => compilePattern('^*a')).toThrow(PatternError);
  });

  it('reads a brace that opens nothing as a brace', () => {
    // `{0}` is what a project-rule message is made of, and a pattern written
    // against one has to be able to say so.
    expect(test('^a{$', 'a{')).toBe(true);
    expect(test('\\{0\\}', 'owner is {0}')).toBe(true);
    expect(test('[{]0[}]', 'owner is {0}')).toBe(true);
  });

  it('does not treat a lone \\r or \\n as matched by a dot', () => {
    expect(test('^a.b$', 'a\nb')).toBe(false);
    expect(test('^a.b$', 'a\rb')).toBe(false);
    expect(test('^a[\\s\\S]b$', 'a\nb')).toBe(true);
  });

  it('anchors to the whole subject, not to a line', () => {
    // No `m` flag, which is what `new RegExp(source, 'i')` gave and what a
    // predicate over a multi-line body needs to keep meaning.
    expect(test('^b', 'a\nb')).toBe(false);
    expect(test('a$', 'a\nb')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The bound this exists for                                                  */
/* -------------------------------------------------------------------------- */

describe('termination', () => {
  /**
   * A blow-up detector, not a benchmark.
   *
   * The pattern below takes V8 0.9 seconds on the first subject and 103 on the
   * third; this matcher takes 11 and 13 microseconds. The bound is generous on
   * purpose - eight Stryker workers share this machine - and the failure being
   * guarded against is seven orders of magnitude away from it.
   */
  const BLOW_UP = 2000;

  it('finishes on the pattern that hangs a backtracking engine', () => {
    const pattern = '^([A-Za-z0-9_]+[ ]?)+$';
    const subjects = [
      'the quick brown fox jumps over the lazy dog!',
      'the quick brown fox jumps over the lazy dog and!',
      'the quick brown fox jumps over the lazy dog and keeps!',
      `${'word '.repeat(200)}!`,
    ];
    const started = performance.now();
    for (const subject of subjects) expect(test(pattern, subject)).toBe(false);
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
  });

  it('finishes on the other shapes that are classically catastrophic', () => {
    const started = performance.now();
    expect(test('^(a+)+$', `${'a'.repeat(2000)}b`)).toBe(false);
    expect(test('^(a|a)+$', `${'a'.repeat(2000)}b`)).toBe(false);
    expect(test('^(a*)*$', `${'a'.repeat(2000)}b`)).toBe(false);
    expect(test('^(?:a|aa)+$', `${'a'.repeat(2000)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
  });

  it('terminates on a nullable body under a star', () => {
    // `(a?)*` can loop forever on an engine that does not mark where it has
    // been. The visited stamp is what makes this return at all.
    expect(test('^(a?)*$', 'aaa')).toBe(true);
    expect(test('^(|a)*$', 'aaa')).toBe(true);
    expect(test('^(a?b?)*$', 'ab')).toBe(true);
  });

  it('rejects a pattern too large to compile by copying', () => {
    expect(() => compilePattern('(a{99}){99}')).toThrow(PatternError);
    // The bound is on the compiled automaton, so a long pattern that compiles
    // small is fine.
    expect(compilePattern('a'.repeat(2000)).size).toBe(2001);
  });

  it('stays small for the patterns this repository actually writes', () => {
    // The comment on MAX_PROGRAM claims a number; this is where it comes from.
    const sizes = ['000[23]', 'adr-000.', '^([A-Za-z0-9_]+[ ]?)+$', '^(adr|rfc)-\\d+$'].map(
      (pattern) => compilePattern(pattern).size,
    );
    expect(Math.max(...sizes)).toBe(17);
  });
});

/* -------------------------------------------------------------------------- */
/* What it will not run                                                       */
/* -------------------------------------------------------------------------- */

describe('rejection', () => {
  const rejects = (pattern: string, fragment: string): void => {
    let thrown: unknown;
    try {
      compilePattern(pattern);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${pattern} should not compile`).toBeInstanceOf(PatternError);
    expect((thrown as PatternError).message).toContain(fragment);
  };

  it('refuses the constructs that are not regular', () => {
    rejects('(?=a)b', 'lookaround');
    rejects('(?!a)b', 'lookaround');
    rejects('(?<=a)b', 'lookaround');
    rejects('(?<!a)b', 'lookaround');
    rejects('(a)\\1', 'backreference');
    rejects('(?<x>a)\\k<x>', 'backreference');
  });

  it('refuses what it has no table for', () => {
    rejects('\\p{Letter}', 'Unicode');
    rejects('\\P{Letter}', 'Unicode');
  });

  it('refuses the escapes RegExp reads as a letter', () => {
    // `/\A/` matches a capital A, and `/\z/` a lower-case z. Anybody who typed
    // those meant an anchor, and would never have found out.
    rejects('\\Aadr', 'unknown escape');
    rejects('adr\\z', 'unknown escape');
    rejects('\\Q.\\E', 'unknown escape');
  });

  it('refuses malformed syntax instead of guessing at Annex B', () => {
    rejects('(a', 'unmatched "("');
    rejects('a)', 'unmatched ")"');
    rejects('[a', 'unterminated character class');
    rejects('[z-a]', 'out of order');
    rejects('a{3,1}', 'out of order');
    rejects('*a', 'nothing to repeat');
    rejects('+', 'nothing to repeat');
    rejects('^*', 'nothing to repeat');
    rejects('a\\', 'ends with a backslash');
    rejects('\\xZZ', 'hex digits');
    rejects('\\u00', 'hex digits');
    rejects('\\c1', 'letter after');
    rejects('\\07', 'octal');
    rejects('[\\B]', 'not a character');
    rejects('(?#comment)', 'unsupported group');
  });

  it('says where, not just what', () => {
    const error = (() => {
      try {
        compilePattern('ab(?=c)');
        return null;
      } catch (thrown) {
        return thrown as PatternError;
      }
    })();
    expect(error?.offset).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The oracle                                                                 */
/* -------------------------------------------------------------------------- */

/** Subjects chosen to sit on boundaries rather than in the middle of them. */
const SUBJECTS: readonly string[] = [
  '',
  'a',
  'A',
  'ab',
  'aB',
  'abc',
  'aaa',
  'aaab',
  '0007',
  'ADR-0007',
  'adr_0007',
  'docs/adr/0001-hand-written.md',
  'the quick brown!',
  '   ',
  '-',
  '--',
  '-a-',
  ']',
  'a-b',
  '[]',
  '{0}',
  'a\nb',
  'a\rb',
  'a\tb',
  '\u00e9\u00c9',
  '\u4e2d\u6587',
  'stra\u00dfe',
  'a'.repeat(40),
  'ab'.repeat(20),
];

/** Patterns written to be awkward, including every construct that is supported. */
const PATTERNS: readonly string[] = [
  '',
  'a',
  'A',
  'abc',
  'a|b',
  'a|',
  '|a',
  '^a',
  'a$',
  '^a$',
  '^$',
  '.',
  '^.$',
  '^..$',
  'a.c',
  'a*',
  'a+',
  'a?',
  '^a*$',
  '^a+$',
  '^a?$',
  '^a{2}$',
  '^a{2,}$',
  '^a{0,2}$',
  '^a{2,4}$',
  '^a{0}$',
  '^(a){2}$',
  '^(ab){2}$',
  '^(a|b){2,3}$',
  '^a+?$',
  '^a*?b??$',
  '(a+)+$',
  '(a|a)+$',
  '(a*)*$',
  '^(a?)*$',
  '[abc]',
  '[^abc]',
  '[a-c]',
  '[^a-c]',
  '[a-cx-z]',
  '[]',
  '[^]',
  '[]]',
  '[-a]',
  '[a-]',
  '[a\\-c]',
  '\\d',
  '\\D',
  '\\w',
  '\\W',
  '\\s',
  '\\S',
  '^\\d+$',
  '^\\w+$',
  '^\\s*$',
  '[\\d]',
  '[\\D]',
  '[\\w\\s]',
  '[^\\d]',
  '[\\d-x]',
  '\\b',
  '\\ba',
  'a\\b',
  '\\Ba',
  '\\bADR\\b',
  '\\.',
  '\\*',
  '\\[',
  '\\]',
  '\\{',
  '\\}',
  '\\|',
  '\\\\',
  '\\/',
  '\\n',
  '\\r',
  '\\t',
  '\\f',
  '\\v',
  '\\0',
  '\\x41',
  '\\u0041',
  '\\u00e9',
  '\\cA',
  '[\\b]',
  '(?:a|b)c',
  '(?<name>a)b',
  '((a))',
  '(a|(b|c))d',
  '^(?:adr|rfc)[-_ ]?\\d{1,6}$',
  '^[A-Za-z0-9_]+([ ][A-Za-z0-9_]+)*$',
  '^([A-Za-z0-9_]+[ ]?)+$',
  '000[23]',
  'adr-000.',
  '^\\s*[*_]{0,2}status[*_]{0,2}\\s*:',
  '[\\u00e0-\\u00ff]',
  '[\\u4e00-\\u9fff]+',
  '\\u00df',
  // Degenerate shapes, which is where two engines actually differ. A grammar
  // that generates patterns will not produce an empty group, an alternation
  // with nothing on one side, or a class whose first character closes it, and
  // those are exactly the corners where somebody's reading of Annex B shows.
  '()',
  '()*',
  '()+',
  '(|)',
  '(|)*',
  '(?:)',
  '(?:)*',
  '(()())',
  '^()$',
  '^(?:|a)+$',
  '^(?:a|)*$',
  '((a?)*)*',
  '(\\b)*a',
  '(^)?a',
  'a||b',
  '|',
  '||',
  '^^a$$',
  '\\B\\B',
  '[a-a]',
  '[]-a]',
  '[^]a]',
  '[\\d-\\w]',
  '[\\s\\S]*',
  '[^\\s\\S]',
  'a{0,0}',
  'a{0}b',
  '(a{0})*',
];

describe('agrees with RegExp', () => {
  /**
   * The comparison.
   *
   * Disagreements are collected rather than asserted one at a time, so a
   * failure names every pattern and subject that differ instead of the first.
   */
  const compare = (patterns: readonly string[], subjects: readonly string[]): string[] => {
    const disagreements: string[] = [];
    for (const pattern of patterns) {
      const mine = compilePattern(pattern);
      const theirs = new RegExp(pattern, 'i');
      for (const subject of subjects) {
        const a = mine.test(subject);
        const b = theirs.test(subject);
        if (a !== b) disagreements.push(`/${pattern}/i against ${JSON.stringify(subject)}: ${a} vs ${b}`);
      }
    }
    return disagreements;
  };

  it('on a corpus written to be awkward', () => {
    expect(compare(PATTERNS, SUBJECTS)).toEqual([]);
  });

  it('on every pattern V8 also accepts', () => {
    // The hand-written corpus is only as good as the imagination behind it, so
    // the whole list is checked for the other direction too: a pattern this
    // engine refuses that V8 accepts is a dialect difference, and every one of
    // them is supposed to be in the `rejection` block above with a reason.
    const surprises = PATTERNS.filter((pattern) => {
      try {
        compilePattern(pattern);
        return false;
      } catch {
        return true;
      }
    });
    expect(surprises).toEqual([]);
  });

  /* ------------------------------------------------------------------------ */

  /**
   * A generated corpus, because a hand-written one tests what its author
   * thought of.
   *
   * Seeded and therefore reproducible: the same patterns are compared on every
   * machine and every run, which is what makes this a gate rather than a
   * lottery. Subjects stay short because V8 is the oracle here, and a long one
   * against a generated `(a+)+` would hang the test rather than the tool.
   */
  const random = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    };
  };

  const generate = (next: () => number, depth: number): string => {
    const pick = <T>(options: readonly T[]): T => options[Math.floor(next() * options.length)] as T;
    const atoms = ['a', 'b', 'c', '0', '_', '-', ' ', '.', '\\d', '\\w', '\\s', '[abc]', '[^ab]', '[a-c]', '[0-9_]'];
    const quantifiers = ['', '', '', '*', '+', '?', '{2}', '{1,2}', '{0,3}', '{2,}', '*?', '+?'];

    if (depth <= 0) return pick(atoms) + pick(quantifiers);

    const shape = Math.floor(next() * 5);
    if (shape === 0) return `${generate(next, depth - 1)}${generate(next, depth - 1)}`;
    if (shape === 1) return `(?:${generate(next, depth - 1)}|${generate(next, depth - 1)})${pick(quantifiers)}`;
    if (shape === 2) return `(${generate(next, depth - 1)})${pick(quantifiers)}`;
    if (shape === 3) return `${pick(['^', '\\b', ''])}${generate(next, depth - 1)}${pick(['$', '\\b', ''])}`;
    return pick(atoms) + pick(quantifiers) + generate(next, depth - 1);
  };

  it('on a thousand generated patterns', () => {
    const next = random(0x5eed);
    const patterns: string[] = [];
    for (let i = 0; i < 1000; i += 1) patterns.push(generate(next, 3));
    const subjects = ['', 'a', 'ab', 'abc', 'aab', '0_a', 'a b', 'a-b', 'aaaa', 'abcabc', 'a.b', 'AB'];

    // A generated pattern that either engine refuses is a bug in the
    // generator, not a finding, so it is surfaced rather than skipped.
    const refused = patterns.filter((pattern) => {
      try {
        new RegExp(pattern, 'i');
        compilePattern(pattern);
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
    expect(compare(patterns, subjects)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Where the two deliberately differ                                          */
/* -------------------------------------------------------------------------- */

describe('the one divergence', () => {
  it('folds a single character exactly and a range by its case forms', () => {
    // U+00B5 MICRO SIGN and U+03BC GREEK SMALL MU both upper-case to U+039C, so
    // a case-insensitive engine treats them as the same character. Asked as a
    // single character, this agrees.
    expect(test('\u00b5', '\u03bc')).toBe(true);
    expect(new RegExp('\u00b5', 'i').test('\u03bc')).toBe(true);

    // Asked as a *range*, it does not: answering exactly would need a fold
    // table for all 65,536 code units, to decide a question no selector over a
    // Markdown corpus has ever asked. Pinned here so it stays a decision.
    expect(test('[\u00b4-\u00b6]', '\u03bc')).toBe(false);
    expect(new RegExp('[\u00b4-\u00b6]', 'i').test('\u03bc')).toBe(true);
  });

  it('keeps the specification rule that upper-casing must not reach into ASCII', () => {
    // U+017F upper-cases to "S", and the clause that stops it matching one is
    // the one everybody leaves out - including the first draft of this module,
    // which also read it as a word character for \b. Both engines say no, and
    // the oracle is the reason this is a test rather than a comment claiming it.
    expect(test('s', '\u017f')).toBe(false);
    expect(new RegExp('s', 'i').test('\u017f')).toBe(false);
    expect(test('\\b\u017f\\b', ` \u017f `)).toBe(false);
    expect(new RegExp('\\b\u017f\\b', 'i').test(` \u017f `)).toBe(false);
    // U+212A, the Kelvin sign, is the same case reached from the other end.
    expect(test('k', '\u212a')).toBe(false);
    expect(new RegExp('k', 'i').test('\u212a')).toBe(false);
  });
});
