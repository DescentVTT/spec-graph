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
import { dirnamePosix, resolveFrom } from './paths.js';
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
  'reference-outside-corpus': 'warn',
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
  'reference-outside-corpus': 'a citation names a real document the include patterns did not reach',
  'ambiguous-reference': 'a citation matches more than one document',
  'circular-delegation': 'obligations or supersessions form a cycle, so none of them can ever land',
  'orphaned-obligation': 'a retired or frozen document still holds open obligations',
  'live-supersession': 'a document has been superseded but still presents itself as current',
  'unreciprocated-supersession': 'a retired document does not say what replaced it',
  'state-conflict': 'an item declares two states that disagree about whether work remains',
  'self-reference': 'a document delegates to or depends on itself',
});

/**
 * The severity map `--strict` implies, and which rules it actually moved.
 *
 * Strict raises `warn` to `error` and leaves `info` alone. That asymmetry is
 * deliberate: the `info` rules are advisory by nature - a self-link in a table
 * of contents is a formatting quirk - and promoting them would resurrect
 * precisely the false-positive problem ADR-0006 exists to prevent.
 *
 * An explicit `--rule` always wins over strict, so `--strict --rule x=warn`
 * keeps `x` at warn. That is what makes strict usable: a team can turn it on
 * and exempt the one rule their repository disagrees with, rather than choosing
 * between all of it and none of it.
 */
export function resolveStrict(
  overrides: Partial<Record<RuleId, Severity>> = {},
  strict = false,
): { severities: Partial<Record<RuleId, Severity>>; escalated: ReadonlySet<RuleId> } {
  const severities: Partial<Record<RuleId, Severity>> = { ...overrides };
  const escalated = new Set<RuleId>();
  if (!strict) return { severities, escalated };

  for (const id of RULE_IDS) {
    if (overrides[id] !== undefined) continue;
    if (DEFAULT_SEVERITIES[id] !== 'warn') continue;
    severities[id] = 'error';
    escalated.add(id);
  }
  return { severities, escalated };
}

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

  const emit = (rule: RuleId, build: () => Built): void => {
    const severity = severities[rule];
    if (severity === 'off') return;
    const body = build();
    if (exempt(graph, rule, body.nodes)) return;
    // `target` ahead of the spread: a rule that names one overrides the default,
    // and the eight that have nothing to name say nothing.
    out.push({ rule, severity, target: null, ...body, related: body.related.slice(0, maxRelated) });
  };

  // Ghost handovers are reported first and claim their edges, because
  // `blocked-by` is both obligation-transferring and load-bearing: without this,
  // one open question blocked by an archived decision would produce two
  // findings on the same line, for the same defect, with the same fix.
  const claimed = ghostHandovers(graph, emit);
  stalePremises(graph, emit, claimed);
  brokenReferences(corpus, emit);
  circularDelegations(graph, emit);
  orphanedObligations(graph, emit, maxRelated);
  supersessions(graph, emit);
  stateConflicts(graph, emit);
  selfReferences(graph, emit);

  return sortDiagnostics(out);
}

/** What a rule returns: the finding, minus what `emit` knows better. */
type Built = Omit<Diagnostic, 'rule' | 'severity' | 'target'> & { readonly target?: string };

type Emit = (rule: RuleId, build: () => Built) => void;

/**
 * Rules about what a document cites, rather than about what it owes.
 *
 * These are the ones a historical record still answers for. A link that goes
 * nowhere is broken whoever wrote it and whenever they wrote it.
 */
const REFERENCE_RULES: ReadonlySet<RuleId> = new Set<RuleId>([
  'broken-reference',
  'reference-outside-corpus',
  'ambiguous-reference',
]);

/**
 * Whether a finding is about history rather than about work.
 *
 * A record reports that something was decided; it does not decide anything. Its
 * open checkboxes are minutes, its delegations are things that were said, and
 * its lifecycle is not a lifecycle. So a record is never the *subject* of a
 * finding about obligations or lifecycle - though it is still a legitimate
 * target of one, because delegating live work into a log is exactly the ghost
 * handover this tool exists to find.
 *
 * Stated once, here, rather than as a guard repeated in eight rules: the
 * exemption is a property of what counts as a finding, not of any one rule, and
 * a rule added later inherits it without having to remember. See ADR-0011.
 */
