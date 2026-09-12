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
  withinOneEdit,
} from './identity.js';
import { basenamePosix, dirnamePosix, extnamePosix, resolveFrom } from './paths.js';
import type {
  DanglingRef,
  DocumentNode,
  Edge,
  ItemNode,
  MisreadKey,
  ParseProblem,
  SpecNode,
  SuppressedRef,
} from './types.js';

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
  /**
   * Families that are never citations in this repository.
   *
   * `RFC 2119` is the canonical case: every specification cites it, and a
   * repository that keeps its own `RFC-*` documents will otherwise read that
   * sentence as a dangling reference to a local RFC 2119 it does not have.
   * Consulted only after resolution has failed, like every other filter here.
   */
  readonly isIgnoredFamily?: ((family: string) => boolean) | undefined;
}

export interface ResolvedCorpus {
  readonly nodes: ReadonlyMap<string, SpecNode>;
  readonly documents: readonly DocumentNode[];
  readonly items: readonly ItemNode[];
  readonly edges: readonly Edge[];
  readonly dangling: readonly DanglingRef[];
  readonly problems: readonly ParseProblem[];
  readonly misreadKeys: readonly MisreadKey[];
  /**
   * References this repository declared none of its business.
   *
   * Not findings, and never reported as such - they are the audit trail for
   * the two settings that can silence one. See ADR-0008.
   */
  readonly suppressed: readonly SuppressedRef[];
}

interface Index {
  readonly byId: Map<string, string>;
  readonly byAlias: Map<string, Set<string>>;
  /** The literal path of a file. Unique: no two files share one. */
  readonly byPath: Map<string, string>;
  /**
   * Spellings that address a file without naming it exactly - the extension
   * dropped, a directory standing for its README. Several files can answer to
   * one of those, so this is a set, exactly as `byAlias` is.
   */
  readonly byPathAlias: Map<string, Set<string>>;
  readonly byFamilyNumber: Map<string, Set<string>>;
  readonly families: Set<string>;
  /** Every file by the directory holding it, for a basename that was mistyped. */
  readonly byDirectory: Map<string, { stem: string; id: string }[]>;
  /**
   * Alias keys grouped by length.
   *
   * A one-edit match can only differ in length by one, so this turns the scan
   * behind a suggestion from the whole corpus into three buckets of it.
   */
  readonly aliasesByLength: Map<number, string[]>;
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
  const misreadKeys: MisreadKey[] = [];

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
    misreadKeys.push(...entry.misreadKeys);
  }

  const edges: Edge[] = [];
  const dangling: DanglingRef[] = [];
  const suppressed: SuppressedRef[] = [];
  const byKey = new Map<string, number>();

  // Structural edges: a register contains the specifications written inside it.
  for (const entry of extracted) {
    if (entry.containerId === null) continue;
    if (!nodes.has(entry.containerId) || !nodes.has(entry.document.id)) continue;
    edges.push({
      kind: 'contains',
      from: entry.containerId,
      to: entry.document.id,
      origin: 'structural',
      declaredAt: entry.document.at,
      raw: entry.document.title,
      declaredIn: [entry.document.at.file],
      reflexive: false,
    });
  }

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
      if ('by' in outcome) {
        suppressed.push(outcome);
        continue;
      }
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

  return { nodes, documents, items, edges, dangling, problems, misreadKeys, suppressed };
}

/* -------------------------------------------------------------------------- */
/* Indexing                                                                   */
/* -------------------------------------------------------------------------- */

