/**
 * Output formatting.
 *
 * Two audiences, one set of facts. In a terminal the report leads with the file
 * and line so an editor can jump there, indents the supporting evidence, and
 * ends with a concrete next action - because a finding a reader cannot act on
 * is a finding they will learn to scroll past. In CI it emits JSON with every
 * position intact, so a bot can annotate a diff.
 *
 * Colour is opt-out and auto-detected, and the glyphs degrade to ASCII when the
 * terminal cannot render them.
 */

import type { SpecGraph } from './graph.js';
import { formatRef } from './source.js';
import type { AnalysisResult } from './runner.js';
import type { Diagnostic, Edge, RuleId, Severity, SpecNode } from './types.js';

export interface ReporterOptions {
  readonly color?: boolean | undefined;
  readonly ascii?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  /** Stop after this many findings. `0` means no limit. */
  readonly max?: number | undefined;
  /**
   * Rules whose severity `--strict` raised.
   *
   * A finding that only became an error because of a flag has to say so, or the
   * reader cannot tell what would happen without it.
   */
  readonly escalated?: ReadonlySet<RuleId> | undefined;
}

/* -------------------------------------------------------------------------- */
/* Environment detection                                                      */
/* -------------------------------------------------------------------------- */

export interface ColorEnvironment {
  readonly isTTY?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Honours `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` before falling back to TTY. */
export function shouldUseColor(environment: ColorEnvironment = {}): boolean {
  const env = environment.env ?? process.env;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  // `FORCE_COLOR=0` is the conventional way to turn colour off, so it has to
  // win over an attached TTY rather than merely failing to force it on.
  if (env['FORCE_COLOR'] === '0') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '') return true;
  if (env['TERM'] === 'dumb') return false;
  if (env['CI'] !== undefined && env['CI'] !== '') return false;
  return environment.isTTY === true;
}

/** True when the terminal is unlikely to render box-drawing and arrows. */
export function shouldUseAscii(environment: ColorEnvironment = {}): boolean {
  const env = environment.env ?? process.env;
  if (env['SPEC_GRAPH_ASCII'] !== undefined && env['SPEC_GRAPH_ASCII'] !== '') return true;
  if (process.platform !== 'win32') return false;
  // Windows Terminal and modern shells set these; the legacy console does not.
  return env['WT_SESSION'] === undefined && env['TERM_PROGRAM'] === undefined;
}

const EMPTY_RULES: ReadonlySet<RuleId> = new Set<RuleId>();

type Paint = (text: string) => string;

export interface Painter {
  readonly error: Paint;
  readonly warn: Paint;
  readonly info: Paint;
  readonly dim: Paint;
  readonly bold: Paint;
  readonly hint: Paint;
  readonly location: Paint;
}

export function createPainter(color: boolean): Painter {
  const wrap = (open: string): Paint => (text) => (color ? `\u001b[${open}m${text}\u001b[0m` : text);
  return {
    error: wrap('31'),
    warn: wrap('33'),
    info: wrap('36'),
    dim: wrap('2'),
    bold: wrap('1'),
    hint: wrap('32'),
    location: wrap('4'),
  };
}

interface Glyphs {
  readonly error: string;
  readonly warn: string;
  readonly info: string;
  readonly related: string;
  readonly hint: string;
  readonly separator: string;
}

function glyphs(ascii: boolean): Glyphs {
  return ascii
    ? { error: 'x', warn: '!', info: 'i', related: '|', hint: '>', separator: '-' }
    : { error: '\u2716', warn: '\u26a0', info: '\u2139', related: '\u21b3', hint: '\u2192', separator: '\u00b7' };
}

/* -------------------------------------------------------------------------- */
/* Human report                                                               */
/* -------------------------------------------------------------------------- */

