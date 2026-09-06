/**
 * The built-in diagnostics.
 *
 * Two of them - the two the whole project exists for - are written as selector
 * queries rather than as bespoke traversals. That is not a stunt: it is the
 * proof that the query language is expressive enough to be worth exposing. A
 * team whose convention spec-graph never anticipated can write the equivalent
 * of a built-in rule on the command line.
 *
 * ```text
 * ghost-handover  *[openness!=closed][phase!=retired] -delegates-to,blocked-by-> *[receptivity=sealed]
 * stale-premise   *[phase!=retired] -depends-on,assumes,amends,blocked-by-> document[phase=retired]
 * ```
 *
 * The rest are not path queries and are not pretended to be: dangling
 * references never became edges, and a cycle is not a fixed-length path.
 *
 * Every rule here obeys one discipline - **report the place a human can fix**.
 * For a supersession that the superseded document never acknowledged, that is
 * the superseded document, not the one that declared the relation.
 */

import { OBLIGATION_EDGES, type SpecGraph } from './graph.js';
import { execute, parseQuery, type QuerySpec } from './select.js';
import type { ResolvedCorpus } from './resolve.js';
import type {
  DanglingRef,
  Diagnostic,
  DocumentNode,
  Edge,
  ItemNode,
  RelatedLocation,
  RuleId,
  Severity,
  SourceRef,
  SpecNode,
} from './types.js';
import { EDGE_TRAITS } from './types.js';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const DEFAULT_SEVERITIES: Readonly<Record<RuleId, Severity>> = Object.freeze({
  'ghost-handover': 'error',
  'stale-premise': 'error',
  'broken-reference': 'error',
  'ambiguous-reference': 'warn',
  'circular-delegation': 'error',
  'orphaned-obligation': 'error',
  'live-supersession': 'error',
  'unreciprocated-supersession': 'warn',
  'state-conflict': 'warn',
  'self-reference': 'info',
});

export const RULE_IDS = Object.keys(DEFAULT_SEVERITIES) as readonly RuleId[];

/** One-line descriptions, printed by `spec-graph rules`. */
export const RULE_DESCRIPTIONS: Readonly<Record<RuleId, string>> = Object.freeze({
  'ghost-handover': 'an open obligation is handed to a document that can no longer absorb it',
  'stale-premise': 'a live document rests on a decision that has been retired or obviated',
  'broken-reference': 'a citation names a document or anchor that does not exist',
  'ambiguous-reference': 'a citation matches more than one document',
  'circular-delegation': 'obligations or supersessions form a cycle, so none of them can ever land',
  'orphaned-obligation': 'a retired or frozen document still holds open obligations',
  'live-supersession': 'a document has been superseded but still presents itself as current',
  'unreciprocated-supersession': 'a retired document does not say what replaced it',
  'state-conflict': 'an item declares two states that disagree about whether work remains',
  'self-reference': 'a document delegates to or depends on itself',
});

export interface RuleOptions {
  readonly severities?: Partial<Record<RuleId, Severity>> | undefined;
  /** Cap on related locations attached to one finding. */
  readonly maxRelated?: number | undefined;
}

const DEFAULT_MAX_RELATED = 8;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Runs every enabled rule and returns findings in report order. */
export function runRules(graph: SpecGraph, corpus: ResolvedCorpus, options: RuleOptions = {}): Diagnostic[] {
  const severities = { ...DEFAULT_SEVERITIES, ...(options.severities ?? {}) };
  const maxRelated = options.maxRelated ?? DEFAULT_MAX_RELATED;
  const out: Diagnostic[] = [];

  const emit = (rule: RuleId, build: () => Omit<Diagnostic, 'rule' | 'severity'>): void => {
    const severity = severities[rule];
    if (severity === 'off') return;
    const body = build();
    out.push({ rule, severity, ...body, related: body.related.slice(0, maxRelated) });
  };

  ghostHandovers(graph, emit);
  stalePremises(graph, emit);
  brokenReferences(corpus, emit);
  circularDelegations(graph, emit);
  orphanedObligations(graph, emit, maxRelated);
  supersessions(graph, emit);
  stateConflicts(graph, emit);
  selfReferences(graph, emit);

  return sortDiagnostics(out);
}

type Emit = (rule: RuleId, build: () => Omit<Diagnostic, 'rule' | 'severity'>) => void;

