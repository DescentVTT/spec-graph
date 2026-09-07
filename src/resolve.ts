/**
 * Corpus-level reference resolution - the foreign-key check.
 *
 * Extraction produces relations whose targets are still just text. This module
 * turns each into an edge or into an explicit, reportable failure. The whole
 * value of the exercise is in refusing to do either job carelessly:
 *
 * - **A deliberate reference that does not resolve is an error.** A link, a
 *   front-matter field or a directive naming a document that does not exist is
 *   a broken foreign key, and silence about it is how reference graphs rot.
 * - **An opportunistic reference that does not resolve is nothing.** `ADR-0007`
 *   written in prose is a citation; `SHA-256` is not. Since the two are
 *   indistinguishable in isolation, bare identifiers are only reported when
 *   their family already exists in the corpus - so `ADR-0099` in a repository
 *   full of ADRs is a finding, and `T-1000` in the same repository is not.
 * - **Two candidates is worse than none.** A reference that matches several
 *   documents is reported as ambiguous rather than silently bound to whichever
 *   one happened to be indexed first.
 */

import type { ExtractedDocument, ReferenceCandidate } from './extract.js';
import {
  isDocumentTarget,
  isExternal,
  looksLikePath,
  normaliseRef,
  parseBareRef,
  parsePrefixedRef,
  splitAnchor,
} from './identity.js';
import { basenamePosix, extnamePosix, resolveFrom } from './paths.js';
import type { DanglingRef, DocumentNode, Edge, ItemNode, ParseProblem, SpecNode } from './types.js';

export interface ResolveOptions {
  /**
   * Whether a repository-relative path exists on disk.
   *
   * Used only to tell "you linked to a file that is not a specification" apart
   * from "you linked to nothing at all", which are different mistakes with
   * different fixes.
   */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /**
   * Targets whose failure to resolve should not be reported.
   *
   * This is a *suppression* filter, not a resolution one: it is consulted only
   * when a reference has already failed to resolve. A reference that resolves
   * still becomes an edge no matter what this says, so no amount of
   * configuration can silently delete a relation from the graph.
   */
  readonly isIgnoredReference?: ((target: string) => boolean) | undefined;
}

export interface ResolvedCorpus {
  readonly nodes: ReadonlyMap<string, SpecNode>;
  readonly documents: readonly DocumentNode[];
  readonly items: readonly ItemNode[];
  readonly edges: readonly Edge[];
  readonly dangling: readonly DanglingRef[];
  readonly problems: readonly ParseProblem[];
}

interface Index {
  readonly byId: Map<string, string>;
  readonly byAlias: Map<string, Set<string>>;
  readonly byPath: Map<string, string>;
  readonly byFamilyNumber: Map<string, Set<string>>;
  readonly families: Set<string>;
  readonly anchors: Map<string, ReadonlySet<string>>;
  readonly itemIds: Set<string>;
  readonly familyOf: Map<string, string | null>;
}

