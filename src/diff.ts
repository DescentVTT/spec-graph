/**
 * What changed between two states of the graph, read from two JSON exports.
 *
 * Two files in, one report out, and no git underneath: CI already has both
 * checkouts, and the pipeline stays a pure function of text. See ADR-0020.
 *
 * The rule the whole module follows is that a change is reported only against a
 * name that means the same thing in both exports. A document's id does. An
 * item's numbered id does not - it is an ordinal within a section, so one
 * inserted question renumbers every question after it - and keying on it
 * reports a question as reopened when nobody touched it. So an obligation is
 * paired only by a declared id, or by its document, section and title when
 * nothing else shares them; anything unpaired is said to have appeared or
 * disappeared, and never to have changed.
 */

/** Refused input: not JSON, not an export, or a version this cannot read. */
export class DiffInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffInputError';
  }
}

export interface Generator {
  readonly name: string;
  readonly version: string;
}

export interface ExportedDocument {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly phase: string;
  readonly status: string | null;
}

export interface ExportedItem {
  readonly id: string;
  readonly title: string;
  readonly document: string;
  readonly section: readonly string[];
  readonly openness: string;
  /** `null` when the export predates the flag, so its ids cannot be trusted. */
  readonly declared: boolean | null;
}

export interface ExportedRelation {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}

/** One side of a diff: a `--graph-format json` export, read and checked. */
export interface GraphExport {
  readonly generator: Generator | null;
  readonly documents: readonly ExportedDocument[];
  readonly items: readonly ExportedItem[];
  readonly edges: readonly ExportedRelation[];
}

export interface DocumentChange {
  readonly id: string;
  readonly path?: readonly [string, string] | undefined;
  readonly title?: readonly [string, string] | undefined;
  readonly phase?: readonly [string, string] | undefined;
  readonly status?: readonly [string | null, string | null] | undefined;
}

export interface ObligationRef {
  readonly document: string;
  readonly section: readonly string[];
  /**
   * The section path as a reader wants it: without the document's own title
   * heading, which every item under it shares and the id already names. Items
   * are matched on the same headings, kept as a list so that no heading holding
   * " > " can pass for two.
   */
  readonly place: string;
  readonly title: string;
}

/** An item with no pair: its state on the one side it exists on, and no more. */
export interface UnpairedObligation extends ObligationRef {
  readonly openness: string;
}

export interface Transition extends ObligationRef {
  readonly openness: readonly [string, string];
}

export interface GraphDiff {
  readonly generators: { readonly before: Generator | null; readonly after: Generator | null };
  readonly documents: {
    readonly added: readonly ExportedDocument[];
    readonly removed: readonly ExportedDocument[];
    readonly changed: readonly DocumentChange[];
  };
  readonly relations: { readonly added: readonly ExportedRelation[]; readonly removed: readonly ExportedRelation[] };
  readonly obligations: {
    readonly transitions: readonly Transition[];
    readonly appeared: readonly UnpairedObligation[];
    readonly disappeared: readonly UnpairedObligation[];
  };
}

/* -------------------------------------------------------------------------- */
/* Reading an export                                                          */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Reads one export.
 *
 * Checked as far as the comparison reads it and no further: a field this does
 * not use is not a reason to refuse a file, and a later export that adds fields
 * is still version 1.
 */