/* -------------------------------------------------------------------------- */
/* Ghost handovers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The flagship failure mode: an obligation handed into a closed ledger.
 *
 * The source must still be open and must not itself be retired - a retired
 * document delegating to another retired document is history, not a defect,
 * and reporting it would bury the live findings underneath the archive.
 */
const GHOST_HANDOVER: QuerySpec = parseQuery(
  '*[openness!=closed][phase!=retired] -delegates-to,blocked-by-> *[receptivity=sealed]',
);

function ghostHandovers(graph: SpecGraph, emit: Emit): void {
  for (const match of execute(graph, GHOST_HANDOVER)) {
    const source = match.nodes[0] as SpecNode;
    const target = match.nodes[1] as SpecNode;
    const edge = match.edges[0] as Edge;
    const targetDocument = graph.owningDocument(target.id);
    if (!targetDocument) continue;

    const sealed = targetDocument.phase === 'retired' ? 'retired' : 'frozen';
    const what = source.kind === 'item' ? 'open obligation' : 'obligation';
    const verb = EDGE_TRAITS[edge.kind].phrase;

    emit('ghost-handover', () => ({
      message: `${what} ${verb} ${describe(target)}, which is ${sealed}`,
      at: edge.declaredAt,
      nodes: [source.id, target.id],
      related: [
        related(targetDocument.statusAt ?? targetDocument.at, `${targetDocument.id} is ${sealed}${statusSuffix(targetDocument)}`),
        ...(source.kind === 'item' ? [related(source.at, `the obligation: ${source.text}`)] : []),
      ],
      hint:
        targetDocument.phase === 'retired'
          ? `nothing will be read from ${targetDocument.id} again - re-home this in a live document, or close it here`
          : `${targetDocument.id} is frozen and cannot take on new work - open an amendment, or close this here`,
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Stale premises                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A live document resting on something that stopped being true.
 *
 * Only load-bearing relations count. A "See also" pointing at a superseded ADR
 * is ordinary cross-referencing; `assumes` pointing at the same document means
 * somebody is designing around a constraint that was abolished.
 */
const STALE_PREMISE_DOCUMENT: QuerySpec = parseQuery(
  '*[phase!=retired] -depends-on,assumes,amends,blocked-by-> document[phase=retired]',
);
const STALE_PREMISE_ITEM: QuerySpec = parseQuery(
  '*[phase!=retired] -depends-on,assumes,amends,blocked-by-> item[state=obviated]',
);

function stalePremises(graph: SpecGraph, emit: Emit): void {
  const seen = new Set<string>();
  for (const spec of [STALE_PREMISE_DOCUMENT, STALE_PREMISE_ITEM]) {
    for (const match of execute(graph, spec)) {
      const source = match.nodes[0] as SpecNode;
      const target = match.nodes[1] as SpecNode;
      const edge = match.edges[0] as Edge;
      const key = `${source.id}>${target.id}>${edge.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const targetDocument = graph.owningDocument(target.id);
      const because =
        target.kind === 'item'
          ? 'that question was obviated - its premise no longer holds'
          : `${target.id} is retired${statusSuffix(targetDocument)}`;

      emit('stale-premise', () => ({
        message: `${describe(source)} ${EDGE_TRAITS[edge.kind].phrase} ${describe(target)}, which no longer holds`,
        at: edge.declaredAt,
        nodes: [source.id, target.id],
        // Point at the status line when there is one: that is the sentence that
        // makes the premise stale, and repeating the document's first line
        // underneath it adds nothing.
        related: [related(target.kind === 'document' ? (targetDocument?.statusAt ?? target.at) : target.at, because)],
        hint: `re-check this dependency: the constraint it assumes may have been lifted when ${target.kind === 'item' ? 'the question closed' : `${target.id} was retired`}`,
      }));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reference integrity                                                        */
/* -------------------------------------------------------------------------- */

function brokenReferences(corpus: ResolvedCorpus, emit: Emit): void {
  for (const ref of corpus.dangling) {
    if (ref.reason === 'ambiguous') {
      emit('ambiguous-reference', () => ({
        message: `"${ref.target}" matches ${ref.candidates.length} documents`,
        at: ref.declaredAt,
        nodes: [ref.from],
        related: [],
        hint: `disambiguate it - candidates: ${ref.candidates.join(', ')}`,
      }));
      continue;
    }

    emit('broken-reference', () => ({
      message: brokenMessage(ref),
      at: ref.declaredAt,
      nodes: [ref.from],
      related: [],
      hint: brokenHint(ref),
    }));
  }
}

function brokenMessage(ref: DanglingRef): string {
  switch (ref.reason) {
    case 'unknown-anchor':
      return `"${ref.target}" points at an anchor that does not exist`;
    case 'not-a-spec':
      return `"${ref.target}" resolves to a file that is not a specification`;
    default:
      return `"${ref.target}" does not resolve to any document`;
  }
}

function brokenHint(ref: DanglingRef): string {
  if (ref.candidates.length > 0) return `did you mean ${ref.candidates.slice(0, 3).join(', ')}?`;
  switch (ref.reason) {
    case 'unknown-anchor':
      return 'check the heading or item id it is meant to address';
    case 'not-a-spec':
      return 'widen the include patterns, or link somewhere else';
    default:
      return 'fix the identifier, or add the document it names';
  }
}

/* -------------------------------------------------------------------------- */
/* Cycles                                                                     */
/* -------------------------------------------------------------------------- */

function circularDelegations(graph: SpecGraph, emit: Emit): void {
  const kinds = [...OBLIGATION_EDGES, 'supersedes' as const];
  for (const component of graph.cycles(kinds)) {
    const members = component.map((id) => graph.node(id)).filter((node): node is SpecNode => node !== undefined);
    if (members.length === 0) continue;

    const edges = cycleEdges(graph, component, kinds);
    const onlySupersession = edges.length > 0 && edges.every((edge) => edge.kind === 'supersedes');
    const head = members[0] as SpecNode;

    emit('circular-delegation', () => ({
      message: onlySupersession
        ? `supersession cycle across ${members.length} documents`
        : `${members.length === 1 ? 'self-delegation' : `delegation cycle across ${members.length} nodes`}: nothing in it can ever land`,
      at: edges[0]?.declaredAt ?? head.at,
      nodes: component,
      related: edges.map((edge) => related(edge.declaredAt, `${edge.from} ${EDGE_TRAITS[edge.kind].phrase} ${edge.to}`)),
      hint: 'break the loop: one of these must own the work outright, or be closed',
    }));
  }
}

/** The edges that keep a component strongly connected, in traversal order. */
function cycleEdges(graph: SpecGraph, component: readonly string[], kinds: readonly Edge['kind'][]): Edge[] {
  const inside = new Set(component);
  const out: Edge[] = [];
  for (const id of component) {
    for (const edge of graph.out(id, kinds)) {
      if (inside.has(edge.to)) out.push(edge);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Orphaned obligations                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The black hole itself: a document nobody reads any more, still holding work.
 *
 * Reported once per document rather than once per item. Five findings that all
 * say "this archived ADR has open questions" is five times the noise and none
 * of the extra information.
 */
function orphanedObligations(graph: SpecGraph, emit: Emit, maxRelated: number): void {
  for (const document of graph.documents) {
    if (document.phase !== 'retired' && document.phase !== 'frozen') continue;
    const open = graph.itemsOf(document.id).filter((item) => item.openness !== 'closed');
    if (open.length === 0) continue;

    const sealed = document.phase === 'retired' ? 'retired' : 'frozen';
    emit('orphaned-obligation', () => ({
      message: `${sealed} document still holds ${open.length} open ${open.length === 1 ? 'obligation' : 'obligations'}`,
      at: document.statusAt ?? document.at,
      nodes: [document.id, ...open.map((item) => item.id)],
      related: open
        .slice(0, maxRelated)
        .map((item) => related(item.at, `${item.disposition}: ${item.text}`)),
      hint: `move each one to a live document or close it - as it stands, ${open.length === 1 ? 'it disappears' : 'they disappear'} with ${document.id}`,
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Supersession consistency                                                   */
/* -------------------------------------------------------------------------- */

function supersessions(graph: SpecGraph, emit: Emit): void {
  for (const edge of graph.edges) {
    if (edge.kind !== 'supersedes' || edge.reflexive) continue;
    const superseded = graph.document(edge.to);
    const superseding = graph.document(edge.from);
    if (!superseded || !superseding) continue;

    if (superseded.phase !== 'retired' && superseded.phase !== 'unknown') {
      emit('live-supersession', () => ({
        // The fix belongs in the superseded document, so that is where the
        // finding points - not at the document that made the claim.
        message: `${superseded.id} is superseded by ${superseding.id} but still reads as ${superseded.phase}`,
        at: superseded.statusAt ?? superseded.at,
        nodes: [superseded.id, superseding.id],
        related: [related(edge.declaredAt, `the supersession is declared here`)],
        hint: `mark ${superseded.id} as superseded, or drop the claim in ${superseding.id}`,
      }));
      continue;
    }

    if (superseded.phase === 'retired' && !edge.declaredIn.includes(superseded.path)) {
      emit('unreciprocated-supersession', () => ({
        message: `${superseded.id} is retired but never says that ${superseding.id} replaced it`,
        at: superseded.statusAt ?? superseded.at,
        nodes: [superseded.id, superseding.id],
        related: [related(edge.declaredAt, `only ${superseding.id} records the relationship`)],
        hint: `add "superseded-by: ${superseding.id}" to ${superseded.path} so a reader who lands there is redirected`,
      }));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Item state                                                                 */
/* -------------------------------------------------------------------------- */

function stateConflicts(graph: SpecGraph, emit: Emit): void {
  for (const item of graph.items) {
    if (item.conflicts.length === 0) continue;
    emit('state-conflict', () => ({
      message: `item reads as ${item.disposition} but also carries ${describeSignals(item)}`,
      at: item.evidence.at,
      nodes: [item.id],
      related: item.conflicts.map((signal) =>
        related(signal.at, `${signal.source} says ${signal.disposition}${signal.raw ? `: ${signal.raw}` : ''}`),
      ),
      hint: `make the two agree - spec-graph is treating it as ${item.openness}`,
    }));
  }
}

function describeSignals(item: ItemNode): string {
  const parts = item.conflicts.map((signal) => `a ${signal.source} saying ${signal.disposition}`);
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* -------------------------------------------------------------------------- */
/* Self references                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A document that delegates to, or depends on, itself.
 *
 * Almost always a copied link that was never repointed. Informational, because
 * a self-link in a table of contents is harmless - but a *delegation* to self
 * means an obligation that looks handed off and was not.
 */
function selfReferences(graph: SpecGraph, emit: Emit): void {
  for (const edge of graph.edges) {
    if (!edge.reflexive || edge.kind === 'contains') continue;
    const traits = EDGE_TRAITS[edge.kind];
    if (!traits.transfersObligation && !traits.loadBearing) continue;
    const node = graph.node(edge.from);
    if (!node) continue;

    emit('self-reference', () => ({
      message: `${describe(node)} ${traits.phrase} itself`,
      at: edge.declaredAt,
      nodes: [edge.from],
      related: [],
      hint: traits.transfersObligation
        ? 'this obligation looks delegated but never left - point it at another document, or own it here'
        : 'a document cannot depend on itself - repoint or remove the reference',
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function describe(node: SpecNode): string {
  return node.kind === 'document' ? node.id : `${node.document} "${truncate(node.text, 48)}"`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function statusSuffix(document: DocumentNode | undefined): string {
  return document?.rawStatus ? ` ("${document.rawStatus}")` : '';
}

function related(at: SourceRef, note: string): RelatedLocation {
  return { at, note };
}

const SEVERITY_ORDER: Readonly<Record<Exclude<Severity, 'off'>, number>> = { error: 0, warn: 1, info: 2 };

/**
 * Total ordering, so two runs on the same corpus produce byte-identical output.
 *
 * CI output that reorders between runs cannot be diffed, and output that cannot
 * be diffed stops being read.
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.at.file !== b.at.file) return a.at.file < b.at.file ? -1 : 1;
    if (a.at.span.start.line !== b.at.span.start.line) return a.at.span.start.line - b.at.span.start.line;
    if (a.at.span.start.column !== b.at.span.start.column) return a.at.span.start.column - b.at.span.start.column;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

/** The selector equivalent of a rule, for `spec-graph rules --explain`. */
export const RULE_QUERIES: Readonly<Partial<Record<RuleId, string>>> = Object.freeze({
  'ghost-handover': '*[openness!=closed][phase!=retired] -delegates-to,blocked-by-> *[receptivity=sealed]',
  'stale-premise': '*[phase!=retired] -depends-on,assumes,amends,blocked-by-> document[phase=retired]',
  'orphaned-obligation': 'document[receptivity=sealed] -contains-> item[openness!=closed]',
  'self-reference': 'see --format json; reflexive edges are excluded from traversal by default',
});
