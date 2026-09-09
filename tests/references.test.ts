import { describe, expect, it } from 'vitest';

import { createReferenceFilter } from '../src/glob.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { RuleId } from '../src/types.js';

/**
 * Concept wiki-links, and the filter that lets a repository declare them.
 *
 * `[[trap 55]]` and `[[0007-sharding]]` are the same syntax carrying different
 * intent, and the link itself says nothing about which. See ADR-0008.
 */

const analyse = (files: Record<string, string>, ignoreReferences: readonly string[] = []) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    { isIgnoredReference: createReferenceFilter(ignoreReferences) },
  );

const rules = (files: Record<string, string>, ignore: readonly string[] = []): RuleId[] =>
  analyse(files, ignore).diagnostics.map((d) => d.rule);

/* -------------------------------------------------------------------------- */

describe('the reference filter', () => {
  it('matches nothing when there are no patterns', () => {
    const filter = createReferenceFilter([]);
    expect(filter('anything')).toBe(false);
  });

  it('ignores blank patterns rather than matching everything', () => {
    // A trailing comma in a config, or an empty --ignore-ref, must not silence
    // the entire corpus.
    const filter = createReferenceFilter(['', '   ']);
    expect(filter('trap 55')).toBe(false);
    expect(filter('')).toBe(false);
  });

  it('matches a literal name exactly, not as a prefix', () => {
    const filter = createReferenceFilter(['services']);
    expect(filter('services')).toBe(true);
    expect(filter('services-plan')).toBe(false);
    expect(filter('my services')).toBe(false);
  });

  it('matches a wildcard family', () => {
    const filter = createReferenceFilter(['trap *']);
    expect(filter('trap 55')).toBe(true);
    expect(filter('trap 1')).toBe(true);
    expect(filter('trap')).toBe(false);
    expect(filter('ADR-0007')).toBe(false);
  });

  it('is case-insensitive on every platform', () => {
    // Path matching follows the host filesystem, which is right for paths. A
    // repository's findings must not depend on which machine ran the check.
    const filter = createReferenceFilter(['Trap *']);
    expect(filter('trap 55')).toBe(true);
    expect(filter('TRAP 55')).toBe(true);
  });

  it('trims the target and the pattern', () => {
    expect(createReferenceFilter(['  trap *  '])('  trap 55  ')).toBe(true);
  });

  it('accepts several patterns', () => {
    const filter = createReferenceFilter(['trap *', 'services', 'Q-*']);
    expect(filter('trap 8')).toBe(true);
    expect(filter('services')).toBe(true);
    expect(filter('Q-17')).toBe(true);
    expect(filter('ADR-0007')).toBe(false);
  });

  it('supports brace and class syntax, like every other pattern here', () => {
    expect(createReferenceFilter(['{trap,pitfall} *'])('pitfall 3')).toBe(true);
    expect(createReferenceFilter(['trap [0-9]'])('trap 7')).toBe(true);
    expect(createReferenceFilter(['trap [0-9]'])('trap 77')).toBe(false);
  });
});

describe('concept wiki-links', () => {
  const briefs = {
    'docs/adr/0001-a.md': [
      '---',
      'status: accepted',
      '---',
      '',
      '# A',
      '',
      'This is exactly [[trap 55]], and it is why [[trap 54]] exists.',
    ].join('\n'),
  };

  it('are reported by default, because a wiki link is still a link', () => {
    // The default must not be weakened: in a vault, `[[...]]` names a document
    // and an unresolved one is a genuine break.
    const found = analyse(briefs).diagnostics;
    expect(found.map((d) => d.rule)).toEqual(['broken-reference', 'broken-reference']);
  });

  it('name the flag that silences them, so discovery costs one run', () => {
    const [first] = analyse(briefs).diagnostics;
    expect(first?.hint).toContain('--ignore-ref "trap *"');
  });

  it('go quiet once the repository declares the convention', () => {
    expect(analyse(briefs, ['trap *']).diagnostics).toEqual([]);
  });

  it('suggest the family, not the single tag', () => {
    // Numbered tags come in series. Excluding them one at a time is not a fix
    // anybody would accept.
    const hints = analyse({
      'docs/adr/0001-a.md': '# A\n\nSee [[trap 55]], [[Q-17]] and [[services]].\n',
    }).diagnostics.map((d) => d.hint);
    expect(hints[0]).toContain('"trap *"');
    expect(hints[1]).toContain('"Q *"');
    // Nothing numbered to generalise: suggest it verbatim rather than inventing.
    expect(hints[2]).toContain('"services"');
  });
});

