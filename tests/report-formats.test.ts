import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { StaleEntry } from '../src/baseline.js';
import { compileProjectRules } from '../src/project-rules.js';
import { formatJson, formatMarkdown, formatReport, formatSarif, type ReporterOptions } from '../src/report.js';
import { RULE_DESCRIPTIONS } from '../src/rules.js';
import { analyseSources, withDiagnostics, type AnalyseSourcesOptions, type AnalysisResult, type Source } from '../src/runner.js';
import { formatRef } from '../src/source.js';
import type { Diagnostic } from '../src/types.js';

/*
 * What each report format promises the thing that reads it: a person in a
 * terminal, a Markdown renderer on a pull request, a bot parsing JSON, a
 * code-scanning uploader reading SARIF. Every corpus is analysed inside the
 * test that uses it, never at collection time (ADR-0007).
 */

/** One error with two pieces of evidence whose locations differ in length. */
const GHOST: Source[] = [
  { path: 'docs/adr/0002-old.md', text: '---\nstatus: superseded by ADR-0003\n---\n\n# Old\n' },
  { path: 'docs/adr/0003-new.md', text: '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# New\n' },
  {
    path: 'docs/adr/0004-cache.md',
    text: '---\nstatus: accepted\n---\n\n# Cache\n\n## Open Questions\n\n- [ ] Eviction policy? Deferred to [ADR-0002](0002-old.md).\n',
  },
];

const CLEAN: Source[] = [{ path: 'docs/adr/0001-a.md', text: '# A\n' }];

/** A directive with an attribute nobody reads: a problem with the input, not a finding. */
const PROBLEM: Source = { path: 'docs/adr/0009-x.md', text: '<!-- @spec-node id="ADR-0009" colour="red" -->\n\n# X\n' };

/** A status YAML would not read, so the document reads as unknown. */
const UNREAD: Source = { path: 'docs/adr/0005-e.md', text: '---\nstatus: Superseded by ADR-0003: see the notes\n---\n# ADR-0005: E\n' };

/** One concept tag written twice, another once, and a citation of a family the repository disowns. */
const SILENCED: Source = {
  path: 'docs/adr/0001-a.md',
  text: '---\ndepends-on: RFC-2119\n---\n# ADR-0001: A\n\nSee [[trap 55]], [[trap 55]] again and [[trap 9]].\n',
};

const SILENCING: AnalyseSourcesOptions = {
  isIgnoredReference: (target) => target.startsWith('trap'),
  isIgnoredFamily: (family) => family.toUpperCase() === 'RFC',
};

/** Wraps the pure engine output in the shape the reporters take, as the runner would. */
function result(sources: readonly Source[], options: AnalyseSourcesOptions = {}, durationMs = 1): AnalysisResult {
  const { graph, corpus, diagnostics } = analyseSources(sources, options);
  const base: AnalysisResult = {
    graph,
    corpus,
    diagnostics: [],
    problems: corpus.problems,
    files: sources.map((source) => source.path),
    summary: {
      documents: corpus.documents.length,
      items: corpus.items.length,
      edges: graph.edges.length,
      openObligations: corpus.items.filter((item) => item.openness !== 'closed').length,
      errors: 0,
      warnings: 0,
      infos: 0,
      durationMs,
    },
    ok: true,
  };
  return withDiagnostics(base, diagnostics);
}

/** A finding made by hand, so its severity and wording are the test's to choose. */
function finding(overrides: Partial<Diagnostic> = {}): Diagnostic {
  const point = { offset: 0, line: 3, column: 1 };
  return {
    rule: 'broken-reference',
    severity: 'error',
    message: '"x.md" does not resolve to any document',
    hint: 'fix the identifier, or add the document it names',
    at: { file: 'docs/adr/0001-a.md', span: { start: point, end: point } },
    nodes: ['ADR-0001'],
    related: [],
    target: 'x.md',
    ...overrides,
  };
}

const paid = (document: string): StaleEntry => ({ rule: 'broken-reference', document, subject: 'docs/plans/x.md', count: 1, reason: 'paid' });
const gone = (document: string): StaleEntry => ({ rule: 'ghost-handover', document, subject: '', count: 1, reason: 'gone' });