/** Renders the full terminal report. */
export function formatReport(result: AnalysisResult, options: ReporterOptions = {}): string {
  const paint = createPainter(options.color ?? false);
  const marks = glyphs(options.ascii ?? false);
  const lines: string[] = [];
  const { summary } = result;

  lines.push(
    `${paint.bold('spec-graph')} ${paint.dim(
      [
        `${summary.documents} ${plural(summary.documents, 'document')}`,
        `${summary.items} ${plural(summary.items, 'item')}`,
        `${summary.edges} ${plural(summary.edges, 'relation')}`,
        `${summary.openObligations} open`,
      ].join(` ${marks.separator} `),
    )}`,
  );
  lines.push('');

  const limit = options.max && options.max > 0 ? options.max : result.diagnostics.length;
  const shown = result.diagnostics.slice(0, limit);

  const escalated = options.escalated ?? EMPTY_RULES;
  for (const diagnostic of shown) {
    lines.push(...formatDiagnostic(diagnostic, paint, marks, escalated));
    lines.push('');
  }

  if (result.diagnostics.length > shown.length) {
    lines.push(paint.dim(`  ... and ${result.diagnostics.length - shown.length} more`));
    lines.push('');
  }

  if (options.verbose && result.problems.length > 0) {
    for (const problem of result.problems) {
      lines.push(`${paint.warn(marks.warn)} ${paint.location(formatRef(problem.at))}  ${problem.message}`);
    }
    lines.push('');
  }

  const tally: string[] = [];
  if (summary.errors > 0) tally.push(paint.error(`${summary.errors} ${plural(summary.errors, 'error')}`));
  if (summary.warnings > 0) tally.push(paint.warn(`${summary.warnings} ${plural(summary.warnings, 'warning')}`));
  if (summary.infos > 0) tally.push(paint.info(`${summary.infos} ${plural(summary.infos, 'note')}`));
  tally.push(paint.dim(`${summary.durationMs}ms`));
  const raised = result.diagnostics.filter((diagnostic) => escalated.has(diagnostic.rule)).length;
  if (raised > 0) {
    tally.push(paint.warn(`${raised} raised by --strict`));
  }
  lines.push(tally.join(` ${marks.separator} `));

  lines.push(
    result.ok
      ? `${paint.hint(marks.hint === '>' ? 'ok' : '\u2714')} ${
          summary.errors + summary.warnings === 0
            ? 'the specification graph is consistent'
            : 'no errors - the specification graph holds'
        }`
      : `${paint.error(marks.error)} the specification graph is inconsistent`,
  );

  return lines.join('\n');
}

function formatDiagnostic(
  diagnostic: Diagnostic,
  paint: Painter,
  marks: Glyphs,
  escalated: ReadonlySet<RuleId>,
): string[] {
  const mark = severityMark(diagnostic.severity, paint, marks);
  const label = escalated.has(diagnostic.rule)
    ? `${diagnostic.rule} ${paint.warn('(strict: warn -> error)')}`
    : diagnostic.rule;
  const lines: string[] = [
    `${mark} ${paint.location(formatRef(diagnostic.at))}  ${paint.dim(label)}`,
    `    ${diagnostic.message}`,
  ];

  const width = Math.max(0, ...diagnostic.related.map((entry) => formatRef(entry.at).length));
  for (const entry of diagnostic.related) {
    const reference = formatRef(entry.at);
    lines.push(`    ${paint.dim(marks.related)} ${paint.dim(reference.padEnd(width))}  ${paint.dim(entry.note)}`);
  }

  lines.push(`    ${paint.hint(marks.hint)} ${paint.hint(diagnostic.hint)}`);
  return lines;
}

