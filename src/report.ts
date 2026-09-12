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

import { fingerprintOf, type StaleEntry } from './baseline.js';
import type { SpecGraph } from './graph.js';
import type { ProjectRule } from './project-rules.js';
import { formatRef } from './source.js';
import { DEFAULT_SEVERITIES, RULE_DESCRIPTIONS, RULE_IDS } from './rules.js';
import type { AnalysisResult } from './runner.js';
import type {
  AnyRuleId,
  Diagnostic,
  Edge,
  RuleId,
  Severity,
  SourceRef,
  SpecNode,
  SuppressedRef,
} from './types.js';

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
  readonly escalated?: ReadonlySet<AnyRuleId> | undefined;
  /**
   * What a baseline accounted for on this run.
   *
   * Reported as counts rather than as a list: the point of accepted debt is
   * that nobody has to read it every time. `stale` is the ratchet - debt the
   * run did not spend and which can be struck from the file - and `ratchet`
   * says whether this run was asked to fail over it.
   *
   * `entries` carries the stale ones themselves, for the structured formats. A
   * number is enough to know the file has slack and never enough to strike it,
   * and a bot that wants to open the pull request needs the rows.
   */
  readonly baseline?:
    | {
        readonly source: string;
        readonly suppressed: number;
        readonly stale: number;
        readonly ratchet?: boolean | undefined;
        readonly entries?: readonly StaleEntry[] | undefined;
      }
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* Environment detection                                                      */
/* -------------------------------------------------------------------------- */

export interface ColorEnvironment {
  readonly isTTY?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * Host platform, defaulting to the real one.
   *
   * Injected for the same reason `env` is: without it half of
   * {@link shouldUseAscii} is unreachable from a test, and a rule about
   * Windows consoles that only Windows can exercise is a rule that breaks on
   * Windows and nowhere else.
   */
  readonly platform?: NodeJS.Platform | undefined;
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
  if ((environment.platform ?? process.platform) !== 'win32') return false;
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