type Baseline = NonNullable<ReporterOptions['baseline']>;
const baseline = (overrides: Partial<Baseline> = {}): Baseline => ({
  source: '.spec-graph-baseline.json',
  suppressed: 0,
  stale: 0,
  ...overrides,
});

const isAscii = (text: string): boolean => [...text].every((character) => (character.codePointAt(0) as number) < 0x80);

/* -------------------------------------------------------------------------- */

describe('the human report, as a reader scans it', () => {
  it('opens with the four counts behind one separator, then a blank line', () => {
    const report = result(GHOST);
    expect(report.summary).toMatchObject({ documents: 3, items: 1, edges: 3, openObligations: 1 });

    const ascii = formatReport(report, { ascii: true }).split('\n');
    const header = /^spec-graph 3 documents (\S) 1 item \1 3 relations \1 1 open$/.exec(ascii[0] as string);
    expect(header, ascii[0]).not.toBeNull();
    expect(isAscii(header?.[1] as string)).toBe(true);
    expect(ascii[1]).toBe('');

    // The separator the README's tally shows, `16ms · 2 accepted by ...`.
    const unicode = formatReport(report, { ascii: false }).split('\n');
    expect(unicode[0]).toBe('spec-graph 3 documents · 1 item · 3 relations · 1 open');
    expect(unicode[1]).toBe('');
  });

  it('marks each severity with a glyph of its own, one character wide, in both glyph sets', () => {
    const report = withDiagnostics(result(CLEAN), [
      finding({ severity: 'error' }),
      finding({ severity: 'warn', rule: 'reference-outside-corpus' }),
      finding({ severity: 'info', rule: 'self-reference' }),
    ]);
    for (const ascii of [true, false]) {
      const marks = formatReport(report, { ascii })
        .split('\n')
        .filter((line) => line.includes('docs/adr/0001-a.md:3:1'))
        .map((line) => {
          // The location sits in the same column whatever the severity, which
          // is what lets an editor's link detection and a reader's eye find it.
          const [mark, location] = line.split(' ');
          expect(location, line).toBe('docs/adr/0001-a.md:3:1');
          return mark as string;
        });
      expect(marks).toHaveLength(3);
      for (const mark of marks) expect([...mark], mark).toHaveLength(1);
      expect(new Set(marks).size).toBe(3);
      if (ascii) expect(marks.every(isAscii), marks.join(' ')).toBe(true);
    }
  });

  it('sets the evidence and the next action under the finding, each behind a mark of its own', () => {
    const report = result(GHOST);
    const [ghost] = report.diagnostics as [Diagnostic];
    expect(ghost.related).toHaveLength(2);
    for (const ascii of [true, false]) {
      const lines = formatReport(report, { ascii }).split('\n');
      const start = lines.findIndex((line) => line.slice(2).startsWith(formatRef(ghost.at)));
      expect(lines[start + 1]).toBe(`    ${ghost.message}`);
      const evidence = ghost.related.map((entry, index) => {
        const line = lines[start + 2 + index] as string;
        const match = /^ {4}(\S) (\S+) +(.+)$/.exec(line);
        expect(match, line).not.toBeNull();
        expect(match?.[2]).toBe(formatRef(entry.at));
        expect(match?.[3]).toBe(entry.note);
        return match?.[1] as string;
      });
      expect(new Set(evidence).size).toBe(1);
      const next = /^ {4}(\S) (.+)$/.exec(lines[start + 2 + ghost.related.length] as string);
      expect(next?.[2]).toBe(ghost.hint);
      expect(next?.[1]).not.toBe(evidence[0]);
      if (ascii) expect(isAscii(`${evidence[0]}${next?.[1]}`)).toBe(true);
    }
  });

  it('lines the evidence up in a column, so every note starts in the same place', () => {
    const report = result(GHOST);
    const [ghost] = report.diagnostics as [Diagnostic];
    const [first, second] = ghost.related.map((entry) => formatRef(entry.at));
    expect(first?.length).not.toBe(second?.length);
    const lines = formatReport(report, { ascii: true }).split('\n');
    const columns = ghost.related.map((entry) => {
      const line = lines.find((candidate) => candidate.includes(formatRef(entry.at)) && candidate.includes(entry.note)) as string;
      return line.indexOf(entry.note);
    });
    expect(columns[0]).toBe(columns[1]);
  });

  it('uses the rich glyphs unless told otherwise', () => {
    const report = result(GHOST);
    expect(formatReport(report)).toBe(formatReport(report, { ascii: false }));
    expect(formatReport(report)).not.toBe(formatReport(report, { ascii: true }));
  });

  it('leaves one blank line after each finding, and after the count of those it left out', () => {
    const base = result(GHOST);
    const [ghost] = base.diagnostics as [Diagnostic];
    const twice = withDiagnostics(base, [ghost, ghost]);
    const lines = formatReport(twice, { ascii: true }).split('\n');
    const hints = lines.flatMap((line, index) => (line.endsWith(ghost.hint) ? [index] : []));
    expect(hints).toHaveLength(2);
    for (const index of hints) expect(lines[index + 1]).toBe('');

    const capped = formatReport(twice, { ascii: true, max: 1 }).split('\n');
    const more = capped.indexOf('  ... and 1 more');
    expect(more).toBeGreaterThan(0);
    expect(capped[more + 1]).toBe('');
  });

  it('counts what it left out only when it left something out', () => {
    const base = result(GHOST);
    const twice = withDiagnostics(base, [...base.diagnostics, ...base.diagnostics]);
    expect(formatReport(twice, { ascii: true })).not.toContain('... and');
    expect(formatReport(twice, { ascii: true, max: 2 })).not.toContain('... and');
  });

  it('shows every finding for a limit that is not positive, as it does for zero', () => {
    // `max` is a public option and zero means no limit. A negative one is not a
    // way to drop findings off the end of a report.
    const base = result(GHOST);
    const twice = withDiagnostics(base, [...base.diagnostics, ...base.diagnostics]);
    const everything = formatReport(twice, { ascii: true });
    expect(formatReport(twice, { ascii: true, max: -1 })).toBe(everything);
    expect(formatMarkdown(twice, { max: -1 })).toBe(formatMarkdown(twice));
  });

  it('ends with the tally the README shows: the duration, then what a baseline accepted and what it no longer needs', () => {
    const text = formatReport(result(CLEAN, {}, 16), {
      baseline: baseline({ suppressed: 2, stale: 1, entries: [paid('ADR-0004')] }),
    });
    expect(text.split('\n').slice(-3)).toEqual([
      '16ms · 2 accepted by .spec-graph-baseline.json',
      '1 baseline entry no longer occurs - tighten it: spec-graph check --record-baseline .spec-graph-baseline.json',
      '✔ the specification graph is consistent',
    ]);
  });

  it('says nothing of a baseline that accepted nothing and has no slack, ratchet or not', () => {
    const report = result(CLEAN);
    const plain = formatReport(report, { ascii: true });
    expect(formatReport(report, { ascii: true, baseline: baseline() })).toBe(plain);
    expect(formatReport(report, { ascii: true, baseline: baseline({ ratchet: true }) })).toBe(plain);
    expect(JSON.parse(formatJson(report, { baseline: baseline({ ratchet: true }) })).ok).toBe(true);
  });

  it('counts the slack in the plural, and says how much of it left the corpus rather than being fixed', () => {
    const slack = (entries: StaleEntry[]): string =>
      formatReport(result(CLEAN), { ascii: true, baseline: baseline({ stale: entries.length, entries }) })
        .split('\n')
        .find((line) => line.includes('no longer')) as string;
    expect(slack([gone('ADR-0404'), gone('ADR-0405')])).toBe(
      '2 baseline entries no longer occur - 2 of them name documents this run did not see - check the include patterns before re-recording',
    );
    expect(slack([paid('ADR-0004'), gone('ADR-0404')])).toBe(
      '2 baseline entries no longer occur - 1 of them names a document this run did not see - check the include patterns before re-recording',
    );
    expect(slack([paid('ADR-0004'), paid('ADR-0005')])).toBe(
      '2 baseline entries no longer occur - tighten it: spec-graph check --record-baseline .spec-graph-baseline.json',
    );
  });

  it('under --ratchet, marks the slack as a failure and names the baseline as the problem', () => {
    const clean = result(CLEAN);
    const loose = baseline({ stale: 1, entries: [paid('ADR-0004')] });
    const tight = formatReport(clean, { ascii: true, baseline: { ...loose, ratchet: true } }).split('\n');
    expect(tight.slice(-2)).toEqual([
      'x 1 baseline entry no longer occurs - tighten it: spec-graph check --record-baseline .spec-graph-baseline.json',
      'x the baseline is looser than the repository',
    ]);
    expect(JSON.parse(formatJson(clean, { baseline: { ...loose, ratchet: true } })).ok).toBe(false);

    // Without the flag the same slack is a note, and the run is still clean.
    const soft = formatReport(clean, { ascii: true, baseline: loose }).split('\n');
    expect(soft.slice(-2)).toEqual([
      '1 baseline entry no longer occurs - tighten it: spec-graph check --record-baseline .spec-graph-baseline.json',
      'ok the specification graph is consistent',
    ]);
    expect(JSON.parse(formatJson(clean, { baseline: loose })).ok).toBe(true);

    // And a run that fails on its own findings says that, not the baseline.
    const failing = formatReport(result(GHOST), { ascii: true, baseline: { ...loose, ratchet: true } }).split('\n');
    expect(failing.at(-1)).toBe('x the specification graph is inconsistent');
  });
});