describe('what the filter must never do', () => {
  const corpus = {
    'docs/adr/0001-a.md': '---\nstatus: archived\n---\n\n# A\n',
    'docs/adr/0002-b.md': [
      '---',
      'status: accepted',
      'supersedes: ADR-0001',
      '---',
      '',
      '# B',
      '',
      'Builds on [[0001-a]].',
    ].join('\n'),
  };

  it('leaves a reference that resolves as an edge', () => {
    // The filter is consulted only after resolution has already failed, so no
    // amount of configuration can silently delete a relation from the graph.
    const wide = analyse(corpus, ['*']);
    expect(wide.graph.out('ADR-0002').some((edge) => edge.to === 'ADR-0001')).toBe(true);
    expect(wide.graph.edges.filter((e) => e.kind === 'supersedes')).toHaveLength(1);
  });

  it('does not suppress findings about documents, only about references', () => {
    // `*` silences every unresolved citation and nothing else: the lifecycle
    // rules still fire.
    expect(rules(corpus, ['*'])).toContain('unreciprocated-supersession');
  });

  it('does not reach a path-shaped reference by accident', () => {
    const withPath = {
      'docs/adr/0001-a.md': '# A\n\nSee [notes](../../notes/gone.md).\n',
    };
    // The pattern is written for concept tags; a real broken path is untouched.
    expect(rules(withPath, ['trap *'])).toContain('broken-reference');
    // But an operator who genuinely wants it gone can say so.
    expect(rules(withPath, ['../../notes/*'])).toEqual([]);
  });

  it('suppresses an ambiguous citation too, when asked', () => {
    const ambiguous = {
      'docs/adr/0001-a.md': '---\naliases: [shared]\n---\n\n# A\n',
      'docs/adr/0002-b.md': '---\naliases: [shared]\n---\n\n# B\n',
      'docs/adr/0003-c.md': '# C\n\nWe follow [[shared]].\n',
    };
    expect(rules(ambiguous)).toContain('ambiguous-reference');
    expect(rules(ambiguous, ['shared'])).not.toContain('ambiguous-reference');
  });

  it('suppresses an unresolved anchor too, when asked', () => {
    const anchored = {
      'docs/adr/0001-a.md': '# A\n\n## Decision\n',
      'docs/adr/0002-b.md': '# B\n\nSee [it](0001-a.md#nope).\n',
    };
    expect(rules(anchored)).toContain('broken-reference');
    expect(rules(anchored, ['*#nope'])).toEqual([]);
  });
});

describe('vault-style repositories keep their checks', () => {
  it('still report a wiki link whose document was renamed', () => {
    const vault = {
      'notes/0001-intro.md': '# Intro\n\nSee [[0002-detail]].\n',
      'notes/0003-detail.md': '# Detail\n',
    };
    expect(rules(vault)).toContain('broken-reference');
  });

  it('still resolve a wiki link that names a real document', () => {
    const vault = {
      'notes/0001-intro.md': '# Intro\n\nSee [[0002-detail]].\n',
      'notes/0002-detail.md': '# Detail\n',
    };
    const { corpus, graph } = analyse(vault);
    expect(corpus.dangling).toEqual([]);
    expect(graph.out('0001-intro').some((edge) => edge.to === '0002-detail')).toBe(true);
  });
});

describe('one written citation is one reference', () => {
  // `Superseded by ADR-0009` in a status section is read by the status reader
  // and again by prose scanning. Both are right about the fact and there is one
  // line to fix, so there is one finding. Invisible while the target resolves,
  // because two identical edges collapse into one - and this is where it shows.
  const SUPERSEDED = ['# ADR-0002: Sharding', '', '## Status', '', 'Superseded by ADR-0003'].join('\n');

  it('does not report a missing supersession target twice', () => {
    const found = analyse({ 'docs/adr/0002-sharding.md': SUPERSEDED }).diagnostics.filter(
      (diagnostic) => diagnostic.rule === 'broken-reference',
    );
    expect(found).toHaveLength(1);
    // The narrower span wins: it points at the identifier, not at the line.
    expect(found[0]?.at.span.start.column).toBe(15);
  });

  it('still resolves to one edge when the target exists', () => {
    const { graph } = analyse({
      'docs/adr/0002-sharding.md': SUPERSEDED,
      'docs/adr/0003-many.md': ['# ADR-0003: Many writers', '', '## Status', '', 'accepted'].join('\n'),
    });
    expect(graph.in('ADR-0002', ['supersedes']).map((edge) => edge.from)).toEqual(['ADR-0003']);
  });

  it('still reports two separate sentences citing the same missing document', () => {
    // Two citations a reader has to fix in two places. Collapsing these would
    // leave the second to be discovered on the next run.
    const files = {
      'docs/adr/0004-a.md': [
        '# ADR-0004: A',
        '',
        '## Status',
        '',
        'accepted',
        '',
        'This depends on ADR-0099.',
        '',
        'It also assumes ADR-0099.',
      ].join('\n'),
    };
    expect(analyse(files).diagnostics.filter((d) => d.rule === 'broken-reference')).toHaveLength(2);
  });
});