  // What the repository told spec-graph to stop looking at. Only under
  // --verbose, and never as a finding: these are not defects, they are the one
  // place a configuration can make the check quieter, and a single over-broad
  // glob looks exactly like a clean repository from the outside. See ADR-0008.
  if (options.verbose && result.corpus.suppressed.length > 0) {
    for (const [target, entry] of groupSuppressed(result.corpus.suppressed)) {
      const where = entry.by === 'family' ? 'ignored family' : 'ignored reference';
      const times = entry.count === 1 ? '' : ` (${entry.count} times)`;
      lines.push(`${paint.dim(marks.info)} ${paint.location(formatRef(entry.at))}  ${paint.dim(`${where}: ${target}${times}`)}`);
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
  const baseline = options.baseline;
  if (baseline !== undefined && baseline.suppressed > 0) {
    tally.push(paint.dim(`${baseline.suppressed} accepted by ${baseline.source}`));
  }
  lines.push(tally.join(` ${marks.separator} `));

  // Under `--ratchet` a paid entry is a failure rather than a note, so it is
  // painted and worded as one.
  const ratcheted = ratchetFailed(baseline);
  if (baseline !== undefined && baseline.stale > 0) {
    // A "gone" entry is not the ratchet working, and saying so matters more
    // than the count does: the usual way to produce one is to narrow an include
    // pattern, which loses sight of a defect rather than fixing it.
    const gone = (baseline.entries ?? []).filter((entry) => entry.reason === 'gone').length;
    const because =
      gone === 0
        ? `tighten it: spec-graph check --record-baseline ${baseline.source}`
        : `${gone} of them ${gone === 1 ? 'names a document' : 'name documents'} this run did not see - check the include patterns before re-recording`;
    const text = `${baseline.stale} baseline ${plural(baseline.stale, 'entry', 'entries')} no longer ${
      baseline.stale === 1 ? 'occurs' : 'occur'
    } - ${because}`;
    lines.push(ratcheted ? `${paint.error(marks.error)} ${text}` : paint.dim(text));
  }

  lines.push(
    ratcheted
      ? `${paint.error(marks.error)} ${
          result.ok ? 'the baseline is looser than the repository' : 'the specification graph is inconsistent'
        }`
      : result.ok
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
  escalated: ReadonlySet<AnyRuleId>,
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

function plural(count: number, word: string, plural?: string): string {
  if (count === 1) return word;
  return plural ?? `${word}s`;
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
/**
 * One row per silenced target, with the first place it was written.
 *
 * Grouped because a concept tag used forty times is one decision, and forty
 * lines of it would bury the one entry somebody needs to see. Insertion order
 * is document order, which is already deterministic.
 */
function groupSuppressed(
  suppressed: readonly SuppressedRef[],
): Map<string, { at: SourceRef; by: SuppressedRef['by']; count: number }> {
  const out = new Map<string, { at: SourceRef; by: SuppressedRef['by']; count: number }>();
  for (const entry of suppressed) {
    const seen = out.get(entry.target);
    if (seen === undefined) out.set(entry.target, { at: entry.at, by: entry.by, count: 1 });
    else seen.count += 1;
  }
  return out;
}

/**
 * True when a baseline was asked to ratchet and has slack left in it.
 *
 * Both reporters ask, because both have to agree with the exit code: a report
 * that prints "ok" above a failing build is worse than no report.
 */
function ratchetFailed(baseline: ReporterOptions['baseline']): boolean {
  return baseline !== undefined && baseline.ratchet === true && baseline.stale > 0;
}

/* -------------------------------------------------------------------------- */
/* SARIF                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The static-analysis interchange format, for the tools that already read it.
 *
 * The reason to emit it is not the format, it is what consumes the format:
 * GitHub code scanning turns a SARIF upload into annotations on the diff, and
 * an editor turns it into the problems pane, neither of which needs a line of
 * spec-graph-specific integration.
 *
 * One field earns the whole exercise. `partialFingerprints` is how a consumer
 * tracks a finding across commits without keying on a line number, and
 * spec-graph already has exactly that identifier for exactly that reason - the
 * `rule/document/subject` triple a baseline is keyed on (ADR-0012). The two
 * problems turned out to be the same problem, so the answer is the same answer.
 *
 * Deterministic and timestamp-free, like every other output here. Nothing about
 * a run that has the same findings should produce a different file.
 */
export function formatSarif(
  result: AnalysisResult,
  graph: SpecGraph,
  options: {
    version?: string | undefined;
    escalated?: ReadonlySet<AnyRuleId> | undefined;
    projectRules?: readonly ProjectRule[] | undefined;
  } = {},
): string {
  const escalated = options.escalated ?? EMPTY_RULES;
  // A project rule describes itself by the selector it is, because that is the
  // only honest answer: its message is a template, and a template with `{0}` in
  // it is not a description of anything. See ADR-0016.
  const known: [AnyRuleId, string, Severity][] = [
    ...RULE_IDS.map((id): [AnyRuleId, string, Severity] => [id, RULE_DESCRIPTIONS[id], DEFAULT_SEVERITIES[id]]),
    ...(options.projectRules ?? []).map((rule): [AnyRuleId, string, Severity] => [
      rule.id,
      rule.sources.join(' | '),
      rule.severity,
    ]),
  ];
  const fired = known.filter(([id]) => result.diagnostics.some((diagnostic) => diagnostic.rule === id));
  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'spec-graph',
              informationUri: 'https://github.com/DescentVTT/spec-graph',
              ...(options.version === undefined ? {} : { version: options.version, semanticVersion: options.version }),
              // Only the rules that fired. A driver listing all of them
              // describes the tool; this file describes the run.
              rules: fired.map(([id, description, level]) => ({
                id,
                shortDescription: { text: description },
                defaultConfiguration: { level: sarifLevel(level) },
              })),
            },
          },
          results: result.diagnostics.map((diagnostic) => {
            const print = fingerprintOf(graph, diagnostic);
            return {
              ruleId: diagnostic.rule,
              level: sarifLevel(diagnostic.severity),
              message: { text: `${diagnostic.message}. ${diagnostic.hint}` },
              locations: [sarifLocation(diagnostic.at)],
              ...(diagnostic.related.length === 0
                ? {}
                : {
                    relatedLocations: diagnostic.related.map((entry) => ({
                      ...sarifLocation(entry.at),
                      message: { text: entry.note },
                    })),
                  }),
              partialFingerprints: {
                specGraphIdentity: `${diagnostic.rule}/${print.document}/${print.subject}`,
              },
              properties: {
                nodes: diagnostic.nodes,
                target: diagnostic.target,
                // A finding that is only an error because of a flag says so
                // here too, so a reviewer reading an annotation is not misled.
                escalated: escalated.has(diagnostic.rule),
              },
            };
          }),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function sarifLevel(severity: Severity): string {
  switch (severity) {
    case 'error':
      return 'error';
    case 'warn':
      return 'warning';
    case 'info':
      return 'note';
    default:
      return 'none';
  }
}

function sarifLocation(at: SourceRef): {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  };
} {
  return {
    physicalLocation: {
      // Already repository-relative and POSIX, which is what SARIF asks for.
      artifactLocation: { uri: at.file },
      region: {
        startLine: at.span.start.line,
        startColumn: at.span.start.column,
        endLine: at.span.end.line,
        endColumn: at.span.end.column,
      },
    },
  };
}

export function formatJson(
  result: AnalysisResult,
  options: { escalated?: ReadonlySet<AnyRuleId>; baseline?: ReporterOptions['baseline'] } = {},
): string {
  const escalated = options.escalated ?? EMPTY_RULES;
  return `${JSON.stringify(
    {
      version: 1,
      ok: result.ok && !ratchetFailed(options.baseline),
      strict: escalated.size > 0,
      ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
      summary: result.summary,
      files: result.files,
      // The audit trail for what configuration silenced. Always present, unlike
      // the human report's --verbose gate: a machine reader that has to ask for
      // it twice will not ask. See ADR-0008.
      suppressed: result.corpus.suppressed.map((entry) => ({
        target: entry.target,
        from: entry.from,
        by: entry.by,
        file: entry.at.file,
        line: entry.at.span.start.line,
      })),
      diagnostics: result.diagnostics.map((diagnostic) => ({
        rule: diagnostic.rule,
        severity: diagnostic.severity,
        // True when this finding is only an error because of --strict.
        escalated: escalated.has(diagnostic.rule),
        message: diagnostic.message,
        hint: diagnostic.hint,
        nodes: diagnostic.nodes,
        target: diagnostic.target,
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
          // Containment of an *item* is what hiding items makes redundant.
          // Containment of a specification by the register that holds it is
          // structure between documents, and is what this view exists to show.
          .filter((edge) => edge.kind !== 'contains' || visible.has(edge.to))
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
  record: '#f3e8fd',
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