/** Resolves every extracted reference against the whole corpus. */
export function resolveCorpus(
  extracted: readonly ExtractedDocument[],
  options: ResolveOptions = {},
): ResolvedCorpus {
  const index = buildIndex(extracted);
  const nodes = new Map<string, SpecNode>();
  const documents: DocumentNode[] = [];
  const items: ItemNode[] = [];
  const problems: ParseProblem[] = [];

  for (const entry of extracted) {
    const existing = nodes.get(entry.document.id);
    if (existing && existing.kind === 'document') {
      problems.push({
        message: `duplicate document id "${entry.document.id}", already declared by ${existing.path}`,
        at: entry.document.at,
      });
      continue;
    }
    nodes.set(entry.document.id, entry.document);
    documents.push(entry.document);
    for (const item of entry.items) {
      nodes.set(item.id, item);
      items.push(item);
    }
    problems.push(...entry.problems);
  }

  const edges: Edge[] = [];
  const dangling: DanglingRef[] = [];
  const byKey = new Map<string, number>();

  // Structural edges: a document contains its items.
  for (const item of items) {
    edges.push({
      kind: 'contains',
      from: item.document,
      to: item.id,
      origin: 'structural',
      declaredAt: item.at,
      raw: item.text,
      declaredIn: [item.at.file],
      reflexive: false,
    });
  }

  for (const entry of extracted) {
    for (const candidate of entry.references) {
      if (!nodes.has(candidate.from)) continue;
      const outcome = resolveOne(candidate, entry, index, nodes, options);
      if (outcome === null) continue;
      if ('reason' in outcome) {
        dangling.push(outcome);
        continue;
      }
      // Collapse duplicates: the same relation stated twice is one edge - but
      // every declaration site is kept, because a supersession recorded in only
      // one of the two documents is itself a finding.
      const key = `${outcome.kind} ${outcome.from} ${outcome.to}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        const previous = edges[existing] as Edge;
        if (!previous.declaredIn.includes(outcome.declaredAt.file)) {
          edges[existing] = { ...previous, declaredIn: [...previous.declaredIn, outcome.declaredAt.file] };
        }
        continue;
      }
      byKey.set(key, edges.length);
      edges.push(outcome);
    }
  }

  return { nodes, documents, items, edges, dangling, problems };
}

/* -------------------------------------------------------------------------- */
/* Indexing                                                                   */
/* -------------------------------------------------------------------------- */

function buildIndex(extracted: readonly ExtractedDocument[]): Index {
  const index: Index = {
    byId: new Map(),
    byAlias: new Map(),
    byPath: new Map(),
    byFamilyNumber: new Map(),
    families: new Set(),
    anchors: new Map(),
    itemIds: new Set(),
    familyOf: new Map(),
  };

  for (const entry of extracted) {
    const id = entry.document.id;
    index.byId.set(normaliseRef(id), id);
    index.anchors.set(id, entry.anchors);
    index.familyOf.set(id, entry.identity.family);

    for (const alias of entry.document.aliases) {
      const set = index.byAlias.get(alias) ?? new Set<string>();
      set.add(id);
      index.byAlias.set(alias, set);
    }

    for (const path of pathKeys(entry.document.path)) index.byPath.set(path, id);

    if (entry.identity.family !== null && entry.identity.number !== null) {
      index.families.add(entry.identity.family);
      const key = `${entry.identity.family}:${entry.identity.number}`;
      const set = index.byFamilyNumber.get(key) ?? new Set<string>();
      set.add(id);
      index.byFamilyNumber.set(key, set);
    }

    for (const item of entry.items) index.itemIds.add(item.id);
  }

  return index;
}

/** Every spelling of a path that a link might use. */
function pathKeys(path: string): string[] {
  const keys = new Set<string>([path.toLowerCase()]);
  const extension = extnamePosix(path);
  if (extension.length > 0) keys.add(path.slice(0, path.length - extension.length).toLowerCase());
  // `docs/adr/0007/README.md` is also addressed as `docs/adr/0007`.
  const base = basenamePosix(path);
  if (/^(readme|index)\./i.test(base)) {
    const parent = path.slice(0, path.length - base.length - 1);
    if (parent.length > 0) keys.add(parent.toLowerCase());
  }
  return [...keys];
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

function resolveOne(
  candidate: ReferenceCandidate,
  entry: ExtractedDocument,
  index: Index,
  nodes: ReadonlyMap<string, SpecNode>,
  options: ResolveOptions,
): Edge | DanglingRef | null {
  const { target: bare, anchor } = splitAnchor(candidate.target);

  // A pure `#anchor` points inside the citing document.
  if (bare.length === 0 && anchor !== null) {
    return bindAnchor(candidate, entry.document.id, anchor, index, nodes, options.isIgnoredReference);
  }

  if (isExternal(bare)) return null;
  // A link to source code, an image or a config file is not a specification
  // reference. Validating it would report an error on the most ordinary thing a
  // design document does.
  if (!isDocumentTarget(bare)) return null;

  const found = lookup(bare, entry, index);

  if (found.ids.length === 0) {
    if (candidate.opportunistic && !worthReporting(bare, index)) return null;
    if (options.isIgnoredReference?.(candidate.target)) return null;
    // A trailing slash names a directory. Linking to one is ordinary - "the
    // decisions live in [archive/](archive/)" - and is not a citation of any
    // document. Resolution is still attempted first, so a directory-style
    // document written as `0007-sharding/` continues to resolve.
    if (bare.endsWith('/')) return null;
    const reason = pathMissingReason(bare, entry, options);
    return dangle(candidate, reason, found.near);
  }

  if (found.ids.length > 1) {
    if (candidate.opportunistic) return null;
    if (options.isIgnoredReference?.(candidate.target)) return null;
    return dangle(candidate, 'ambiguous', found.ids);
  }

  const documentId = found.ids[0] as string;

  // A document naming itself in prose - almost always its own H1, `# ADR-0007:
  // Sharding` - is not a citation. Deliberate self-links are kept, because a
  // link that points at its own document is a real mistake worth reporting.
  if (candidate.opportunistic && documentId === entry.document.id) return null;

  if (anchor !== null) return bindAnchor(candidate, documentId, anchor, index, nodes, options.isIgnoredReference);

  return makeEdge(candidate, documentId);
}

interface Lookup {
  readonly ids: readonly string[];
  /** Near-misses worth suggesting in the report. */
  readonly near: readonly string[];
}

function lookup(target: string, entry: ExtractedDocument, index: Index): Lookup {
  if (looksLikePath(target)) {
    const resolved = resolveFrom(entry.document.path, target).toLowerCase();
    const byPath = index.byPath.get(resolved);
    if (byPath) return { ids: [byPath], near: [] };
    // A path may still be spelled as an identifier in a nested folder layout.
    const stem = basenamePosix(resolved);
    const byStem = index.byAlias.get(normaliseRef(stem.replace(/\.[^.]+$/, '')));
    if (byStem && byStem.size > 0) return { ids: [...byStem], near: [] };
    return { ids: [], near: [] };
  }

  const key = normaliseRef(target);
  if (key.length === 0) return { ids: [], near: [] };

  const byId = index.byId.get(key);
  if (byId) return { ids: [byId], near: [] };

  const byAlias = index.byAlias.get(key);
  if (byAlias && byAlias.size > 0) return { ids: [...byAlias], near: [] };

  const prefixed = parsePrefixedRef(target);
  if (prefixed) {
    const byFamily = index.byFamilyNumber.get(`${prefixed.family}:${prefixed.number}`);
    if (byFamily && byFamily.size > 0) return { ids: [...byFamily], near: [] };
    return { ids: [], near: [] };
  }

  // A bare number resolves only inside the citing document's own family. A
  // repository with both `adr/0007` and `rfc/0007` is ordinary, and guessing
  // between them would be worse than reporting nothing.
  const number = parseBareRef(target);
  if (number !== null) {
    const family = index.familyOf.get(entry.document.id) ?? null;
    if (family === null) return { ids: [], near: [] };
    const byFamily = index.byFamilyNumber.get(`${family}:${number}`);
    if (byFamily && byFamily.size > 0) return { ids: [...byFamily], near: [] };
  }

  return { ids: [], near: [] };
}

/**
 * Whether an unresolved bare identifier deserves a report.
 *
 * Only when the corpus already contains that family. `ADR-0099` in a repository
 * of ADRs is a real dangling citation; `T-1000` in the same repository is a
 * sentence about a robot.
 */
function worthReporting(target: string, index: Index): boolean {
  const prefixed = parsePrefixedRef(target);
  return prefixed !== null && index.families.has(prefixed.family);
}

function pathMissingReason(
  target: string,
  entry: ExtractedDocument,
  options: ResolveOptions,
): DanglingRef['reason'] {
  if (!looksLikePath(target) || !options.fileExists) return 'unknown-target';
  const resolved = resolveFrom(entry.document.path, target);
  return options.fileExists(resolved) ? 'not-a-spec' : 'unknown-target';
}

/**
 * Binds a `#anchor` to an item or a section.
 *
 * Anchors are how a delegation names a specific obligation rather than a whole
 * document, so resolving them precisely is what lets a ghost-handover finding
 * say *which* question was handed into the archive.
 */
function bindAnchor(
  candidate: ReferenceCandidate,
  documentId: string,
  anchor: string,
  index: Index,
  nodes: ReadonlyMap<string, SpecNode>,
  isIgnored: ((target: string) => boolean) | undefined,
): Edge | DanglingRef | null {
  const itemId = `${documentId}#${anchor}`;
  if (index.itemIds.has(itemId)) return makeEdge(candidate, itemId);

  const anchors = index.anchors.get(documentId);
  if (anchors?.has(anchor.toLowerCase())) return makeEdge(candidate, documentId);

  // Some renderers slugify differently; try the loosest reasonable match before
  // calling it broken.
  const loose = anchor.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  if (anchors?.has(loose)) return makeEdge(candidate, documentId);

  if (isIgnored?.(candidate.target)) return null;

  const candidates = [...(nodes.keys() as Iterable<string>)].filter(
    (id) => id.startsWith(`${documentId}#`) && id.toLowerCase().includes(loose),
  );
  return {
    kind: candidate.kind,
    from: candidate.from,
    target: candidate.target,
    reason: 'unknown-anchor',
    origin: candidate.origin,
    declaredAt: candidate.declaredAt,
    raw: candidate.raw,
    candidates,
  };
}

function makeEdge(candidate: ReferenceCandidate, resolved: string): Edge {
  const from = candidate.inverted ? resolved : candidate.from;
  const to = candidate.inverted ? candidate.from : resolved;
  return {
    kind: candidate.kind,
    from,
    to,
    origin: candidate.origin,
    declaredAt: candidate.declaredAt,
    raw: candidate.raw,
    declaredIn: [candidate.declaredAt.file],
    reflexive: documentOf(from) === documentOf(to),
  };
}

function dangle(
  candidate: ReferenceCandidate,
  reason: DanglingRef['reason'],
  candidates: readonly string[],
): DanglingRef {
  return {
    kind: candidate.kind,
    from: candidate.from,
    target: candidate.target,
    reason,
    origin: candidate.origin,
    declaredAt: candidate.declaredAt,
    raw: candidate.raw,
    candidates,
  };
}

/** The document part of a node id: `ADR-7#q.1` -> `ADR-7`. */
export function documentOf(nodeId: string): string {
  const hash = nodeId.indexOf('#');
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
}
