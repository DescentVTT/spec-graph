/**
 * Accepted debt, and the ratchet that keeps it from growing.
 *
 * A linter introduced to a repository that predates it reports everything at
 * once. Fifty findings on day one is not a report, it is a decision to be
 * ignored: the team cannot stop to fix them, so they turn the tool off, or they
 * turn the rules off and the next specification rots unwatched.
 *
 * A baseline is the third answer. It records what was already wrong on the day
 * the tool arrived, and reports only what happened since. Debt can be paid down
 * whenever there is room, and in the meantime nothing new gets in.
 *
 * The whole module is pure. Reading and writing the file is the CLI's job, for
 * the same reason extraction never touches a disk.
 */

import type { SpecGraph } from './graph.js';
import { RULE_IDS } from './rules.js';
import type { Diagnostic, RuleId } from './types.js';

/** The current file format. Bumped only for a change old files cannot survive. */
export const BASELINE_VERSION = 1;

/** One class of accepted finding, and how many of it there were. */
export interface BaselineEntry {
  readonly rule: RuleId;
  /** The specification the finding is about, not the file it was found in. */
  readonly document: string;
  /** What within it: a citation target, or the document at the other end. */
  readonly subject: string;
  readonly count: number;
}

export interface Baseline {
  readonly version: number;
  readonly findings: readonly BaselineEntry[];
}

export const EMPTY_BASELINE: Baseline = Object.freeze({ version: BASELINE_VERSION, findings: [] });

/**
 * What makes two findings the same finding.
 *
 * Not the line. A baseline keyed on line numbers is invalidated by any edit
 * above it, which turns every unrelated pull request into a wall of findings
 * nobody introduced. Not the message either: rewording a diagnostic would
 * silently expire every baseline in the world.
 *
 * What survives is the pair the finding is actually about - which specification,
 * and what within it. Both are ids that outlive a file being renamed, a section
 * being moved into its own file, or an obligation being reordered, because that
 * is exactly what identifiers were made stable for (ADR-0009).
 *
 * The cost is deliberate coarseness: two broken links from one document to the
 * same target are one entry with a count of two. Paying that buys a baseline
 * that does not lie the first time somebody reformats a paragraph.
 */
export function fingerprintOf(graph: SpecGraph, diagnostic: Diagnostic): { document: string; subject: string } {
  const first = diagnostic.nodes[0] ?? '';
  const document = graph.owningDocument(first)?.id ?? first;
  if (diagnostic.target !== null) return { document, subject: diagnostic.target };

  const second = diagnostic.nodes[1];
  const subject = second === undefined ? '' : (graph.owningDocument(second)?.id ?? second);
  // A document-level rule lists its own items as the rest of `nodes`, so the
  // other end resolves back to where it started. Saying so twice in the file
  // would only invite a reader to look for a distinction that is not there.
  return { document, subject: subject === document ? '' : subject };
}

function keyOf(rule: RuleId, document: string, subject: string): string {
  // Tab-joined: the three parts are ids and targets, and a tab is the one
  // character none of them can contain.
  return `${rule}\t${document}\t${subject}`;
}

/** Counts findings by fingerprint. */
function tally(graph: SpecGraph, diagnostics: readonly Diagnostic[]): Map<string, BaselineEntry> {
  const out = new Map<string, BaselineEntry>();
  for (const diagnostic of diagnostics) {
    const { document, subject } = fingerprintOf(graph, diagnostic);
    const key = keyOf(diagnostic.rule, document, subject);
    const seen = out.get(key);
    out.set(key, {
      rule: diagnostic.rule,
      document,
      subject,
      count: (seen?.count ?? 0) + 1,
    });
  }
  return out;
}

/**
 * Renders a baseline for the findings given.
 *
 * Sorted by rule, then document, then subject, and written with two-space
 * indentation: the file lands in a repository and is read in diffs, so its byte
 * order has to be a function of its content and nothing else. No timestamp, for
 * the same reason - a generated date makes every re-record a change even when
 * nothing changed.
 */
export function formatBaseline(graph: SpecGraph, diagnostics: readonly Diagnostic[]): string {
  const findings = [...tally(graph, diagnostics).values()].sort(compareEntries);
  return `${JSON.stringify({ version: BASELINE_VERSION, findings }, null, 2)}\n`;
}

