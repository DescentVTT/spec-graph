import { describe, expect, it } from 'vitest';

import { formatGraph } from '../src/report.js';
import { analyseSources, type AnalyseSourcesOptions, type Source } from '../src/runner.js';

/**
 * How a reference finds its document, and what is said when it does not.
 *
 * Each case is a promise the README or ADR-0004 makes: every spelling of a
 * document reaches it, a bare number stays inside its family, a suggestion is
 * close in the name and never in the number, and two candidates is worse than
 * none.
 */

const analyse = (files: Record<string, string>, options: AnalyseSourcesOptions = {}) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    options,
  );

/** Every relation but containment, as `from kind to`. */
function relations(files: Record<string, string>, options: AnalyseSourcesOptions = {}): string[] {
  return analyse(files, options)
    .graph.edges.filter((edge) => edge.kind !== 'contains')
    .map((edge) => `${edge.from} ${edge.kind} ${edge.to}`);
}

/** Every finding, as its rule, message and hint. */
function findings(files: Record<string, string>, options: AnalyseSourcesOptions = {}): string[] {
  return analyse(files, options).diagnostics.map((d) => `${d.rule}: ${d.message} | ${d.hint}`);
}

const accepted = (title: string, extra = ''): string => `---\nstatus: accepted\n${extra}---\n\n# ${title}\n`;

describe('a link to a file that has moved', () => {
  it('finds it by its name, wherever it lives now', () => {
    // "Resolution already binds a path by its basename, so a link to
    // `../guides/onboarding.md` finds the document now living in `handbook/`."
    expect(
      relations({
        'docs/handbook/onboarding.md': accepted('Onboarding'),
        'docs/handbook/setup.v2.md': accepted('Setup'),
        'docs/adr/0001-a.md': accepted('A') + '\nSee [onboarding](../guides/onboarding.md) and [setup](../old/setup.v2.md).\n',
      }),
    ).toEqual(['ADR-0001 references onboarding', 'ADR-0001 references setup.v2']);
  });
});

describe('an identifier', () => {
  const corpus = {
    'docs/adr/0007-sharding.md': accepted('Sharding'),
    'docs/rfcs/0007-transport.md': accepted('Transport'),
  };

  it('finds its document however far its number is padded', () => {
    expect(relations({ ...corpus, 'docs/adr/0001-a.md': accepted('A', 'depends-on: ADR-000007\n') })).toEqual([
      'ADR-0001 depends-on ADR-0007',
    ]);
  });

  it('with no family finds the document of that number in the citing one’s family, and only there', () => {
    // "A bare `0007` resolves only within the citing document's family."
    expect(
      relations({
        ...corpus,
        'docs/adr/0001-a.md': accepted('A', 'depends-on: "7"\n'),
        'docs/rfcs/0001-r.md': accepted('R', 'depends-on: "0007"\n'),
      }),
    ).toEqual(['ADR-0001 depends-on ADR-0007', 'RFC-0001 depends-on RFC-0007']);
  });

  it('with no family is a broken reference from a document that has none', () => {
    expect(findings({ ...corpus, 'docs/notes.md': accepted('Notes', 'depends-on: "7"\n') })).toEqual([
      'broken-reference: "7" does not resolve to any document | fix the identifier, or add the document it names',
    ]);
  });

  it('that is a document’s own id is never ambiguous, whatever another document calls itself', () => {
    // A document's id names it the way a file's literal path does: exactly.
    // Another's alias is an inexact spelling, and only those can collide.
    const files = {
      'docs/adr/0007-sharding.md': accepted('Sharding'),
      'docs/adr/0012-sharding-v2.md': accepted('Sharding, again', 'aliases: [ADR-0007]\n'),
      'docs/adr/0001-a.md': accepted('A', 'depends-on: ADR-0007\n'),
    };
    expect(relations(files)).toEqual(['ADR-0001 depends-on ADR-0007']);
    expect(findings(files)).toEqual([]);
  });

  it('in prose that two documents answer to is not reported, where a link spelled the same is', () => {
    // Prose is opportunistic: an identifier picked out of a sentence that turns
    // out to name two documents is not a mistake anybody made (ADR-0006).
    const files = {
      'docs/adr/0007-sharding.md': accepted('Sharding', 'aliases: [SHARD-1]\n'),
      'docs/adr/0012-sharding-v2.md': accepted('Sharding, again', 'aliases: [SHARD-1]\n'),
    };
    expect(findings({ ...files, 'docs/adr/0001-a.md': accepted('A') + '\nAs SHARD-1 says.\n' })).toEqual([]);
    expect(
      findings({ ...files, 'docs/adr/0001-a.md': accepted('A') + '\nAs [[SHARD-1]] says.\n' }).map((f) => f.split(':')[0]),
    ).toEqual(['ambiguous-reference']);
  });
});