describe('--verbose in the human report', () => {
  it('adds nothing when there is nothing to add', () => {
    const clean = result(CLEAN);
    expect(clean.problems).toEqual([]);
    expect(clean.corpus.suppressed).toEqual([]);
    expect(formatReport(clean, { ascii: true, verbose: true })).toBe(formatReport(clean, { ascii: true }));
    expect(formatMarkdown(clean, { verbose: true })).toBe(formatMarkdown(clean));
  });

  it('lists what the configuration silenced, one line per target at its first site, and only when asked', () => {
    // ADR-0008: grouped by target, because a concept tag used forty times is one
    // decision, and naming which setting silenced it.
    const report = result([SILENCED], SILENCING);
    const [family, first, , nine] = report.corpus.suppressed;
    expect(report.corpus.suppressed.map((entry) => entry.target)).toEqual(['RFC-2119', 'trap 55', 'trap 55', 'trap 9']);

    const quiet = formatReport(report, { ascii: true });
    expect(quiet).not.toContain('ignored');

    const lines = formatReport(report, { ascii: true, verbose: true }).split('\n');
    const listed = [
      `i ${formatRef(family!.at)}  ignored family: RFC-2119`,
      `i ${formatRef(first!.at)}  ignored reference: trap 55 (2 times)`,
      `i ${formatRef(nine!.at)}  ignored reference: trap 9`,
    ];
    const at = lines.indexOf(listed[0] as string);
    expect(lines.slice(at, at + 4)).toEqual([...listed, '']);
  });

  it('ends the list of problems and the count of unread values with a blank line', () => {
    const problems = formatReport(result([...CLEAN, PROBLEM]), { ascii: true, verbose: true }).split('\n');
    const problem = problems.findIndex((line) => line.includes('unknown attribute "colour"'));
    expect(problems[problem + 1]).toBe('');

    const unread = formatReport(result([...CLEAN, UNREAD]), { ascii: true }).split('\n');
    const notice = unread.indexOf('! 1 front-matter value not read - see --verbose');
    expect(notice).toBeGreaterThan(0);
    expect(unread[notice + 1]).toBe('');
  });
});

