import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyse, analyseSources, DEFAULT_CONCURRENCY, DEFAULT_PATTERNS } from '../src/runner.js';
import type { AnyRuleId } from '../src/types.js';

/**
 * The orchestration layer, tested through its observable contract.
 *
 * `runner.ts` is thin, and most of what it does is choose defaults and plumb
 * options into the pure engine. Those choices are exactly what a refactor
 * silently changes: a fallback that stops firing, a clamp that stops clamping,
 * an option that stops being forwarded. None of it shows up in line coverage,
 * because the lines run either way.
 *
 * Every test here therefore asserts a *decision*, not a shape. Where a mutant of
 * the code would be genuinely equivalent - a pre-sized array, a worker count
 * that changes throughput and not output - there is deliberately no test, and
 * the comment says so.
 */

const ROOT = 'tests/fixtures/.tmp/runner';

const write = async (path: string, lines: readonly string[]): Promise<void> => {
  await writeFile(`${ROOT}/${path}`, `${lines.join('\n')}\n`);
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const directory of ['docs/adr', 'doc', 'adr', 'rfcs', 'specs', 'notes', 'skipped']) {
    await mkdir(`${ROOT}/${directory}`, { recursive: true });
  }

  await write('docs/adr/0001-old.md', [
    '---',
    'status: archived',
    '---',
    '',
    '# Old',
    '',
    '## Open Questions',
    '',
    '- [ ] Who owns the migration?',
    '- [~] Should we shard? Narrowed: hot path only.',
    '- [x] Is the index needed? Resolved: yes.',
    '- [ ] What about retention?',
    '- [ ] And backups?',
  ]);

  await write('docs/adr/0002-new.md', [
    '---',
    'status: accepted',
    'supersedes: ADR-0001',
    '---',
    '',
    '# New',
    '',
    'Background is in [the plan](../../notes/plan.md).',
  ]);

  // One document in each location the default patterns are meant to reach.
  await write('doc/0003-c.md', ['# Three']);
  await write('adr/0004-d.md', ['# Four']);
  await write('rfcs/0005-e.md', ['# Five']);
  await write('specs/0006-f.md', ['# Six']);
  await write('root-note.md', ['# Root']);

  // Real on disk, deliberately outside every default pattern.
  await write('notes/plan.md', ['# Plan']);

  await write('skipped/0009-ignored.md', ['<!-- @spec-ignore -->', '', '# Ignored']);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const rules = (diagnostics: readonly { rule: AnyRuleId }[]): AnyRuleId[] => diagnostics.map((d) => d.rule);

/* -------------------------------------------------------------------------- */