describe('a family', () => {
  it('is not made by an unnumbered document in its directory', () => {
    // An index page in `rfcs/` is not an RFC, and a repository holding only
    // that is not one whose every `RFC 2119` is a local citation.
    expect(
      findings({
        'docs/rfcs/README.md': accepted('Our RFCs'),
        'docs/adr/0001-a.md': accepted('A') + '\nThe key words are to be read as in RFC 2119.\n',
      }),
    ).toEqual([]);
  });
});

describe('a suggestion for a reference that failed', () => {
  const corpus = {
    'docs/adr/0007-sharding.md': accepted('Sharding'),
    'docs/adr/0002-caching.md': accepted('Caching'),
    'docs/guides/deploy.md': accepted('Deploying'),
  };

  const hintFor = (citing: string): string[] =>
    analyse({ ...corpus, 'docs/adr/0010-probe.md': citing })
      .diagnostics.filter((d) => d.rule === 'broken-reference')
      .map((d) => d.hint);

  it('names the document one family-letter out with its number intact, however short the spelling', () => {
    // `adx7` folds to four characters, under the floor the other gate keeps.
    expect(hintFor(accepted('Probe', 'depends-on: ADX-7\n'))).toEqual(['did you mean ADR-0007?']);
  });

  it('names nothing for a family one letter out that has no document of that number', () => {
    expect(hintFor(accepted('Probe', 'depends-on: ADQ-0009\n'))).toEqual(['fix the identifier, or add the document it names']);
  });

  it('is offered for a folded spelling of six characters, and not of five', () => {
    // "floored at six folded characters - below that an edit is most of the word."
    expect(hintFor(accepted('Probe') + '\nSee [[deplay]].\n')).toEqual(['did you mean deploy?']);
    expect(hintFor(accepted('Probe') + '\nSee [[deplo]].\n')).toEqual([
      'fix the identifier, or - if [[...]] tags a concept here - exclude it: --ignore-ref "deplo"',
    ]);
  });

  it('names the sibling a mistyped path is one edit from, with its extension dropped as well', () => {
    expect(hintFor(accepted('Probe') + '\nSee [caching](./0002-cachng).\n')).toEqual(['did you mean ADR-0002?']);
  });
});

describe('what is not a reference', () => {
  it('a URL in a relation field', () => {
    const files = {
      'docs/adr/0007-sharding.md': accepted('Sharding'),
      'docs/adr/0001-a.md': accepted('A', 'see-also: https://example.com/adr-0007\n'),
    };
    expect(relations(files)).toEqual([]);
    expect(findings(files)).toEqual([]);
  });

  it('a directory path, for any file in it but its README or index', () => {
    // "`docs/adr/0007/README.md` is also addressed as `docs/adr/0007`" - and no
    // other file in that directory is.
    for (const file of ['setup.md', 'old-readme.md', 'reindex.md']) {
      expect(
        relations({
          [`docs/guides/${file}`]: accepted('Guide'),
          'docs/adr/0001-a.md': accepted('A') + '\nSee [the guides](../guides).\n',
        }),
      ).toEqual([]);
    }
    expect(
      relations({
        'docs/guides/README.md': accepted('Guides'),
        'docs/adr/0001-a.md': accepted('A') + '\nSee [the guides](../guides).\n',
      }),
    ).toEqual(['ADR-0001 references guides']);
  });
});

describe('a broken path link', () => {
  it('is still reported when the configuration ignores a family', () => {
    const files = { 'docs/adr/0001-a.md': accepted('A') + '\nSee [the old design](0009-gone.md).\n' };
    expect(findings(files, { isIgnoredFamily: (family) => family === 'RFC' }).map((f) => f.split(' |')[0])).toEqual([
      'broken-reference: "0009-gone.md" does not resolve to any document',
    ]);
  });

  it('written as a wiki link gets the same hint whether or not the file system was asked', () => {
    const files = { 'docs/adr/0001-a.md': accepted('A') + '\nSee [[notes/retention]].\n' };
    const hint = 'fix the identifier, or - if [[...]] tags a concept here - exclude it: --ignore-ref "notes/retention"';
    expect(analyse(files).diagnostics.map((d) => d.hint)).toEqual([hint]);
    expect(analyse(files, { fileExists: () => false }).diagnostics.map((d) => d.hint)).toEqual([hint]);
  });
});