function buildIndex(extracted: readonly ExtractedDocument[]): Index {
  const index: Index = {
    byId: new Map(),
    byAlias: new Map(),
    byPath: new Map(),
    byPathAlias: new Map(),
    byFamilyNumber: new Map(),
    families: new Set(),
    byDirectory: new Map(),
    aliasesByLength: new Map(),
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

    // Only a file answers to its path. A region keeps the path on its node, so a
    // finding can say where it lives and `document[path=...]` can select it, but
    // it must not be reachable *by* that path: two nodes answering to one path
    // makes every link to the file ambiguous, and this index resolves a
    // collision by keeping whichever was written last. A link to a file holding
    // a register bound to its final row, quietly and with no diagnostic, and
    // anchors were then checked against that row's span rather than the file's.
    // ADR-0009 said a region does not claim the file's path; this is the index
    // where that had to be true.
    if (entry.containerId === null) {
      const path = entry.document.path.toLowerCase();
      index.byPath.set(path, id);
      for (const spelling of pathAliases(entry.document.path)) {
        const set = index.byPathAlias.get(spelling) ?? new Set<string>();
        set.add(id);
        index.byPathAlias.set(spelling, set);
      }
      const directory = dirnamePosix(path);
      const siblings = index.byDirectory.get(directory) ?? [];
      siblings.push({ stem: stemOf(path), id });
      index.byDirectory.set(directory, siblings);
    }

    if (entry.identity.family !== null && entry.identity.number !== null) {
      index.families.add(entry.identity.family);
      const key = `${entry.identity.family}:${entry.identity.number}`;
      const set = index.byFamilyNumber.get(key) ?? new Set<string>();
      set.add(id);
      index.byFamilyNumber.set(key, set);
    }

    for (const item of entry.items) index.itemIds.add(item.id);
  }

  for (const alias of index.byAlias.keys()) {
    const bucket = index.aliasesByLength.get(alias.length) ?? [];
    bucket.push(alias);
    index.aliasesByLength.set(alias.length, bucket);
  }

  return index;
}

/** A file name with its extension taken off: `docs/a/0004-sharding.md` -> `0004-sharding`. */
function stemOf(path: string): string {
  const base = basenamePosix(path);
  return base.slice(0, base.length - extnamePosix(base).length);
}

/** Every spelling of a path that addresses a file without naming it exactly. */
function pathAliases(path: string): string[] {
  const keys = new Set<string>();
  const extension = extnamePosix(path);
  if (extension.length > 0) keys.add(path.slice(0, path.length - extension.length).toLowerCase());
  // `docs/adr/0007/README.md` is also addressed as `docs/adr/0007`.
  const base = basenamePosix(path);
  if (/^(readme|index)\./i.test(base)) {
    const parent = path.slice(0, path.length - base.length - 1);
    if (parent.length > 0) keys.add(parent.toLowerCase());
  }
  // A file never addresses itself inexactly. Leaving this in would let a
  // contrived name - `docs/a.md.md`, whose stem is another file's whole path -
  // make an exact link look ambiguous.
  keys.delete(path.toLowerCase());
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
): Edge | DanglingRef | SuppressedRef | null {
  const { target: bare, anchor } = splitAnchor(candidate.target);

  // A pure `#anchor` points inside the citing document.
  if (bare.length === 0 && anchor !== null) {
    return bindAnchor(candidate, entry.document.id, anchor, index, nodes, options);
  }

  if (isExternal(bare)) return null;
  // A link to source code, an image or a config file is not a specification
  // reference. Validating it would report an error on the most ordinary thing a
  // design document does.
  if (!isDocumentTarget(bare)) return null;

  const found = lookup(bare, entry, index);

  if (found.ids.length === 0) {
    if (candidate.opportunistic && !worthReporting(bare, index)) return null;
    const silenced = filteredBy(candidate.target, bare, options);
    if (silenced !== null) return suppression(candidate, silenced);
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
    const silenced = filteredBy(candidate.target, bare, options);
    if (silenced !== null) return suppression(candidate, silenced);
    return dangle(candidate, 'ambiguous', found.ids);
  }

  const documentId = found.ids[0] as string;

  // A document naming itself in prose - almost always its own H1, `# ADR-0007:
  // Sharding` - is not a citation. Deliberate self-links are kept, because a
  // link that points at its own document is a real mistake worth reporting.
  if (candidate.opportunistic && documentId === entry.document.id) return null;

  if (anchor !== null) return bindAnchor(candidate, documentId, anchor, index, nodes, options);

  return makeEdge(candidate, documentId);
}

interface Lookup {
  readonly ids: readonly string[];
  /** Near-misses worth suggesting in the report. */
  readonly near: readonly string[];
}