export function parseGraphExport(raw: string, source: string): GraphExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DiffInputError(`${source} is not JSON; make it with \`spec-graph graph --graph-format json\``);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['nodes']) || !Array.isArray(parsed['edges'])) {
    throw new DiffInputError(`${source} is not a graph export; make it with \`spec-graph graph --graph-format json\``);
  }
  if (parsed['version'] !== 1) {
    throw new DiffInputError(`${source} is export version ${JSON.stringify(parsed['version'])}, and this reads version 1`);
  }

  const generator = isRecord(parsed['generator']) ? parsed['generator'] : null;
  const name = generator ? text(generator['name']) : null;
  const version = generator ? text(generator['version']) : null;

  const documents: ExportedDocument[] = [];
  const items: ExportedItem[] = [];
  parsed['nodes'].forEach((node: unknown, index) => {
    const id = isRecord(node) ? text(node['id']) : null;
    if (!isRecord(node) || id === null) throw new DiffInputError(`${source}: node ${index} has no id`);
    if (node['kind'] === 'document') {
      documents.push({
        id,
        title: text(node['title']) ?? '',
        path: text(node['path']) ?? '',
        phase: text(node['phase']) ?? 'unknown',
        status: text(node['status']),
      });
    } else if (node['kind'] === 'item') {
      const section = Array.isArray(node['section']) ? node['section'].filter((part): part is string => typeof part === 'string') : [];
      items.push({
        id,
        title: text(node['title']) ?? '',
        document: text(node['document']) ?? '',
        section,
        openness: text(node['openness']) ?? 'unknown',
        declared: typeof node['declared'] === 'boolean' ? node['declared'] : null,
      });
    } else {
      throw new DiffInputError(`${source}: node ${id} is neither a document nor an item`);
    }
  });

  const edges: ExportedRelation[] = parsed['edges'].map((edge: unknown, index) => {
    const kind = isRecord(edge) ? text(edge['kind']) : null;
    const from = isRecord(edge) ? text(edge['from']) : null;
    const to = isRecord(edge) ? text(edge['to']) : null;
    if (kind === null || from === null || to === null) throw new DiffInputError(`${source}: edge ${index} is missing its kind or ends`);
    return { kind, from, to };
  });

  return { generator: name !== null && version !== null ? { name, version } : null, documents, items, edges };
}

/* -------------------------------------------------------------------------- */
/* Comparing                                                                  */
/* -------------------------------------------------------------------------- */

// Code-unit order, not locale order: the same input sorts the same way on every
// machine, which is what keeps a report byte-identical.
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares two exports. Pure, and deterministic in everything it returns. */
export function diffExports(before: GraphExport, after: GraphExport): GraphDiff {
  return {
    generators: { before: before.generator, after: after.generator },
    documents: compareDocuments(before, after),
    relations: compareRelations(before, after),
    obligations: compareObligations(before, after),
  };
}

function compareDocuments(before: GraphExport, after: GraphExport): GraphDiff['documents'] {
  const was = new Map(before.documents.map((document) => [document.id, document]));
  const now = new Map(after.documents.map((document) => [document.id, document]));
  const changed: DocumentChange[] = [];
  for (const [id, next] of now) {
    const previous = was.get(id);
    if (previous === undefined) continue;
    // The id is the decision's name, so the same id at a new path is the same
    // decision moved, never one removed and another added (ADR-0009).
    const change: DocumentChange = {
      id,
      ...(previous.path !== next.path && { path: [previous.path, next.path] as const }),
      ...(previous.title !== next.title && { title: [previous.title, next.title] as const }),
      ...(previous.phase !== next.phase && { phase: [previous.phase, next.phase] as const }),
      ...(previous.status !== next.status && { status: [previous.status, next.status] as const }),
    };
    if (Object.keys(change).length > 1) changed.push(change);
  }
  const ids = (documents: Iterable<ExportedDocument>) => [...documents].sort((a, b) => byText(a.id, b.id));
  return {
    added: ids([...now.values()].filter((document) => !was.has(document.id))),
    removed: ids([...was.values()].filter((document) => !now.has(document.id))),
    changed: changed.sort((a, b) => byText(a.id, b.id)),
  };
}

/**
 * The relations between documents, projected the way `--documents-only`
 * projects a graph: an item's edges lifted onto its document, and a relation
 * that ends where it began dropped - which is also what becomes of a document
 * containing its own items, so containment survives only between documents.
 * Where a relation was declared is not part of it - moving a supersession from
 * a sentence into front matter changes nothing a reader relies on.
 */