describe('an anchor', () => {
  const target = accepted('Target') + '\n## Reads / writes\n\n## Why not Postgres?\n\n## Really\n';

  it.each(['reads--writes', 'Reads--Writes', 'why-not-postgres?', 'really?!'])('binds as %s', (anchor) => {
    const { diagnostics, graph } = analyse({
      'docs/adr/0001-target.md': target,
      'docs/adr/0002-src.md': accepted('Src') + `\nSee [the section](0001-target.md#${anchor}).\n`,
    });
    expect(diagnostics).toEqual([]);
    expect(graph.edges.filter((edge) => edge.kind === 'references').map((edge) => edge.to)).toEqual(['ADR-0001']);
  });

  it('that names nothing suggests only the items of the document it points at', () => {
    const item = (id: string, text: string) => `## Open Questions\n\n<!-- @spec-item id="${id}" -->\n- [ ] ${text}\n`;
    const { diagnostics } = analyse({
      'docs/adr/0001-target.md': `${accepted('Target')}\n${item('shard-key', 'Which shard key?')}`,
      'docs/adr/0002-other.md': `${accepted('Other')}\n${item('shard-count', 'How many shards?')}`,
      'docs/adr/0003-src.md': accepted('Src') + '\nSee [the question](0001-target.md#shard).\n',
    });
    expect(diagnostics.map((d) => `${d.rule}: ${d.hint}`)).toEqual([
      'broken-reference: did you mean ADR-0001#shard-key?',
    ]);
  });
});

describe('containment', () => {
  it('is structural in the export, and declared in the file that holds what it contains', () => {
    const { graph } = analyse({
      'docs/register.md': '# Register\n\n| ID | Status |\n| --- | --- |\n| ADR-0001 | Accepted |\n',
      'docs/adr/0002-b.md': accepted('B') + '\n## Open Questions\n\n- [ ] Who owns it?\n',
    });
    const exported: { edges: { kind: string; from: string; to: string; origin: string; declaredIn: string[] }[] } =
      JSON.parse(formatGraph(graph, 'json'));
    expect(
      exported.edges
        .filter((edge) => edge.kind === 'contains')
        .map((edge) => `${edge.from} > ${edge.to} ${edge.origin} ${edge.declaredIn.join(',')}`),
    ).toEqual(['register > ADR-0001 structural docs/register.md', 'ADR-0002 > ADR-0002#open-questions.1 structural docs/adr/0002-b.md']);
  });

  it('is drawn only between a file and a region of it the graph kept, whatever a duplicate id did', () => {
    const contains = (files: Record<string, string>) =>
      analyse(files)
        .graph.edges.filter((edge) => edge.kind === 'contains')
        .map((edge) => `${edge.from} > ${edge.to}`);
    // A register whose own id another file already has holds none of that file's.
    expect(
      contains({
        'docs/adr/0007-a.md': '# A\n',
        'docs/adr/0007-register.md': '# Register\n\n| ID | Status |\n| --- | --- |\n| OI-1 | Open |\n',
      }),
    ).toEqual([]);
    // And a row whose id another file already has is that file, not the register's.
    expect(
      contains({
        'docs/adr/0001-a.md': '# A\n',
        'docs/register.md': '# Register\n\n| ID | Status |\n| --- | --- |\n| ADR-0001 | Open |\n| ADR-0002 | Open |\n',
      }),
    ).toEqual(['register > ADR-0002']);
  });
});

describe('a relation stated twice in one file', () => {
  it('is one relation, declared in that file once', () => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': accepted('A', 'depends-on: ADR-0002\n') + '\nThis depends on [ADR-0002](0002-b.md).\n',
      'docs/adr/0002-b.md': accepted('B'),
    });
    const exported: { edges: { kind: string; declaredIn: string[] }[] } = JSON.parse(formatGraph(graph, 'json'));
    expect(exported.edges.filter((edge) => edge.kind === 'depends-on').map((edge) => edge.declaredIn)).toEqual([
      ['docs/adr/0001-a.md'],
    ]);
  });
});