/**
 * The same path with its percent-escapes read.
 *
 * `[Design](docs/my%20design.md)` is what a renderer, a documentation site and
 * GitHub's own "copy link" all produce for a file with a space in its name, and
 * it names a real file. Returns `null` when there was nothing to decode or when
 * the escapes are malformed - `100%` in a path is not an escape sequence, and
 * `decodeURIComponent` throws on it.
 */
function percentDecoded(target: string): string | null {
  if (!target.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(target);
    return decoded === target ? null : decoded;
  } catch {
    return null;
  }
}

function lookup(target: string, entry: ExtractedDocument, index: Index): Lookup {
  const exact = lookupExact(target, entry, index);
  if (exact.length > 0) return { ids: exact, near: [] };
  // Tried second and never first, so a repository holding a file whose name
  // genuinely contains a percent escape keeps resolving by its written spelling.
  const decoded = percentDecoded(target);
  const relaxed = decoded === null ? [] : lookupExact(decoded, entry, index);
  if (relaxed.length > 0) return { ids: relaxed, near: [] };
  // Suggestions are computed only once resolution has failed outright, so their
  // cost is bounded by the number of findings rather than by the corpus.
  return { ids: [], near: nearMisses(target, entry, index) };
}

function lookupExact(target: string, entry: ExtractedDocument, index: Index): readonly string[] {
  if (looksLikePath(target)) {
    const resolved = resolveFrom(entry.document.path, target).toLowerCase();
    // Naming the file exactly is never ambiguous, whatever else is spelled the
    // same way.
    const byPath = index.byPath.get(resolved);
    if (byPath) return [byPath];
    // An inexact spelling can belong to more than one file: `docs/A` is both
    // `docs/A.md` with its extension dropped and `docs/A/README.md` standing
    // for its directory. Handing back every claimant makes that an
    // ambiguous-reference the author can settle, rather than a silent pick of
    // whichever happened to be indexed last.
    const spelled = index.byPathAlias.get(resolved);
    if (spelled && spelled.size > 0) return [...spelled];
    // A path may still be spelled as an identifier in a nested folder layout.
    const stem = basenamePosix(resolved);
    const byStem = index.byAlias.get(normaliseRef(stem.replace(/\.[^.]+$/, '')));
    if (byStem && byStem.size > 0) return [...byStem];
    return [];
  }

  const key = normaliseRef(target);
  if (key.length === 0) return [];

  const byId = index.byId.get(key);
  if (byId) return [byId];

  const byAlias = index.byAlias.get(key);
  if (byAlias && byAlias.size > 0) return [...byAlias];

  const prefixed = parsePrefixedRef(target);
  if (prefixed) {
    const byFamily = index.byFamilyNumber.get(`${prefixed.family}:${prefixed.number}`);
    if (byFamily && byFamily.size > 0) return [...byFamily];
    return [];
  }

  // A bare number resolves only inside the citing document's own family. A
  // repository with both `adr/0007` and `rfc/0007` is ordinary, and guessing
  // between them would be worse than reporting nothing.
  const number = parseBareRef(target);
  if (number !== null) {
    const family = index.familyOf.get(entry.document.id) ?? null;
    if (family === null) return [];
    const byFamily = index.byFamilyNumber.get(`${family}:${number}`);
    if (byFamily && byFamily.size > 0) return [...byFamily];
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/* Near misses                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The one document a failed reference was probably meant to name.
 *
 * A suggestion is cheap to read and expensive to get wrong: "did you mean
 * ADR-0008?" against a citation that meant ADR-0012 sends a reader to the wrong
 * decision with a confidence nobody earned. So the bar is not closeness, it is
 * closeness *in the part of the spelling that is not the identity*. A family
 * name is a word people misremember. A number is the identity itself, and
 * `ADR-0009` sits one edit from every neighbour it has - so numbers are never
 * guessed at, and a repository of fifteen ADRs citing a sixteenth is told the
 * plain truth instead.
 *
 * Two gates, plus a fallback:
 *
 * - a path in the right directory whose basename is one edit out - a typo;
 * - a family one edit out with its number intact - `ARD-0009` for `ADR-0009`.
 *
 * Anything else falls through to a one-edit match against the folded spellings
 * documents already answer to, which is where a mistyped slug or wiki name
 * lands.
 *
 * There is deliberately no gate for a file that moved. Resolution already binds
 * a path by its basename, so `../guides/onboarding.md` finds the document that
 * is now in `handbook/` without anybody being asked to confirm a guess - and a
 * suggestion nobody needs is a suggestion that can only be wrong.
 *
 * Every gate ends the same way: **exactly one** candidate, or nothing. Two
 * suggestions is the ambiguity this module refuses to resolve anywhere else,
 * and the tail of a hint is no place to start.
 */
function nearMisses(target: string, entry: ExtractedDocument, index: Index): string[] {
  if (looksLikePath(target)) {
    const resolved = resolveFrom(entry.document.path, target).toLowerCase();
    const stem = stemOf(resolved);
    const siblings = index.byDirectory.get(dirnamePosix(resolved)) ?? [];
    return sole(siblings.filter((file) => withinOneEdit(file.stem, stem)).map((file) => file.id));
  }

  const prefixed = parsePrefixedRef(target);
  if (prefixed !== null) {
    const hits: string[] = [];
    for (const family of index.families) {
      // The family as written needs no exclusion: one edit is never zero edits.
      if (!withinOneEdit(family.toLowerCase(), prefixed.family.toLowerCase())) continue;
      for (const id of index.byFamilyNumber.get(`${family}:${prefixed.number}`) ?? []) hits.push(id);
    }
    return sole(hits);
  }

  // A bare `12` carries nothing but a number, which is the one thing this
  // refuses to guess at.
  if (parseBareRef(target) !== null) return [];

  const key = normaliseRef(target);
  if (key.length < MIN_SUGGESTIBLE) return [];
  const hits: string[] = [];
  for (const length of [key.length - 1, key.length, key.length + 1]) {
    for (const alias of index.aliasesByLength.get(length) ?? []) {
      if (!withinOneEdit(alias, key)) continue;
      for (const id of index.byAlias.get(alias) ?? []) hits.push(id);
    }
  }
  return sole(hits);
}

/**
 * How long a folded spelling has to be before one edit means anything.
 *
 * Below six characters an edit is most of the word, and every corpus is full of
 * short names that differ by exactly that much.
 */
const MIN_SUGGESTIBLE = 6;

/** The candidates, if there is exactly one of them. Otherwise nothing. */
function sole(ids: Iterable<string>): string[] {
  const unique = new Set(ids);
  return unique.size === 1 ? [...unique] : [];
}

/**
 * Which setting, if any, declared this reference none of the repository's
 * business.
 *
 * Returns the mechanism rather than a boolean so the audit trail can say which
 * line of configuration to go and look at. A team that silenced eight things
 * with one glob and one with a family needs to be told them apart.
 */
function filteredBy(target: string, bare: string, options: ResolveOptions): SuppressedRef['by'] | null {
  if (options.isIgnoredReference?.(target)) return 'reference';
  const prefixed = parsePrefixedRef(bare);
  if (prefixed !== null && options.isIgnoredFamily?.(prefixed.family) === true) return 'family';
  return null;
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
  options: ResolveOptions,
): Edge | DanglingRef | SuppressedRef | null {
  const itemId = `${documentId}#${anchor}`;
  if (index.itemIds.has(itemId)) return makeEdge(candidate, itemId);

  const anchors = index.anchors.get(documentId);
  if (anchors?.has(anchor.toLowerCase())) return makeEdge(candidate, documentId);

  // Some renderers slugify differently; try the loosest reasonable match before
  // calling it broken.
  const loose = anchor.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  if (anchors?.has(loose)) return makeEdge(candidate, documentId);

  const silenced = filteredBy(candidate.target, splitAnchor(candidate.target).target, options);
  if (silenced !== null) return suppression(candidate, silenced);

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

function suppression(candidate: ReferenceCandidate, by: SuppressedRef['by']): SuppressedRef {
  return { target: candidate.target, from: candidate.from, at: candidate.declaredAt, by };
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
