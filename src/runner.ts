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
import { createReferenceFilter, walkFiles, type WalkedFile } from './glob.js';
import { buildGraph, type SpecGraph } from './graph.js';
import { toPosix } from './paths.js';
import { resolveCorpus, type ResolvedCorpus } from './resolve.js';
import { runRules, type RuleOptions } from './rules.js';
import type { AnalysisSummary, Diagnostic, ParseProblem, RuleId, Severity } from './types.js';

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
  readonly severities?: Partial<Record<RuleId, Severity>> | undefined;
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
      ...(options.severities !== undefined ? { severities: options.severities } : {}),
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
    extracted.push(...extractSpecifications({ path: source.path, text: source.text }));
  }

  const corpus = resolveCorpus(extracted, {
    fileExists: options.fileExists,
    isIgnoredReference: options.isIgnoredReference,
  });
  const graph = buildGraph({ nodes: corpus.nodes, edges: corpus.edges });
  const diagnostics = runRules(graph, corpus, options);
  return { graph, corpus, diagnostics };
}

function finish(analysed: Analysed, files: readonly string[], started: number): AnalysisResult {
  const { graph, corpus, diagnostics } = analysed;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;

  const summary: AnalysisSummary = {
    documents: corpus.documents.length,
    items: corpus.items.length,
    edges: graph.edges.length,
    openObligations: corpus.items.filter((item) => item.openness !== 'closed').length,
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
