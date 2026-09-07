/**
 * The spec-graph data model.
 *
 * Three ideas carry the whole design:
 *
 * 1. **Documents have a lifecycle phase**, normalised from whatever vocabulary
 *    the repository already uses (MADR `accepted`, KEP `implementable`, RFC
 *    `final`, plain English `archived`). The phase answers one question that
 *    matters more than any other: *can this document still absorb new work?*
 *
 * 2. **Items are obligations with nuanced state.** A checkbox is not a boolean.
 *    An item can be open, narrowed to a smaller scope, satisfied, consciously
 *    accepted as debt, or obviated because the premise it rested on evaporated.
 *    Collapsing those five into `[ ]` / `[x]` is what makes ad-hoc greps lie.
 *
 * 3. **Edges are typed and carry provenance.** Every relation records where it
 *    was *declared*, which is frequently not the node it points at. That is what
 *    lets a diagnostic say "ADR-0009 line 12 claims to supersede ADR-0003"
 *    instead of "something, somewhere, is inconsistent".
 */

/* -------------------------------------------------------------------------- */
/* Source positions                                                           */
/* -------------------------------------------------------------------------- */

/** A point in a source file. `offset` is a UTF-16 code-unit index. */
export interface Position {
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, counted in UTF-16 code units. */
  readonly column: number;
}

/** A half-open `[start, end)` range of a source file. */
export interface Span {
  readonly start: Position;
  readonly end: Position;
}