function relationsOf(graph: GraphExport): Map<string, ExportedRelation> {
  // A document, or a target nothing in the export defines, stands for itself.
  const owners = new Map(graph.items.map((item) => [item.id, item.document]));
  const out = new Map<string, ExportedRelation>();
  for (const edge of graph.edges) {
    const from = owners.get(edge.from) ?? edge.from;
    const to = owners.get(edge.to) ?? edge.to;
    if (from === to) continue;
    // Tab-joined: kinds and ids cannot contain one.
    out.set(`${edge.kind}\t${from}\t${to}`, { kind: edge.kind, from, to });
  }
  return out;
}

function compareRelations(before: GraphExport, after: GraphExport): GraphDiff['relations'] {
  const was = relationsOf(before);
  const now = relationsOf(after);
  const sorted = (entries: [string, ExportedRelation][]) => entries.sort(([a], [b]) => byText(a, b)).map(([, relation]) => relation);
  return {
    added: sorted([...now].filter(([key]) => !was.has(key))),
    removed: sorted([...was].filter(([key]) => !now.has(key))),
  };
}

/**
 * Obligations by where they sit and then by title, heading by heading, so a
 * section's own questions come before those of the sections under it.
 */
function byPlace(a: ObligationRef, b: ObligationRef): number {
  const left = [a.document, ...a.section];
  const right = [b.document, ...b.section];
  for (let at = 0; at < left.length && at < right.length; at++) {
    const order = byText(left[at] as string, right[at] as string);
    if (order !== 0) return order;
  }
  return left.length - right.length || byText(a.title, b.title);
}

/**
 * The headings an item sits under, below its document's own. A section path
 * starts at the document's heading, which is its title, so without this a
 * retitled document would lose track of every question in it.
 */
function headingsIn(graph: GraphExport): (item: ExportedItem) => readonly string[] {
  const titles = new Map(graph.documents.map((document) => [document.id, document.title]));
  return (item) => (item.section[0] === titles.get(item.document) ? item.section.slice(1) : item.section);
}