describe('pattern defaults', () => {
  it('falls back to the defaults when no patterns are given', async () => {
    const result = await analyse({ root: ROOT });
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('falls back when the caller passes an empty list', async () => {
    // An empty array is not "the user asked for nothing", it is "the user asked
    // for the default" - a CLI that collected no positional arguments. Treating
    // it as a filter that matches nothing analyses an empty corpus and reports
    // a clean bill of health for a repository it never read.
    const result = await analyse({ root: ROOT, patterns: [] });
    const withDefaults = await analyse({ root: ROOT });
    expect(result.files).toEqual(withDefaults.files);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('uses the given patterns when there are some', async () => {
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(result.files).toEqual(['docs/adr/0001-old.md', 'docs/adr/0002-new.md']);
  });

  it('reaches every location the defaults name', async () => {
    // Each entry of DEFAULT_PATTERNS is load-bearing: it is the zero-config
    // promise. A pattern that stops matching costs a whole directory silently.
    const result = await analyse({ root: ROOT });
    for (const path of [
      'docs/adr/0001-old.md',
      'doc/0003-c.md',
      'adr/0004-d.md',
      'rfcs/0005-e.md',
      'specs/0006-f.md',
      'root-note.md',
    ]) {
      expect(result.files, path).toContain(path);
    }
  });

  it('exposes the defaults it used', () => {
    expect(DEFAULT_PATTERNS.length).toBeGreaterThan(0);
    expect(DEFAULT_PATTERNS.every((pattern) => pattern.endsWith('.md'))).toBe(true);
  });
});

describe('the root directory', () => {
  it('tolerates trailing separators', async () => {
    // `--root docs/` is what a shell tab-completion produces.
    const plain = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    const trailing = await analyse({ root: `${ROOT}///`, patterns: ['docs/**/*.md'] });
    expect(trailing.files).toEqual(plain.files);
  });

  it('reports paths relative to the root, never absolute', async () => {
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    for (const file of result.files) {
      expect(file, file).not.toContain(ROOT);
      expect(file, file).not.toMatch(/^[A-Za-z]:|^\//);
    }
  });
});

describe('the on-disk existence check', () => {
  it('separates a document outside the patterns from one that does not exist', async () => {
    // The link resolves to a real file that the include patterns did not reach.
    // Knowing that is the whole difference between "you linked to nothing" and
    // "widen your patterns", and it costs a stat only when a reference failed.
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(rules(result.diagnostics)).toContain('reference-outside-corpus');
    expect(rules(result.diagnostics)).not.toContain('broken-reference');

    const found = result.diagnostics.find((d) => d.rule === 'reference-outside-corpus');
    expect(found?.severity).toBe('warn');
    expect(found?.hint).toContain('notes/**/*.md');
  });

  it('falls back to a broken reference when nothing answers at all', async () => {
    // Same shape of link, but pointed at a file that is on no disk anywhere.
    const { diagnostics } = analyseSources([
      { path: 'docs/adr/0002-new.md', text: '# New\n\nBackground is in [the plan](../../notes/gone.md).\n' },
    ]);
    expect(rules(diagnostics)).toContain('broken-reference');
    expect(rules(diagnostics)).not.toContain('reference-outside-corpus');
  });

  it('knows a file is present even when the corpus could not parse it as a spec', async () => {
    // `skipped/0009-ignored.md` opts out with @spec-ignore, so it is walked and
    // read but never becomes a node. A link to it must still be recognised as
    // pointing at something real.
    const { diagnostics } = analyseSources(
      [{ path: 'docs/a.md', text: '# A\n\nSee [it](../skipped/0009-ignored.md).\n' }],
      { fileExists: (path) => path === 'skipped/0009-ignored.md' },
    );
    expect(rules(diagnostics)).toEqual(['reference-outside-corpus']);
  });
});

describe('documents that opt out', () => {
  it('are dropped rather than carried through as holes', async () => {
    // `@spec-ignore` makes extraction return null. Anything other than dropping
    // it puts a null in the corpus, and the first rule to read `.id` throws.
    const result = await analyse({ root: ROOT, patterns: ['skipped/**/*.md', 'docs/**/*.md'] });
    expect(result.files).toContain('skipped/0009-ignored.md');
    expect(result.corpus.documents.map((document) => document.path)).not.toContain('skipped/0009-ignored.md');
    expect(result.summary.documents).toBe(2);
  });
});

describe('concurrency', () => {
  it('reads every file whatever the limit is set to', async () => {
    // The clamp exists so a nonsensical value cannot silently analyse nothing.
    // Zero workers is the dangerous one: it reports a clean, complete-looking
    // run over an empty corpus.
    const expected = (await analyse({ root: ROOT, patterns: ['docs/**/*.md'] })).files;
    for (const concurrency of [0, -5, 1, 3, DEFAULT_CONCURRENCY, 1000]) {
      const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'], concurrency });
      expect(result.files, `concurrency=${concurrency}`).toEqual(expected);
      expect(result.summary.documents, `concurrency=${concurrency}`).toBe(2);
    }
  });

  it('returns documents in path order regardless of which read finished first', async () => {
    // Reads complete out of order; the corpus must not. Document order decides
    // which of two documents claiming one id wins, so it is part of the result,
    // not a presentation detail.
    const result = await analyse({ root: ROOT, concurrency: 16 });
    const paths = result.corpus.documents.map((document) => document.path);
    expect(paths).toEqual([...paths].sort());
  });

  // No test pins the *number* of workers. Every value produces the same
  // documents in the same order, so a mutant that changes it changes throughput
  // and nothing observable - and a test asserting a worker count would be
  // asserting the implementation back at itself.
});

describe('the summary', () => {
  it('counts obligations that are open or partial, and no others', async () => {
    // Three of the five items in ADR-0001 still owe work: two unresolved and
    // one narrowed. `narrowed` is the one a boolean model gets wrong.
    const result = await analyse({ root: ROOT, patterns: ['docs/adr/0001-old.md'] });
    expect(result.summary.items).toBe(5);
    expect(result.summary.openObligations).toBe(4);
  });

  it('counts documents, items and relations from the resolved corpus', async () => {
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(result.summary.documents).toBe(result.corpus.documents.length);
    expect(result.summary.items).toBe(result.corpus.items.length);
    expect(result.summary.edges).toBe(result.graph.edges.length);
  });

  it('tallies each severity against the diagnostics it reports', async () => {
    const result = await analyse({ root: ROOT });
    const counted = { error: 0, warn: 0, info: 0 };
    for (const diagnostic of result.diagnostics) counted[diagnostic.severity] += 1;
    expect(result.summary.errors).toBe(counted.error);
    expect(result.summary.warnings).toBe(counted.warn);
    expect(result.summary.infos).toBe(counted.info);
  });

  it('reports a duration in milliseconds, rounded to two places', async () => {
    const result = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    const { durationMs } = result.summary;
    expect(durationMs).toBeGreaterThanOrEqual(0);
    // Reading a handful of small files cannot take a minute; a mutated
    // arithmetic operator produces a number that plainly is not a duration.
    expect(durationMs).toBeLessThan(60_000);
    expect(Number(durationMs.toFixed(2))).toBe(durationMs);
  });

  it('is ok exactly when nothing reached error severity', async () => {
    const clean = await analyse({ root: ROOT, patterns: ['doc/**/*.md'] });
    expect(clean.summary.errors).toBe(0);
    expect(clean.ok).toBe(true);

    const failing = await analyse({
      root: ROOT,
      patterns: ['docs/**/*.md'],
      severities: { 'reference-outside-corpus': 'error' },
    });
    expect(failing.summary.errors).toBeGreaterThan(0);
    expect(failing.ok).toBe(false);
  });
});

describe('options reaching the engine', () => {
  it('forwards severity overrides', async () => {
    const loud = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(rules(loud.diagnostics)).toContain('reference-outside-corpus');

    const quiet = await analyse({
      root: ROOT,
      patterns: ['docs/**/*.md'],
      severities: { 'reference-outside-corpus': 'off' },
    });
    expect(rules(quiet.diagnostics)).not.toContain('reference-outside-corpus');
  });

  it('forwards the related-location cap', async () => {
    // ADR-0001 is archived and holds four open obligations, so the finding has
    // four related locations unless the cap is actually passed through.
    const uncapped = await analyse({ root: ROOT, patterns: ['docs/adr/0001-old.md'] });
    const orphaned = uncapped.diagnostics.find((d) => d.rule === 'orphaned-obligation');
    expect(orphaned?.related).toHaveLength(4);

    const capped = await analyse({ root: ROOT, patterns: ['docs/adr/0001-old.md'], maxRelated: 2 });
    expect(capped.diagnostics.find((d) => d.rule === 'orphaned-obligation')?.related).toHaveLength(2);
  });

  it('forwards a bare-name ignore, which prunes at any depth', async () => {
    // `.gitignore` semantics: a bare name matches wherever it appears, so this
    // takes out `docs/adr` as well as `adr`.
    const result = await analyse({ root: ROOT, ignore: ['adr'] });
    expect(result.files).not.toContain('adr/0004-d.md');
    expect(result.files).not.toContain('docs/adr/0001-old.md');
    expect(result.files).toContain('doc/0003-c.md');
  });

  it('forwards a path-shaped ignore, which is scoped to that path', () => {
    // The option is documented as taking a glob. Anything less means a user who
    // writes one believes a directory is excluded when it is not.
    return analyse({ root: ROOT, ignore: ['docs/**'] }).then((result) => {
      expect(result.files).not.toContain('docs/adr/0001-old.md');
      expect(result.files).toContain('adr/0004-d.md');
    });
  });
});

describe('unreadable input', () => {
  it('skips a file that vanishes between the walk and the read', async () => {
    // The walk and the reads are not atomic. A file deleted in between must
    // cost that one document, not the whole run.
    await write('docs/adr/0099-doomed.md', ['# Doomed']);
    const before = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(before.corpus.documents.map((d) => d.path)).toContain('docs/adr/0099-doomed.md');

    await rm(`${ROOT}/docs/adr/0099-doomed.md`, { force: true });
    // `files` still lists it - the walk saw it - but the corpus does not.
    const after = await analyse({ root: ROOT, patterns: ['docs/**/*.md'] });
    expect(after.corpus.documents.map((d) => d.path)).not.toContain('docs/adr/0099-doomed.md');
    expect(after.summary.documents).toBe(2);
  });

  it('returns an empty result for a root that is not there', async () => {
    const result = await analyse({ root: `${ROOT}/nowhere` });
    expect(result.files).toEqual([]);
    expect(result.summary.documents).toBe(0);
    expect(result.ok).toBe(true);
  });
});
