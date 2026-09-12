/**
 * Orchestration: files in, graph and findings out.
 *
 * The only part of spec-graph that touches the filesystem. Everything below it
 * is a pure function of text, which is why the test suite can build pathological
 * corpora in memory and why a build script can feed spec-graph documents that
 * never existed on disk.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { extractSpecifications, type ExtractedDocument } from './extract.js';
import { createGlobMatcher, createReferenceFilter, walkFiles, type WalkedFile } from './glob.js';
import { buildGraph, type SpecGraph } from './graph.js';
import { toPosix } from './paths.js';
import { resolveCorpus, type ResolvedCorpus } from './resolve.js';
import type { ProjectRule } from './project-rules.js';
import { runRules, type RuleOptions } from './rules.js';
import type { AnalysisSummary, AnyRuleId, Diagnostic, ParseProblem, Severity } from './types.js';

/** Patterns used when the caller names none. */
export const DEFAULT_PATTERNS: readonly string[] = Object.freeze([
  'docs/**/*.md',
  'doc/**/*.md',
  'adr/**/*.md',
  'rfcs/**/*.md',
  'specs/**/*.md',
  '*.md',
]);

/** How many files are read at once. */
export const DEFAULT_CONCURRENCY = 16;

export interface AnalyseOptions {
  /** Absolute or relative directory the patterns are resolved against. */
  readonly root: string;
  readonly patterns?: readonly string[] | undefined;
  readonly ignore?: readonly string[] | undefined;
  /**
   * Reference targets to leave unreported when they do not resolve.
   *
   * For repositories where `[[...]]` tags concepts rather than naming files.
   * Suppresses findings only; a reference that resolves is still an edge.
   */
  readonly ignoreReferences?: readonly string[] | undefined;
  /** Families a bare identifier may name. Unset means any family in the corpus. */
  readonly families?: readonly string[] | undefined;
  /** Families that are never citations, whatever the corpus contains. */
  readonly ignoreFamilies?: readonly string[] | undefined;
  /**
   * Files that are logs of what was decided rather than decisions.
   *
   * Journals, changelogs, meeting minutes, sprint summaries. Their references
   * are still checked; their obligations and lifecycle are not. See ADR-0011.
   */
  readonly historyPatterns?: readonly string[] | undefined;
  readonly severities?: Partial<Record<AnyRuleId, Severity>> | undefined;
  /** Conventions the repository wrote for itself. See ADR-0016. */
  readonly projectRules?: readonly ProjectRule[] | undefined;
  readonly concurrency?: number | undefined;
  readonly maxRelated?: number | undefined;
  readonly followSymlinks?: boolean | undefined;
}

export interface AnalysisResult {
  readonly graph: SpecGraph;
  readonly corpus: ResolvedCorpus;
  readonly diagnostics: readonly Diagnostic[];
  readonly problems: readonly ParseProblem[];
  readonly files: readonly string[];
  readonly summary: AnalysisSummary;
  /** True when nothing at error severity was found. */
  readonly ok: boolean;
}

/** Reads, extracts, resolves, and checks a corpus of specifications. */
export async function analyse(options: AnalyseOptions): Promise<AnalysisResult> {
  const started = performance.now();
  const root = toPosix(options.root).replace(/\/+$/, '');
  const patterns = options.patterns && options.patterns.length > 0 ? options.patterns : DEFAULT_PATTERNS;

  const walked = await walkFiles({
    root,
    patterns,
    ignore: options.ignore,
    followSymlinks: options.followSymlinks,
  });

  const sources = await readAll(walked, options.concurrency ?? DEFAULT_CONCURRENCY);
  const present = new Set(walked.map((file) => file.path.toLowerCase()));

  return finish(
    analyseSources(sources, {
      // Consulted only for references that failed to resolve, so the cost is
      // bounded by the number of findings - and it buys the difference between
      // "that document does not exist" and "that document exists but your
      // include patterns did not reach it", which are different fixes.
      fileExists: (path) => present.has(path.toLowerCase()) || existsSync(`${root}/${path}`),
      isIgnoredReference: createReferenceFilter(options.ignoreReferences ?? []),
      isIgnoredFamily: createFamilyFilter(options.families, options.ignoreFamilies),
      isRecord: createHistoryMatcher(options.historyPatterns),
      ...(options.severities !== undefined ? { severities: options.severities } : {}),
      ...(options.projectRules !== undefined ? { projectRules: options.projectRules } : {}),
      ...(options.maxRelated !== undefined ? { maxRelated: options.maxRelated } : {}),
    }),
    walked.map((file) => file.path),
    started,
  );
}

export interface Source {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly text: string;
}