describe('the markdown report', () => {
  const DELIMITER = /^\|( *:?-+:? *\|)+$/;
  const cells = (row: string): string[] =>
    row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

  /**
   * GFM reads a table, a list or a paragraph only when a blank line separates
   * it from its neighbours, and nothing reports it when one is missing: a table
   * with a line of text against it renders as a paragraph full of pipes. So
   * every block has to be exactly one of those, and every table has to carry
   * its delimiter row.
   */
  function expectBlocks(text: string): void {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const block of text.slice(0, -1).split('\n\n')) {
      const lines = block.split('\n');
      expect(block, 'an empty block: two blank lines in a row').not.toBe('');
      if (lines[0]?.startsWith('|')) {
        expect(lines.every((line) => line.startsWith('|')), block).toBe(true);
        expect(lines[1], block).toMatch(DELIMITER);
        expect(cells(lines[1] as string)).toHaveLength(cells(lines[0] as string).length);
      } else if (lines[0]?.startsWith('- ')) {
        expect(lines.every((line) => line.startsWith('- ')), block).toBe(true);
      } else {
        expect(lines, block).toHaveLength(1);
      }
    }
    expect(text.split('<details>').length).toBe(text.split('</details>').length);
  }

  it('keeps every block apart from the next, which is what GFM needs to render each one as what it is', () => {
    const everything = result([...GHOST, PROBLEM, SILENCED], SILENCING);
    expect(everything.diagnostics.length).toBeGreaterThan(0);
    expect(everything.problems.length).toBeGreaterThan(0);
    expect(everything.corpus.suppressed.length).toBeGreaterThan(0);

    expectBlocks(formatMarkdown(result(GHOST)));
    expectBlocks(formatMarkdown(result(CLEAN)));
    expectBlocks(formatMarkdown(everything, { verbose: true }));
    expectBlocks(formatMarkdown(everything, { verbose: true, baseline: baseline({ suppressed: 1 }) }));
    expectBlocks(formatMarkdown(everything, { baseline: baseline({ stale: 2, entries: [paid('ADR-0004'), gone('ADR-0404')] }) }));
    expectBlocks(formatMarkdown(result([SILENCED], SILENCING), { verbose: true }));
    // The count of unread values is the last thing printed without --verbose.
    expectBlocks(formatMarkdown(result([...GHOST, UNREAD])));
    expectBlocks(formatMarkdown(result([UNREAD]), { baseline: baseline({ suppressed: 1 }) }));
  });

  it('words the slack the way it reads it, with the documents it lost named apart from the debt that was paid', () => {
    const sentence = (entries: StaleEntry[]): string =>
      formatMarkdown(result(CLEAN), { baseline: baseline({ suppressed: 3, stale: entries.length, entries }) })
        .split('\n')
        .find((line) => line.includes('no longer')) as string;
    expect(sentence([paid('ADR-0004'), paid('ADR-0005')])).toBe(
      '3 findings accepted by `.spec-graph-baseline.json`, and 2 entries no longer occur.',
    );
    expect(sentence([paid('ADR-0004'), gone('ADR-0404')])).toBe(
      '3 findings accepted by `.spec-graph-baseline.json`, and 2 entries no longer occur - 1 of them names a document this run did not see.',
    );
  });

  it('puts a padded or wrapped message into its cell as one line of single spaces', () => {
    const base = result(GHOST);
    const text = formatMarkdown(withDiagnostics(base, [finding({ message: '  a |\n\n  b  ', hint: '\tc\n' })]));
    const row = text.split('\n').find((line) => line.includes('&#124;')) as string;
    expect(cells(row).at(-1)).toBe('a &#124; b<br>c');
  });

  it('lists the silenced references under --verbose, grouped by target, with where each was first written', () => {
    const report = result([SILENCED], SILENCING);
    const [family, first, , nine] = report.corpus.suppressed;
    expect(formatMarkdown(report)).not.toContain('silenced');
    const text = formatMarkdown(report, { verbose: true });
    expect(text).toContain(
      [
        '<details><summary>References this configuration silenced</summary>',
        '',
        `- \`RFC-2119\` - ignored family, first at \`${formatRef(family!.at)}\``,
        `- \`trap 55\` - ignored reference (2 times), first at \`${formatRef(first!.at)}\``,
        `- \`trap 9\` - ignored reference, first at \`${formatRef(nine!.at)}\``,
        '',
        '</details>',
      ].join('\n'),
    );
  });
});