/** A span plus the file it belongs to. Everything user-visible carries one. */
export interface SourceRef {
  /** Repository-relative POSIX path. */
  readonly file: string;
  readonly span: Span;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The normalised document lifecycle, as a four-state lattice.
 *
 * Ecosystem vocabularies are large and mutually incompatible; the *consequences*
 * of a status are not. These four phases are chosen so that every question
 * spec-graph asks can be answered from the phase alone.
 *
 * - `draft`   - not yet binding. Mutable. Absorbs new work.
 * - `active`  - binding and mutable. Absorbs new work.
 * - `frozen`  - binding and immutable. Changes require a new document.
 * - `retired` - no longer binding: superseded, rejected, withdrawn, archived.
 *
 * `unknown` is a fifth, deliberately non-lattice value for documents that never
 * declared a status. Rules treat it permissively rather than guessing.
 */
export type Phase = 'draft' | 'active' | 'frozen' | 'retired' | 'record' | 'unknown';

/**
 * Can a document in this phase take on a *new* open obligation?
 *
 * This is the single predicate behind ghost-handover detection. Delegating an
 * open question into a `frozen` or `retired` document is a write to a closed
 * ledger: nobody will ever read it again.
 */
export type Receptivity = 'receptive' | 'sealed' | 'unknown';

/* -------------------------------------------------------------------------- */
/* Item state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How much of an obligation is left.
 *
 * Kept separate from {@link Disposition} because the two answer different
 * questions: `openness` is "does someone still owe work?", `disposition` is
 * "what happened to it?". Rules almost always want the former; humans reading a
 * report always want the latter.
 */
export type Openness = 'open' | 'partial' | 'closed';

/** Why an item is in the state it is in. */
export type Disposition =
  /** Nothing has happened yet. */
  | 'unresolved'
  /** Scope was cut down, but a remainder is still owed. */
  | 'narrowed'
  /** Ownership moved elsewhere. Still owed - by somebody else. */
  | 'delegated'
  /** Done, answered, decided. */
  | 'satisfied'
  /** Knowingly not done. A closed item with a scar. */
  | 'accepted-debt'
  /** Decided against. */
  | 'rejected'
  /**
   * The premise evaporated, so the question stopped being a question.
   * Load-bearing citations to an obviated item are stale premises.
   */
  | 'obviated';

export const DISPOSITIONS: readonly Disposition[] = Object.freeze([
  'unresolved',
  'narrowed',
  'delegated',
  'satisfied',
  'accepted-debt',
  'rejected',
  'obviated',
]);

/** The openness implied by each disposition. */
export const OPENNESS_OF: Readonly<Record<Disposition, Openness>> = Object.freeze({
  unresolved: 'open',
  narrowed: 'partial',
  delegated: 'open',
  satisfied: 'closed',
  'accepted-debt': 'closed',
  rejected: 'closed',
  obviated: 'closed',
});

/* -------------------------------------------------------------------------- */
/* Edges                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Relation kinds.
 *
 * The set is small on purpose. Two orthogonal properties - declared once in
 * {@link EDGE_TRAITS} - do the actual work, so adding a kind never means
 * touching a rule.
 */
export type EdgeKind =
  /** Structural: a document contains an item. Never inferred from prose. */
  | 'contains'
  /** A neutral citation. */
  | 'references'
  /** Explicitly *not* load-bearing: "See also", "History", "Prior art". */
  | 'relates-to'
  /** The source design depends on the target content. */
  | 'depends-on'
  /** The source rests on a claim made by the target. */
  | 'assumes'
  /** The source hands an obligation to the target. */
  | 'delegates-to'
  /** The source cannot proceed until the target does. */
  | 'blocked-by'
  /** The source replaces the target. */
  | 'supersedes'
  /** The source modifies the target without replacing it. */
  | 'amends';

export interface EdgeTraits {
  /**
   * Does the source continued validity depend on what the target says?
   *
   * Load-bearing edges into retired documents are stale premises. Non
   * load-bearing ones ("see also") are just history, and reporting them would
   * bury the real findings - which is exactly how ad-hoc linters lose trust.
   */
  readonly loadBearing: boolean;
  /** Does the edge move an obligation from source to target? */
  readonly transfersObligation: boolean;
  /** Does the edge assert something about the target lifecycle? */
  readonly lifecycle: boolean;
  /** Human-readable phrase used in diagnostics: "ADR-1 <phrase> ADR-2". */
  readonly phrase: string;
}

export const EDGE_TRAITS: Readonly<Record<EdgeKind, EdgeTraits>> = Object.freeze({
  contains: { loadBearing: false, transfersObligation: false, lifecycle: false, phrase: 'contains' },
  references: { loadBearing: false, transfersObligation: false, lifecycle: false, phrase: 'references' },
  'relates-to': { loadBearing: false, transfersObligation: false, lifecycle: false, phrase: 'relates to' },
  'depends-on': { loadBearing: true, transfersObligation: false, lifecycle: false, phrase: 'depends on' },
  assumes: { loadBearing: true, transfersObligation: false, lifecycle: false, phrase: 'assumes' },
  'delegates-to': { loadBearing: false, transfersObligation: true, lifecycle: false, phrase: 'delegates to' },
  'blocked-by': { loadBearing: true, transfersObligation: true, lifecycle: false, phrase: 'is blocked by' },
  supersedes: { loadBearing: false, transfersObligation: false, lifecycle: true, phrase: 'supersedes' },
  amends: { loadBearing: true, transfersObligation: false, lifecycle: true, phrase: 'amends' },
});

export const EDGE_KINDS = Object.keys(EDGE_TRAITS) as readonly EdgeKind[];

/** How an edge came to exist. Reported verbatim so findings are auditable. */
export type EdgeOrigin =
  /** A `<!-- @spec-edge -->` directive. */
  | 'directive'
  /** A front-matter field such as `supersedes:` or `superseded-by:`. */
  | 'front-matter'
  /** A Markdown link, classified by the section it sits in. */
  | 'link'
  /** A bare textual identifier such as `ADR-0007` in prose. */
  | 'text'
  /** Synthesised by the extractor (document -> item). */
  | 'structural';

export interface Edge {
  readonly kind: EdgeKind;
  /** Node id. */
  readonly from: string;
  /** Node id. */
  readonly to: string;
  readonly origin: EdgeOrigin;
  /**
   * Where the relation was written down. Not necessarily inside `from`: a
   * `superseded-by: ADR-9` field in ADR-3 declares `ADR-9 supersedes ADR-3`,
   * and the only place a human can go fix it is ADR-3.
   */
  readonly declaredAt: SourceRef;
  /** The raw text that produced the edge, for diagnostics. */
  readonly raw: string;
  /**
   * Every file that declares this relation.
   *
   * A supersession stated only in the superseding document leaves the
   * superseded one silently presenting itself as current, which is a finding in
   * its own right - so the set of declaration sites has to survive de-duplication.
   */
  readonly declaredIn: readonly string[];
  /** True when `from` and `to` are the same node. Kept, never traversed. */
  readonly reflexive: boolean;
}

/* -------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* -------------------------------------------------------------------------- */

export type NodeKind = 'document' | 'item';

interface NodeBase {
  /** Canonical, graph-unique. Documents: `ADR-0007`. Items: `ADR-0007#q.1`. */
  readonly id: string;
  readonly kind: NodeKind;
  /** Short human label used in reports. */
  readonly title: string;
  readonly at: SourceRef;
}

export interface DocumentNode extends NodeBase {
  readonly kind: 'document';
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** Every spelling that resolves to this document, lowercased. */
  readonly aliases: readonly string[];
  readonly phase: Phase;
  /** The status string as written, before normalisation. `null` if absent. */
  readonly rawStatus: string | null;
  /** Where the status was declared, when it was declared anywhere. */
  readonly statusAt: SourceRef | null;
  /** Front-matter fields, flattened to strings and string arrays. */
  readonly frontMatter: Readonly<Record<string, string | readonly string[]>>;
}

export interface ItemNode extends NodeBase {
  readonly kind: 'item';
  /** Owning document id. */
  readonly document: string;
  /** Heading path the item sits under, outermost first. */
  readonly section: readonly string[];
  /** First line of the item, normalised to one line for reports. */
  readonly text: string;
  /** The full multi-line body, continuations included. */
  readonly body: string;
  readonly disposition: Disposition;
  readonly openness: Openness;
  /** Which signal decided the disposition. */
  readonly evidence: StateSignal;
  /** Conflicting signals found while resolving the state. */
  readonly conflicts: readonly StateSignal[];
}

export type SpecNode = DocumentNode | ItemNode;

/** One observation about an item state. */
export interface StateSignal {
  /** Higher wins. See `SIGNAL_PRIORITY` in `state.ts`. */
  readonly source: 'directive' | 'marker' | 'strikethrough' | 'checkbox' | 'section' | 'default';
  readonly disposition: Disposition;
  /** The literal text that produced the signal. */
  readonly raw: string;
  readonly at: SourceRef;
}

/* -------------------------------------------------------------------------- */
/* Unresolved references                                                      */
/* -------------------------------------------------------------------------- */

export type DanglingReason =
  /** Nothing in the corpus answers to this identifier. */
  | 'unknown-target'
  /** More than one document answers to it. */
  | 'ambiguous'
  /** The path exists on disk but is not a parsed specification. */
  | 'not-a-spec'
  /** The document resolved, but the `#anchor` did not. */
  | 'unknown-anchor';

/** A citation that failed foreign-key validation. */
export interface DanglingRef {
  readonly kind: EdgeKind;
  readonly from: string;
  /** The identifier as written. */
  readonly target: string;
  readonly reason: DanglingReason;
  readonly origin: EdgeOrigin;
  readonly declaredAt: SourceRef;
  readonly raw: string;
  /** Candidate ids when `reason` is `ambiguous`, or near-misses otherwise. */
  readonly candidates: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export type Severity = 'error' | 'warn' | 'info' | 'off';

export type RuleId =
  | 'ghost-handover'
  | 'stale-premise'
  | 'broken-reference'
  | 'reference-outside-corpus'
  | 'ambiguous-reference'
  | 'circular-delegation'
  | 'orphaned-obligation'
  | 'unreciprocated-supersession'
  | 'live-supersession'
  | 'state-conflict'
  | 'self-reference';

export interface RelatedLocation {
  readonly at: SourceRef;
  readonly note: string;
}

export interface Diagnostic {
  readonly rule: RuleId;
  readonly severity: Exclude<Severity, 'off'>;
  /** One line, no trailing period. The headline of the finding. */
  readonly message: string;
  /** Where a human should go to fix it. */
  readonly at: SourceRef;
  /** Node ids involved, most relevant first. */
  readonly nodes: readonly string[];
  /**
   * The citation this finding is about, for the rules that are about one.
   *
   * `null` everywhere else, where `nodes` already names the subject. It exists
   * because a broken reference names something that is not a node - that is
   * what makes it broken - and a baseline still has to be able to tell one
   * broken reference from another. See ADR-0012.
   */
  readonly target: string | null;
  /** Supporting locations: the other end of an edge, a cycle members. */
  readonly related: readonly RelatedLocation[];
  /** Concrete next action. */
  readonly hint: string;
}

/* -------------------------------------------------------------------------- */
/* Analysis output                                                            */
/* -------------------------------------------------------------------------- */

/** A problem with the input itself, as opposed to a finding about the graph. */
export interface ParseProblem {
  readonly message: string;
  readonly at: SourceRef;
}

export interface AnalysisSummary {
  readonly documents: number;
  readonly items: number;
  readonly edges: number;
  readonly openObligations: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** Milliseconds, wall clock. */
  readonly durationMs: number;
}