export interface AnalyseSourcesOptions extends RuleOptions {
  readonly fileExists?: ((path: string) => boolean) | undefined;
  readonly isIgnoredReference?: ((target: string) => boolean) | undefined;
  readonly isIgnoredFamily?: ((family: string) => boolean) | undefined;
  /** Whether a path holds a historical record rather than a specification. */
  readonly isRecord?: ((path: string) => boolean) | undefined;
}

/**
 * Builds the record predicate, or nothing when no patterns were given.
 *
 * Returning `undefined` rather than a predicate that always says no keeps the
 * common case free of a call per file, and makes "no history patterns" visible
 * as an absent option rather than as a function nobody can read.
 */
export function createHistoryMatcher(patterns: readonly string[] | undefined): ((path: string) => boolean) | undefined {
  if (patterns === undefined || patterns.length === 0) return undefined;
  return createGlobMatcher(patterns);
}

/**
 * Builds the family predicate from an allowlist and a denylist.
 *
 * An allowlist is the stronger statement - "these are the families this
 * repository has" - and turns every other noun-number construct back into
 * prose. A denylist handles the narrower case where the corpus genuinely owns a
 * family but some of its numbers belong to somebody else, which is exactly
 * `RFC 2119` in a repository of local RFCs.
 */
export function createFamilyFilter(
  families: readonly string[] | undefined,
  ignoreFamilies: readonly string[] | undefined,
): ((family: string) => boolean) | undefined {
  const allowed = families && families.length > 0 ? new Set(families.map((f) => f.trim().toUpperCase())) : null;
  const denied = new Set((ignoreFamilies ?? []).map((f) => f.trim().toUpperCase()));
  if (allowed === null && denied.size === 0) return undefined;
  return (family: string): boolean => {
    const key = family.toUpperCase();
    if (denied.has(key)) return true;
    return allowed !== null && !allowed.has(key);
  };
}

interface Analysed {
  readonly graph: SpecGraph;
  readonly corpus: ResolvedCorpus;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The whole engine, without a filesystem.
 *
 * Exported because it is the honest unit of composition: a monorepo tool that
 * already has the file contents in memory should not have to write them out to
 * a temporary directory to use spec-graph.
 */
export function analyseSources(sources: readonly Source[], options: AnalyseSourcesOptions = {}): Analysed {
  const extracted: ExtractedDocument[] = [];
  for (const source of sources) {
    extracted.push(
      ...extractSpecifications({
        path: source.path,
        text: source.text,
        record: options.isRecord?.(source.path) === true,
      }),
    );
  }

  const corpus = resolveCorpus(extracted, {
    fileExists: options.fileExists,
    isIgnoredReference: options.isIgnoredReference,
    isIgnoredFamily: options.isIgnoredFamily,
  });
  const graph = buildGraph({ nodes: corpus.nodes, edges: corpus.edges });
  const diagnostics = runRules(graph, corpus, options);
  return { graph, corpus, diagnostics };
}

function finish(analysed: Analysed, files: readonly string[], started: number): AnalysisResult {
  const { graph, corpus, diagnostics } = analysed;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  const records = new Set(corpus.documents.filter((node) => node.phase === 'record').map((node) => node.id));

  const summary: AnalysisSummary = {
    documents: corpus.documents.length,
    items: corpus.items.length,
    edges: graph.edges.length,
    // A record's unchecked boxes are minutes, not work. Counting them would
    // make the headline number the one thing in the report nobody can act on.
    openObligations: corpus.items.filter((item) => item.openness !== 'closed' && !records.has(item.document)).length,
    errors: counts.error,
    warnings: counts.warn,
    infos: counts.info,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
  };

  return {
    graph,
    corpus,
    diagnostics,
    problems: corpus.problems,
    files,
    summary,
    ok: counts.error === 0,
  };
}

/** Reads files with bounded concurrency, skipping ones that cannot be read. */
async function readAll(files: readonly WalkedFile[], concurrency: number): Promise<Source[]> {
  const out: Source[] = new Array(files.length);
  let cursor = 0;
  let written = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const file = files[index] as WalkedFile;
      try {
        const text = await readFile(file.absolute, 'utf8');
        out[written] = { path: file.path, text };
        written += 1;
      } catch {
        // A file that vanished or cannot be decoded is skipped, not fatal.
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, worker);
  await Promise.all(workers);
  out.length = written;
  // Deterministic order regardless of which worker finished first.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Rebuilds a result around a narrower set of findings.
 *
 * The corpus, the graph and the counts of what is in them are unchanged - a
 * baseline suppresses findings, never facts. Only the tallies that describe the
 * findings, and the verdict that follows from them, move.
 */
export function withDiagnostics(result: AnalysisResult, diagnostics: readonly Diagnostic[]): AnalysisResult {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return {
    ...result,
    diagnostics,
    summary: { ...result.summary, errors: counts.error, warnings: counts.warn, infos: counts.info },
    ok: counts.error === 0,
  };
}