function severityMark(severity: Exclude<Severity, 'off'>, paint: Painter, marks: Glyphs): string {
  switch (severity) {
    case 'error':
      return paint.error(marks.error);
    case 'warn':
      return paint.warn(marks.warn);
    case 'info':
      return paint.info(marks.info);
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The machine-readable report.
 *
 * Deliberately flat and versioned: this is the contract a CI annotator or a
 * dashboard builds against, and it must be safe to add fields to it later.
 */
export function formatJson(result: AnalysisResult, options: { escalated?: ReadonlySet<RuleId> } = {}): string {
  const escalated = options.escalated ?? EMPTY_RULES;
  return `${JSON.stringify(
    {
      version: 1,
      ok: result.ok,
      strict: escalated.size > 0,
      summary: result.summary,
      files: result.files,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        rule: diagnostic.rule,
        severity: diagnostic.severity,
        // True when this finding is only an error because of --strict.
        escalated: escalated.has(diagnostic.rule),
        message: diagnostic.message,
        hint: diagnostic.hint,
        nodes: diagnostic.nodes,
        file: diagnostic.at.file,
        line: diagnostic.at.span.start.line,
        column: diagnostic.at.span.start.column,
        endLine: diagnostic.at.span.end.line,
        endColumn: diagnostic.at.span.end.column,
        related: diagnostic.related.map((entry) => ({
          file: entry.at.file,
          line: entry.at.span.start.line,
          column: entry.at.span.start.column,
          note: entry.note,
        })),
      })),
      problems: result.problems.map((problem) => ({
        message: problem.message,
        file: problem.at.file,
        line: problem.at.span.start.line,
      })),
    },
    null,
    2,
  )}\n`;
}

/* -------------------------------------------------------------------------- */
/* Graph export                                                               */
/* -------------------------------------------------------------------------- */

export type GraphFormat = 'dot' | 'mermaid' | 'json';

export interface GraphExportOptions {
  /** Leave out `contains` edges and item nodes. */
  readonly documentsOnly?: boolean | undefined;
}

/** Serialises the graph for Graphviz, Mermaid, or a downstream tool. */
export function formatGraph(graph: SpecGraph, format: GraphFormat, options: GraphExportOptions = {}): string {
  const skipItems = options.documentsOnly ?? false;
  const nodes = [...graph.nodes.values()].filter((node) => !skipItems || node.kind === 'document');
  const visible = new Set(nodes.map((node) => node.id));

  // Hiding items must not hide what they say. An obligation delegated from an
  // item to a document is lifted onto the item's owner, so the document-level
  // view still shows the handover rather than silently losing it.
  const lifted = skipItems
    ? dedupeEdges(
        graph.edges
          .filter((edge) => edge.kind !== 'contains')
          .map((edge) => {
            const from = graph.owningDocument(edge.from)?.id ?? edge.from;
            const to = graph.owningDocument(edge.to)?.id ?? edge.to;
            return from === edge.from && to === edge.to ? edge : { ...edge, from, to, reflexive: from === to };
          })
          .filter((edge) => !edge.reflexive),
      )
    : graph.edges;

  const edges = lifted.filter((edge) => visible.has(edge.from) && visible.has(edge.to));

  switch (format) {
    case 'dot':
      return toDot(nodes, edges);
    case 'mermaid':
      return toMermaid(nodes, edges);
    case 'json':
      return `${JSON.stringify(
        {
          version: 1,
          nodes: nodes.map(serialiseNode),
          edges: edges.map((edge) => ({
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
            origin: edge.origin,
            declaredIn: edge.declaredIn,
            file: edge.declaredAt.file,
            line: edge.declaredAt.span.start.line,
          })),
        },
        null,
        2,
      )}\n`;
  }
}

/** Collapses duplicate relations produced by lifting item edges onto documents. */
function dedupeEdges(edges: readonly Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = `${edge.kind} ${edge.from} ${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

function serialiseNode(node: SpecNode): Record<string, unknown> {
  const base = {
    id: node.id,
    kind: node.kind,
    title: node.title,
    file: node.at.file,
    line: node.at.span.start.line,
  };
  return node.kind === 'document'
    ? { ...base, path: node.path, phase: node.phase, status: node.rawStatus, aliases: node.aliases }
    : {
        ...base,
        document: node.document,
        section: node.section,
        disposition: node.disposition,
        openness: node.openness,
      };
}

/** Phase colours, chosen to stay legible in both light and dark renderings. */
const PHASE_FILL: Readonly<Record<string, string>> = {
  draft: '#e8f0fe',
  active: '#e6f4ea',
  frozen: '#e8eaed',
  retired: '#fce8e6',
  unknown: '#ffffff',
};

function toDot(nodes: readonly SpecNode[], edges: readonly Edge[]): string {
  const lines = ['digraph spec {', '  rankdir=LR;', '  node [shape=box, style="rounded,filled", fontname="sans"];'];
  for (const node of nodes) {
    const fill = node.kind === 'document' ? (PHASE_FILL[node.phase] ?? '#ffffff') : '#fffbe6';
    const label = node.kind === 'document' ? `${node.id}\\n${escapeDot(node.title)}` : escapeDot(node.text);
    const shape = node.kind === 'document' ? 'box' : 'note';
    lines.push(`  "${escapeDot(node.id)}" [label="${label}", fillcolor="${fill}", shape=${shape}];`);
  }
  for (const edge of edges) {
    const style = edge.kind === 'contains' ? ', style=dotted' : '';
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${edge.kind}"${style}];`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function toMermaid(nodes: readonly SpecNode[], edges: readonly Edge[]): string {
  const lines = ['graph LR'];
  const alias = new Map<string, string>();
  nodes.forEach((node, position) => alias.set(node.id, `n${position}`));

  for (const node of nodes) {
    const key = alias.get(node.id) as string;
    const label = escapeMermaid(node.kind === 'document' ? node.id : node.text);
    lines.push(node.kind === 'document' ? `  ${key}["${label}"]` : `  ${key}(["${label}"])`);
    if (node.kind === 'document' && node.phase !== 'unknown') lines.push(`  class ${key} ${node.phase};`);
  }
  for (const edge of edges) {
    const from = alias.get(edge.from);
    const to = alias.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} -->|${edge.kind}| ${to}`);
  }
  for (const [phase, fill] of Object.entries(PHASE_FILL)) {
    if (phase === 'unknown') continue;
    lines.push(`  classDef ${phase} fill:${fill},stroke:#5f6368;`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeDot(value: string): string {
  return value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\n');
}

function escapeMermaid(value: string): string {
  return value.replace(/["#]/g, ' ').replace(/\s+/g, ' ').trim();
}