function compareObligations(before: GraphExport, after: GraphExport): GraphDiff['obligations'] {
  const headingsBefore = headingsIn(before);
  const headingsAfter = headingsIn(after);
  const pairs: [ExportedItem, ExportedItem][] = [];
  const paired = new Set<ExportedItem>();

  // A declared id names the same item in both states however it was reworded or
  // moved - provided it names one item on each side. An export without the flag
  // cannot say which ids were declared, so none of its ids are trusted.
  const declaredIn = (items: readonly ExportedItem[]) => {
    const out = new Map<string, ExportedItem | null>();
    for (const item of items) {
      if (item.declared !== true) continue;
      out.set(item.id, out.has(item.id) ? null : item);
    }
    return out;
  };
  const declaredBefore = declaredIn(before.items);
  const declaredAfter = declaredIn(after.items);
  for (const [id, item] of declaredBefore) {
    const match = declaredAfter.get(id);
    if (item === null || match === null || match === undefined) continue;
    pairs.push([item, match]);
    paired.add(item);
    paired.add(match);
  }

  // Otherwise the same document, headings and title, and only when nothing else
  // on either side shares them: two identical titles in one section cannot be
  // told apart, so neither is paired. Joined as JSON so that no two different
  // triples can produce the same key.
  const group = (items: readonly ExportedItem[], headings: (item: ExportedItem) => readonly string[]) => {
    const out = new Map<string, ExportedItem[]>();
    for (const item of items) {
      if (paired.has(item)) continue;
      const key = JSON.stringify([item.document, headings(item), item.title]);
      out.set(key, [...(out.get(key) ?? []), item]);
    }
    return out;
  };
  const was = group(before.items, headingsBefore);
  const now = group(after.items, headingsAfter);
  for (const [key, previous] of was) {
    const next = now.get(key);
    if (previous.length !== 1 || next?.length !== 1) continue;
    const [a, b] = [previous[0] as ExportedItem, next[0] as ExportedItem];
    pairs.push([a, b]);
    paired.add(a);
    paired.add(b);
  }

  const refIn = (headings: (item: ExportedItem) => readonly string[]) => (item: ExportedItem): ObligationRef => ({
    document: item.document,
    section: item.section,
    place: headings(item).join(' > '),
    title: item.title,
  });
  const wasRef = refIn(headingsBefore);
  const nowRef = refIn(headingsAfter);
  return {
    transitions: pairs
      .filter(([a, b]) => a.openness !== b.openness)
      .map(([a, b]) => ({ ...nowRef(b), openness: [a.openness, b.openness] as const }))
      .sort(byPlace),
    appeared: after.items.filter((item) => !paired.has(item)).map((item) => ({ ...nowRef(item), openness: item.openness })).sort(byPlace),
    disappeared: before.items.filter((item) => !paired.has(item)).map((item) => ({ ...wasRef(item), openness: item.openness })).sort(byPlace),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

function generatorName(generator: Generator | null): string {
  return generator === null ? 'an unknown version' : `${generator.name} ${generator.version}`;
}

/**
 * The warning a diff carries when its two exports may disagree for a reason
 * that is not the repository. `null` when both name the same generator.
 */
export function generatorWarning(diff: GraphDiff): string | null {
  const { before, after } = diff.generators;
  if (before !== null && after !== null && before.name === after.name && before.version === after.version) return null;
  return `the exports were made by ${generatorName(before)} and ${generatorName(after)}; a change in extraction between versions reads as a change in the repository`;
}

function changeCount(diff: GraphDiff): { documents: number; relations: number; obligations: number } {
  return {
    documents: diff.documents.added.length + diff.documents.removed.length + diff.documents.changed.length,
    relations: diff.relations.added.length + diff.relations.removed.length,
    obligations: diff.obligations.transitions.length + diff.obligations.appeared.length + diff.obligations.disappeared.length,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** One sentence for the whole diff, which is what a pull-request reader sees first. */
export function diffVerdict(diff: GraphDiff): string {
  const count = changeCount(diff);
  const parts = [
    count.documents > 0 ? plural(count.documents, 'document') : null,
    count.relations > 0 ? plural(count.relations, 'relation') : null,
    count.obligations > 0 ? plural(count.obligations, 'obligation') : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return 'No relational change.';
  const listed = parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
  return `${listed} changed.`;
}

function where(ref: ObligationRef): string {
  return ref.place === '' ? ref.document : `${ref.document} > ${ref.place}`;
}

function transitionWord([from, to]: readonly [string, string]): string {
  return to === 'closed' ? 'resolved' : from === 'closed' ? 'reopened' : to === 'partial' ? 'narrowed' : 'widened';
}

function describeChange(change: DocumentChange): string {
  const parts: string[] = [];
  if (change.path) parts.push(`moved from ${change.path[0]} to ${change.path[1]}`);
  if (change.phase) parts.push(`${change.phase[0]} -> ${change.phase[1]}`);
  if (change.status) parts.push(`status ${change.status[0] ?? 'none'} -> ${change.status[1] ?? 'none'}`);
  if (change.title) parts.push(`retitled "${change.title[1]}"`);
  return parts.join('; ');
}

/** The report for a terminal. */
export function formatDiffText(diff: GraphDiff): string {
  const lines: string[] = [];
  const warning = generatorWarning(diff);
  if (warning !== null) lines.push(`warning: ${warning}`, '');
  lines.push(diffVerdict(diff));

  const { documents, relations, obligations } = diff;
  if (documents.added.length + documents.removed.length + documents.changed.length > 0) {
    lines.push('', 'Documents');
    for (const document of documents.added) lines.push(`  + ${document.id}  ${document.title} (${document.phase})`);
    for (const document of documents.removed) lines.push(`  - ${document.id}  ${document.title}`);
    for (const change of documents.changed) lines.push(`  ~ ${change.id}  ${describeChange(change)}`);
  }
  if (relations.added.length + relations.removed.length > 0) {
    lines.push('', 'Relations');
    for (const relation of relations.added) lines.push(`  + ${relation.from} -${relation.kind}-> ${relation.to}`);
    for (const relation of relations.removed) lines.push(`  - ${relation.from} -${relation.kind}-> ${relation.to}`);
  }
  if (obligations.transitions.length + obligations.appeared.length + obligations.disappeared.length > 0) {
    lines.push('', 'Obligations');
    // Padded to the longest word, so the places line up.
    const word = (text: string) => text.padEnd('disappeared'.length);
    for (const transition of obligations.transitions) {
      lines.push(`  ${word(transitionWord(transition.openness))}  ${where(transition)}: "${transition.title}" (${transition.openness[0]} -> ${transition.openness[1]})`);
    }
    for (const item of obligations.appeared) lines.push(`  ${word('appeared')}  ${where(item)}: "${item.title}" (${item.openness})`);
    for (const item of obligations.disappeared) lines.push(`  disappeared  ${where(item)}: "${item.title}" (was ${item.openness})`);
  }
  return `${lines.join('\n')}\n`;
}

/** The report for a bot: the diff itself, with the verdict and warning beside it. */
export function formatDiffJson(diff: GraphDiff): string {
  return `${JSON.stringify({ version: 1, verdict: diffVerdict(diff), warning: generatorWarning(diff), ...diff }, null, 2)}\n`;
}

// A table cell: a pipe would end the cell, and a newline would end the row.
function cell(value: string): string {
  return value.replace(/[|]/g, '&#124;').replace(/\s+/g, ' ');
}

/** The report for a job summary or a pull-request comment. */
export function formatDiffMarkdown(diff: GraphDiff): string {
  const lines: string[] = ['### spec-graph diff', '', diffVerdict(diff), ''];
  const warning = generatorWarning(diff);
  if (warning !== null) lines.push(`> **Warning:** ${cell(warning)}.`, '');

  const { documents, relations, obligations } = diff;
  if (documents.added.length + documents.removed.length + documents.changed.length > 0) {
    lines.push('| | Document | Change |', '| --- | --- | --- |');
    for (const document of documents.added) lines.push(`| added | \`${cell(document.id)}\` | ${cell(document.title)} - ${cell(document.phase)} |`);
    for (const document of documents.removed) lines.push(`| removed | \`${cell(document.id)}\` | ${cell(document.title)} |`);
    for (const change of documents.changed) lines.push(`| changed | \`${cell(change.id)}\` | ${cell(describeChange(change))} |`);
    lines.push('');
  }
  if (relations.added.length + relations.removed.length > 0) {
    lines.push('| | From | Relation | To |', '| --- | --- | --- | --- |');
    for (const relation of relations.added) lines.push(`| added | \`${cell(relation.from)}\` | ${cell(relation.kind)} | \`${cell(relation.to)}\` |`);
    for (const relation of relations.removed) lines.push(`| removed | \`${cell(relation.from)}\` | ${cell(relation.kind)} | \`${cell(relation.to)}\` |`);
    lines.push('');
  }
  if (obligations.transitions.length + obligations.appeared.length + obligations.disappeared.length > 0) {
    lines.push('| | Where | Obligation |', '| --- | --- | --- |');
    for (const transition of obligations.transitions) {
      lines.push(`| ${transitionWord(transition.openness)} | ${cell(where(transition))} | ${cell(transition.title)} (${transition.openness[0]} -> ${transition.openness[1]}) |`);
    }
    for (const item of obligations.appeared) lines.push(`| appeared | ${cell(where(item))} | ${cell(item.title)} (${item.openness}) |`);
    for (const item of obligations.disappeared) lines.push(`| disappeared | ${cell(where(item))} | ${cell(item.title)} (was ${item.openness}) |`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