describe('reference-style links', () => {
  const files = (body: string) => ({
    'A.md': '---\nid: ADR-0001\nstatus: accepted\n---\n\n# ADR-0001: Target\n',
    'B.md': `---\nid: ADR-0002\nstatus: accepted\n---\n\n# ADR-0002: Citing\n\n${body}\n`,
  });
  const edges = (body: string) =>
    analyse(files(body)).graph.edges.filter((e) => e.kind !== 'contains').map((e) => `${e.from} -${e.kind}-> ${e.to}`);

  it('reads a reference link through to what the label stands for', () => {
    // The label is not the destination. Before this, the citation was read as
    // "one", which resolved to nothing: a broken reference *and* a missing edge.
    expect(edges('This depends on [ADR-0001][one].\n\n[one]: A.md')).toEqual(['ADR-0002 -depends-on-> ADR-0001']);
    expect(rules(files('This depends on [ADR-0001][one].\n\n[one]: A.md'))).toEqual([]);
  });

  it('reads a shortcut link the same way', () => {
    expect(edges('This depends on [target].\n\n[target]: A.md')).toEqual(['ADR-0002 -depends-on-> ADR-0001']);
  });

  it('leaves a label nothing defines as prose', () => {
    // `[design][one]` renders literally when nothing defines `one`. Reading it
    // as a citation would invent a reference and then report it broken.
    expect(edges('See [design][one] and [alone].')).toEqual([]);
    expect(rules(files('See [design][one] and [alone].'))).toEqual([]);
  });

  it('reports a broken one at the definition, which is the line that fixes it', () => {
    const found = analyse(files('This depends on [gone][x].\n\n[x]: nowhere.md')).diagnostics;
    expect(found.map((d) => d.rule)).toEqual(['broken-reference']);
    expect(found[0]?.target).toBe('nowhere.md');
    expect(found[0]?.at.span.start.line).toBe(10);
  });
});

describe('front-matter keys that read as relations', () => {
  const check = (frontMatter: string) =>
    analyse({
      'A.md': '---\nid: ADR-0001\nstatus: accepted\n---\n\n# ADR-0001: Target\n',
      'B.md': `---\nid: ADR-0002\nstatus: accepted\n${frontMatter}\n---\n\n# ADR-0002: Citing\n`,
    });
  const kinds = (frontMatter: string) =>
    check(frontMatter)
      .graph.edges.filter((e) => e.kind !== 'contains')
      .map((e) => `${e.from} -${e.kind}-> ${e.to}`);

  it('reads an inverse relation key', () => {
    expect(kinds('depended-on-by: ADR-0001')).toEqual(['ADR-0001 -depends-on-> ADR-0002']);
  });

  it('reads the same key however it is punctuated', () => {
    for (const spelling of ['depends-on', 'depends_on', 'dependsOn', 'DependsOn', 'DEPENDS_ON']) {
      expect(kinds(`${spelling}: ADR-0001`), spelling).toEqual(['ADR-0002 -depends-on-> ADR-0001']);
    }
  });

  it('reports a key one edit from a relation that carries a citation', () => {
    const found = check('supercedes-by: ADR-0001').diagnostics;
    expect(found.map((d) => d.rule)).toEqual(['unknown-relation-key']);
    expect(found[0]?.hint).toContain('superceded-by');
  });

  it('stays quiet when the value could not be a citation', () => {
    // `sidebar_position` is a hair from nothing, but `deprecated` is one edit
    // from `deprecates` - and a boolean is not a document.
    expect(check('deprecated: true\nsidebar_position: 4\nref: main').diagnostics).toEqual([]);
  });

  it('stays quiet about a key that is nothing like a relation', () => {
    expect(check('description: ADR-0001 explains why\nauthors: ADR-0001').diagnostics).toEqual([]);
  });

  it('says nothing about a key it understood, near-miss or not', () => {
    // `supersedes` is one edit from `supercedes`, which is also a key. A known
    // key must be settled before the near-miss gate is reached, or the
    // vocabulary reports itself.
    // `supersedes` also retires the target, which is a finding of its own -
    // what matters here is that the key itself is never questioned.
    expect(check('supersedes: ADR-0001').diagnostics.map((d) => d.rule)).not.toContain('unknown-relation-key');
    expect(check('depends-on: ADR-0001').diagnostics).toEqual([]);
  });

  it('needs only one value to be a citation, not all of them', () => {
    const found = check("supercedes-by: [draft, ADR-0001]").diagnostics;
    expect(found.map((d) => d.rule)).toEqual(['unknown-relation-key']);
  });

  it('names the key, so two misspellings in one document are two findings', () => {
    // The fingerprint a baseline and a SARIF consumer both key on. Without the
    // key in it, both of these collapse into one entry with a count of two.
    const found = check(['supercedes-by: ADR-0001', 'require-by: ADR-0001'].join('\n')).diagnostics;
    expect(found.map((d) => d.target)).toEqual(['supercedes-by', 'require-by']);
  });
});