function exempt(graph: SpecGraph, rule: RuleId, nodes: readonly string[]): boolean {
  if (REFERENCE_RULES.has(rule)) return false;
  const subject = nodes[0];
  if (subject === undefined) return false;
  return graph.owningDocument(subject)?.phase === 'record';
}

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

/** Emits ghost-handover findings and returns the edges they account for. */
function ghostHandovers(graph: SpecGraph, emit: Emit): Set<string> {
  const claimed = new Set<string>();
  for (const match of execute(graph, GHOST_HANDOVER)) {
    const source = match.nodes[0] as SpecNode;
    const target = match.nodes[1] as SpecNode;
    const edge = match.edges[0] as Edge;
    const targetDocument = graph.owningDocument(target.id);
    if (!targetDocument) continue;

    const sealed = SEALED_WORD[targetDocument.phase] ?? 'frozen';
    const what = source.kind === 'item' ? 'open obligation' : 'obligation';
    const verb = EDGE_TRAITS[edge.kind].phrase;
    claimed.add(edgeKey(edge));

    emit('ghost-handover', () => ({
      message: `${what} ${verb} ${describe(target)}, which is ${sealed}`,
      at: edge.declaredAt,
      nodes: [source.id, target.id],
      related: [
        related(targetDocument.statusAt ?? targetDocument.at, `${targetDocument.id} is ${sealed}${statusSuffix(targetDocument)}`),
        ...(source.kind === 'item' ? [related(source.at, `the obligation: ${source.text}`)] : []),
      ],
      hint: HANDOVER_HINT[targetDocument.phase]?.(targetDocument.id) ?? FROZEN_HINT(targetDocument.id),
    }));
  }
  return claimed;
}

/** How a sealed target is described in a ghost-handover message. */
const SEALED_WORD: Readonly<Partial<Record<string, string>>> = {
  retired: 'retired',
  record: 'a historical record',
};

const FROZEN_HINT = (id: string): string =>
  `${id} is frozen and cannot take on new work - open an amendment, or close this here`;

/** What to do about work handed into each kind of sealed document. */
const HANDOVER_HINT: Readonly<Partial<Record<string, (id: string) => string>>> = {
  retired: (id) => `nothing will be read from ${id} again - re-home this in a live document, or close it here`,
  record: (id) => `${id} is a log of what happened and will never act - re-home this in a live document`,
};