describe('the JSON report', () => {
  it('carries every site the configuration silenced, repeats included, with or without --verbose', () => {
    // ADR-0008: a machine reader that has to ask for it twice will not ask.
    const parsed = JSON.parse(formatJson(result([SILENCED], SILENCING))) as { suppressed: unknown[] };
    const site = (target: string, by: string, line: number): Record<string, unknown> => ({
      target,
      from: 'ADR-0001',
      by,
      file: 'docs/adr/0001-a.md',
      line,
    });
    expect(parsed.suppressed).toEqual([
      site('RFC-2119', 'family', 2),
      site('trap 55', 'reference', 6),
      site('trap 55', 'reference', 6),
      site('trap 9', 'reference', 6),
    ]);
  });
});

describe('SARIF', () => {
  interface SarifLocation {
    physicalLocation: { artifactLocation: { uri: string }; region: Record<string, number> };
    message?: { text: string };
  }
  interface Sarif {
    $schema: string;
    version: string;
    runs: {
      tool: {
        driver: {
          name: string;
          informationUri: string;
          version?: string;
          semanticVersion?: string;
          rules: { id: string; shortDescription: { text: string }; defaultConfiguration: { level: string } }[];
        };
      };
      results: {
        ruleId: string;
        level: string;
        message: { text: string };
        locations: SarifLocation[];
        relatedLocations?: SarifLocation[];
        properties: { nodes: string[]; target: string | null; escalated: boolean };
      }[];
    }[];
  }
  const sarif = (text: string): Sarif['runs'][number] & { file: Sarif } => {
    const parsed = JSON.parse(text) as Sarif;
    return { ...(parsed.runs[0] as Sarif['runs'][number]), file: parsed };
  };

  /** A warning (an unacknowledged supersession) and a note (a self-link) beside the ghost's error. */
  const MIXED: Source[] = [
    ...GHOST,
    { path: 'docs/adr/0006-old.md', text: '---\nstatus: retired\n---\n\n# Old\n' },
    {
      path: 'docs/adr/0007-new.md',
      text: '---\nstatus: accepted\nsupersedes: ADR-0006\n---\n\n# New\n\n## Open Questions\n\n- [ ] Who owns this? Deferred to [ADR-0007](0007-new.md).\n',
    },
  ];

  it('names the schema it follows and the tool, with a link a reader can open', () => {
    const { graph } = analyseSources(GHOST);
    const run = sarif(formatSarif(result(GHOST), graph));
    const { homepage } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { homepage: string };
    expect(run.file.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(run.file.version).toBe('2.1.0');
    expect(run.tool.driver.name).toBe('spec-graph');
    expect(run.tool.driver.informationUri).toBe(homepage.replace(/#.*$/, ''));
  });

  it('carries the version of spec-graph when it is given one, and no version at all when it is not', () => {
    const report = result(GHOST);
    const versioned = sarif(formatSarif(report, report.graph, { version: '1.2.3' })).tool.driver;
    expect(versioned).toMatchObject({ version: '1.2.3', semanticVersion: '1.2.3' });
    const bare = sarif(formatSarif(report, report.graph)).tool.driver;
    expect('version' in bare).toBe(false);
    expect('semanticVersion' in bare).toBe(false);
  });

  it('describes each rule that fired with the sentence `spec-graph rules` prints, at its default level', () => {
    const report = result(MIXED);
    const severities = new Set(report.diagnostics.map((diagnostic) => diagnostic.severity));
    expect([...severities].sort()).toEqual(['error', 'info', 'warn']);
    const LEVEL = { error: 'error', warn: 'warning', info: 'note' } as const;
    const run = sarif(formatSarif(report, report.graph));
    expect(run.tool.driver.rules.map((rule) => rule.id).sort()).toEqual(
      [...new Set(report.diagnostics.map((diagnostic) => diagnostic.rule))].sort(),
    );
    for (const rule of run.tool.driver.rules) {
      const fired = report.diagnostics.find((diagnostic) => diagnostic.rule === rule.id) as Diagnostic;
      expect(rule.shortDescription.text).toBe(RULE_DESCRIPTIONS[rule.id as keyof typeof RULE_DESCRIPTIONS]);
      expect(rule.defaultConfiguration.level, rule.id).toBe(LEVEL[fired.severity]);
    }
  });

  it('puts each finding on its line with its level, its message and hint, its evidence and what --strict did', () => {
    const report = result(MIXED);
    const LEVEL = { error: 'error', warn: 'warning', info: 'note' } as const;
    const run = sarif(formatSarif(report, report.graph, { escalated: new Set(['self-reference' as const]) }));
    expect(run.results).toHaveLength(report.diagnostics.length);
    for (const [index, diagnostic] of report.diagnostics.entries()) {
      const entry = run.results[index] as Sarif['runs'][number]['results'][number];
      expect(entry.ruleId).toBe(diagnostic.rule);
      expect(entry.level).toBe(LEVEL[diagnostic.severity]);
      // The next action travels with the message: an annotation is all a
      // reviewer reads.
      expect(entry.message).toEqual({ text: `${diagnostic.message}. ${diagnostic.hint}` });
      expect(entry.locations).toEqual([
        {
          physicalLocation: {
            artifactLocation: { uri: diagnostic.at.file },
            region: {
              startLine: diagnostic.at.span.start.line,
              startColumn: diagnostic.at.span.start.column,
              endLine: diagnostic.at.span.end.line,
              endColumn: diagnostic.at.span.end.column,
            },
          },
        },
      ]);
      if (diagnostic.related.length === 0) expect('relatedLocations' in entry).toBe(false);
      else {
        expect(entry.relatedLocations?.map((related) => [related.physicalLocation.artifactLocation.uri, related.physicalLocation.region['startLine'], related.message?.text])).toEqual(
          diagnostic.related.map((related) => [related.at.file, related.at.span.start.line, related.note]),
        );
      }
      expect(entry.properties).toEqual({
        nodes: diagnostic.nodes,
        target: diagnostic.target,
        escalated: diagnostic.rule === 'self-reference',
      });
    }
    expect(run.results.some((entry) => entry.relatedLocations !== undefined)).toBe(true);
    expect(run.results.some((entry) => entry.relatedLocations === undefined)).toBe(true);
  });

  it('describes a project rule by its selectors, and a rule off by default at the level none', () => {
    const { rules, problems } = compileProjectRules(
      {
        'both-halves': { query: ['document[id=ADR-0002]', 'document[phase=draft]'], message: '{0} is found twice', severity: 'warn' },
        'quiet-by-default': { query: 'document[phase=draft]', message: '{0} is a draft', severity: 'off' },
      },
      '.spec-graph.json',
    );
    expect(problems).toEqual([]);
    const sources: Source[] = [
      { path: 'docs/0001.md', text: '---\nid: ADR-0001\nstatus: accepted\ndepends-on: ADR-0002\n---\n\n# One\n' },
      { path: 'docs/0002.md', text: '---\nid: ADR-0002\nstatus: draft\n---\n\n# Two\n' },
    ];
    // Turned on for this run by the same override `--rule` sets.
    const report = result(sources, { projectRules: rules, severities: { 'project:quiet-by-default': 'info' } });
    const run = sarif(formatSarif(report, report.graph, { projectRules: rules }));
    const described = Object.fromEntries(
      run.tool.driver.rules.map((rule) => [rule.id, [rule.shortDescription.text, rule.defaultConfiguration.level]]),
    );
    expect(described['project:both-halves']).toEqual(['document[id=ADR-0002] | document[phase=draft]', 'warning']);
    expect(described['project:quiet-by-default']).toEqual(['document[phase=draft]', 'none']);
    expect(run.results.find((entry) => entry.ruleId === 'project:quiet-by-default')?.level).toBe('note');
  });

  it('needs no options, and then marks nothing as raised by --strict', () => {
    const report = result(GHOST);
    const run = sarif(formatSarif(report, report.graph));
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.every((entry) => entry.properties.escalated === false)).toBe(true);
  });
});