function compareEntries(a: BaselineEntry, b: BaselineEntry): number {
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.document !== b.document) return a.document < b.document ? -1 : 1;
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
  return 0;
}

export interface ParsedBaseline {
  readonly baseline: Baseline;
  /** Reported, never silently dropped. A baseline nobody can read is worse
   * than none: it suppresses findings the reader cannot account for. */
  readonly problems: readonly string[];
}

/** Parses a baseline file. Never throws; an unusable file yields an empty one. */
export function parseBaseline(raw: string, source: string): ParsedBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    return { baseline: EMPTY_BASELINE, problems: [`${source} is not valid JSON: ${(error as Error).message}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { baseline: EMPTY_BASELINE, problems: [`${source} must contain a JSON object`] };
  }

  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (record['version'] !== BASELINE_VERSION) {
    return {
      baseline: EMPTY_BASELINE,
      problems: [`${source} is version ${String(record['version'])}, and this build reads version ${BASELINE_VERSION}`],
    };
  }

  const rows = record['findings'];
  if (!Array.isArray(rows)) {
    return { baseline: EMPTY_BASELINE, problems: [`${source}: "findings" must be an array`] };
  }

  const findings: BaselineEntry[] = [];
  for (const [index, row] of rows.entries()) {
    const entry = readEntry(row, `${source}: findings[${index}]`, problems);
    if (entry !== null) findings.push(entry);
  }
  return { baseline: { version: BASELINE_VERSION, findings }, problems };
}

function readEntry(row: unknown, where: string, problems: string[]): BaselineEntry | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const fields = row as Record<string, unknown>;
  const rule = fields['rule'];
  if (typeof rule !== 'string' || !RULE_IDS.includes(rule as RuleId)) {
    problems.push(`${where}: unknown rule ${JSON.stringify(rule)}`);
    return null;
  }
  const document = fields['document'];
  const subject = fields['subject'] ?? '';
  const count = fields['count'] ?? 1;
  if (typeof document !== 'string' || typeof subject !== 'string') {
    problems.push(`${where}: "document" and "subject" must be strings`);
    return null;
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    problems.push(`${where}: "count" must be a whole number of at least 1`);
    return null;
  }
  return { rule: rule as RuleId, document, subject, count };
}

export interface BaselineOutcome {
  /** Findings the baseline does not account for. These are the report. */
  readonly kept: readonly Diagnostic[];
  /** How many were accounted for. Reported as a number, not as a list. */
  readonly suppressed: number;
  /**
   * Entries whose debt has been paid, wholly or partly.
   *
   * The ratchet: once a repository is clean of something, saying so in the file
   * stops it coming back unnoticed.
   */
  readonly stale: readonly BaselineEntry[];
}

/**
 * Removes the findings a baseline accounts for.
 *
 * Where a baseline allows two of something and three exist, one is reported.
 * Which one is not a meaningful question - they share a fingerprint - so the
 * findings are taken in report order and the surplus is what is left.
 */
export function applyBaseline(
  graph: SpecGraph,
  diagnostics: readonly Diagnostic[],
  baseline: Baseline,
): BaselineOutcome {
  const budget = new Map<string, number>();
  for (const entry of baseline.findings) {
    const key = keyOf(entry.rule, entry.document, entry.subject);
    budget.set(key, (budget.get(key) ?? 0) + entry.count);
  }

  const kept: Diagnostic[] = [];
  let suppressed = 0;
  for (const diagnostic of diagnostics) {
    const { document, subject } = fingerprintOf(graph, diagnostic);
    const key = keyOf(diagnostic.rule, document, subject);
    const left = budget.get(key) ?? 0;
    if (left <= 0) {
      kept.push(diagnostic);
      continue;
    }
    budget.set(key, left - 1);
    suppressed += 1;
  }

  const stale: BaselineEntry[] = [];
  for (const entry of baseline.findings) {
    const key = keyOf(entry.rule, entry.document, entry.subject);
    const unspent = budget.get(key) ?? 0;
    if (unspent <= 0) continue;
    stale.push({ ...entry, count: Math.min(unspent, entry.count) });
    // An entry counted once; a duplicate key in a hand-edited file must not
    // claim the same surplus twice.
    budget.set(key, 0);
  }

  return { kept, suppressed, stale: stale.sort(compareEntries) };
}