/** Identity of a relation, for the hand-off between overlapping rules. */
function edgeKey(edge: Edge): string {
  return `${edge.kind} ${edge.from} ${edge.to}`;
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

function stalePremises(graph: SpecGraph, emit: Emit, claimed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const spec of [STALE_PREMISE_DOCUMENT, STALE_PREMISE_ITEM]) {
    for (const match of execute(graph, spec)) {
      const source = match.nodes[0] as SpecNode;
      const target = match.nodes[1] as SpecNode;
      const edge = match.edges[0] as Edge;
      // Already reported as a ghost handover, which says the same thing in the
      // terms the reader needs.
      if (claimed.has(edgeKey(edge))) continue;
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
        target: ref.target,
        related: [],
        hint: `disambiguate it - candidates: ${ref.candidates.join(', ')}`,
      }));
      continue;
    }

    // A link to a file that exists but was not included is a configuration
    // problem: the graph is not broken, the corpus is just incomplete. Reporting
    // it as an error means a repository whose specifications live somewhere the
    // default patterns miss fails on its first run, for something the user has
    // not done wrong.
    const rule: RuleId = ref.reason === 'not-a-spec' ? 'reference-outside-corpus' : 'broken-reference';

    emit(rule, () => ({
      message: brokenMessage(ref),
      at: ref.declaredAt,
      nodes: [ref.from],
      target: ref.target,
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
  // A wiki link carries no path, only a name, so whether it means a document at
  // all is a repository convention. Naming the flag here is what keeps that a
  // one-run discovery rather than a support question.
  if (ref.raw.startsWith('[[') && ref.reason === 'unknown-target') {
    return `fix the identifier, or - if [[...]] tags a concept here - exclude it: --ignore-ref "${suggestReferenceGlob(ref.target)}"`;
  }
  switch (ref.reason) {
    case 'unknown-anchor':
      return 'check the heading or item id it is meant to address';
    case 'not-a-spec':
      // Name the pattern that would include it: "widen your patterns" is advice
      // the reader then has to translate, and this is the translation.
      return `include it, for example: spec-graph "${suggestPattern(ref)}"`;
    default:
      return 'fix the identifier, or add the document it names';
  }
}

/**
 * A glob covering the family of concept tags a target belongs to.
 *
 * `trap 55` suggests `trap *` rather than `trap 55`, because these tags come in
 * numbered series and excluding them one at a time is not a fix anybody would
 * accept. A target with no trailing number is suggested verbatim.
 */
function suggestReferenceGlob(target: string): string {
  const trimmed = target.trim();
  const series = /^(.*?)[\s._-]*\d+$/.exec(trimmed);
  const stem = series?.[1]?.trim();
  return stem !== undefined && stem.length > 0 ? `${stem} *` : trimmed;
}

/**
 * The narrowest include pattern that would reach a target the corpus missed.
 *
 * Built from the *resolved* repository-relative path, not the link as written:
 * `../notes.md` cited from `docs/adr/` needs `docs/**\/*.md`, and suggesting
 * `../**\/*.md` would be worse than saying nothing.
 */
function suggestPattern(ref: DanglingRef): string {
  const withoutAnchor = (ref.target.split('#')[0] ?? ref.target).trim();
  const resolved = resolveFrom(ref.declaredAt.file, withoutAnchor);
  const directory = dirnamePosix(resolved);
  return directory.length > 0 ? `${directory}/**/*.md` : '**/*.md';
}

/* -------------------------------------------------------------------------- */
/* Cycles                                                                     */
/* -------------------------------------------------------------------------- */

function circularDelegations(graph: SpecGraph, emit: Emit): void {
  const kinds = [...OBLIGATION_EDGES, 'supersedes' as const];
  // Projected onto documents, so a question handed back and forth between two
  // of them is found even though each delegation runs item -> document and the
  // raw graph therefore contains no cycle at all.
  for (const component of graph.cycles(kinds, { byDocument: true })) {
    const members = component
      .map((id) => graph.document(id))
      .filter((node): node is DocumentNode => node !== undefined);
    if (members.length < 2) continue;
    // A cycle is a set, not a subject, so the exemption at `emit` cannot see it.
    // One record in the loop means the loop is partly a report of what was once
    // said, and nothing in it is owed by anybody.
    if (members.some((member) => member.phase === 'record')) continue;

    const edges = cycleEdges(graph, component, kinds);
    const onlySupersession = edges.length > 0 && edges.every((edge) => edge.kind === 'supersedes');
    const head = members[0] as DocumentNode;

    emit('circular-delegation', () => ({
      message: onlySupersession
        ? `supersession cycle across ${members.length} documents`
        : `delegation cycle across ${members.length} documents: nothing in it can ever land`,
      at: edges[0]?.declaredAt ?? head.at,
      nodes: component,
      related: edges.map((edge) => related(edge.declaredAt, `${edge.from} ${EDGE_TRAITS[edge.kind].phrase} ${edge.to}`)),
      hint: 'break the loop: one of these must own the work outright, or be closed',
    }));
  }
}

/**
 * The relations that keep a component strongly connected.
 *
 * Membership is by owning document, because the component is a projection: the
 * edge that closes the loop is usually written on an item, and that is the line
 * the report has to point at.
 */
function cycleEdges(graph: SpecGraph, component: readonly string[], kinds: readonly Edge['kind'][]): Edge[] {
  const inside = new Set(component);
  const owner = (id: string): string => graph.owningDocument(id)?.id ?? id;
  const out: Edge[] = [];
  for (const edge of graph.edges) {
    if (!kinds.includes(edge.kind)) continue;
    const from = owner(edge.from);
    const to = owner(edge.to);
    if (from !== to && inside.has(from) && inside.has(to)) out.push(edge);
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
    // A record narrating "ADR-0005 replaced ADR-0001" is reporting a
    // supersession, not declaring one. Both hints below ask somebody to edit
    // the document that made the claim, and a log is the one document nobody
    // can edit - it says what was true when it was written. The exemption at
    // `emit` cannot see this: the subject here is the *other* document.
    if (superseding.phase === 'record') continue;

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
