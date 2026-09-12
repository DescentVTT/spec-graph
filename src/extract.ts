/**
 * Document extraction: Markdown in, graph fragments out.
 *
 * This module is where domain-agnosticism is won or lost. It never requires a
 * repository to adopt a syntax. It reads what teams already write - front
 * matter, a `## Status` section, a checklist under `## Open Questions`, a link
 * that says "deferred to ADR-0011" - and turns each into a typed relation with a
 * source position.
 *
 * The one rule it holds to everywhere: **an inference that cannot be justified
 * is not made.** An unrecognised status becomes `unknown`, not a guess. A link
 * with no governing verb becomes a neutral `references`, not a dependency. Bare
 * identifiers found in prose are opportunistic and are dropped silently when
 * they do not resolve, because the alternative is reporting `SHA-256` as a
 * broken reference to specification 256.
 */

import { attr, attrList, directiveFor, parseDirectives, type Directive } from './directives.js';
import {
  identify,
  isDocumentTarget,
  isExternal,
  looksLikePath,
  normaliseRef,
  parsePrefixedRef,
  withinOneEdit,
  type DocumentIdentity,
  ID_KEYS,
} from './identity.js';
import { isStatusHeading, phaseFromPath, phaseOf, STATUS_KEYS, supersessionTargetsIn } from './lifecycle.js';
import { scanMarkdown, slugify, type Link, type ListItem, type ScannedDocument } from './markdown.js';
import { findSpecificationRegions, regionAt, type SpecificationRegion } from './sections.js';
import { resolveItemState } from './state.js';
import { refOf, type LineIndex } from './source.js';
import type {
  DocumentNode,
  EdgeKind,
  EdgeOrigin,
  ItemNode,
  MisreadKey,
  ParseProblem,
  Phase,
  SourceRef,
} from './types.js';
import { parseFrontMatter, toRecord, valuesOf, type YamlEntry } from './yaml.js';

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A relation that has been read but not yet resolved to a target node.
 *
 * Resolution needs the whole corpus, so extraction stops at the raw target text.
 */
export interface ReferenceCandidate {
  readonly kind: EdgeKind;
  /** Id of the node the relation was written on. */
  readonly from: string;
  /** The target exactly as written: a path, an identifier, or a URL. */
  readonly target: string;
  readonly origin: EdgeOrigin;
  readonly declaredAt: SourceRef;
  readonly raw: string;
  /**
   * When true the relation runs `target -> from`.
   *
   * `superseded-by: ADR-0009` written in ADR-0003 declares that *ADR-0009*
   * supersedes ADR-0003. The edge belongs to ADR-0009; the line a human must go
   * and fix is in ADR-0003, which is why `declaredAt` is tracked separately.
   */
  readonly inverted: boolean;
  /**
   * Opportunistic references are dropped in silence when they do not resolve.
   * Only deliberate ones - links, front matter, directives - are reported.
   */
  readonly opportunistic: boolean;
}

export interface ExtractedDocument {
  readonly document: DocumentNode;
  readonly items: readonly ItemNode[];
  readonly references: readonly ReferenceCandidate[];
  readonly problems: readonly ParseProblem[];
  /**
   * Front-matter keys that read as relations and declared none.
   *
   * Kept apart from `problems` because a problem is about the text and this is
   * about the graph: the edge the author wrote down is not in it.
   */
  readonly misreadKeys: readonly MisreadKey[];
  /** Heading slugs, for resolving `#anchor` references into this document. */
  readonly anchors: ReadonlySet<string>;
  readonly identity: DocumentIdentity;
  readonly scanned: ScannedDocument;
  /**
   * Specifications declared inside this file, each a document in its own right.
   *
   * Empty for the ordinary one-file-per-decision layout, which is why nothing
   * downstream had to change to support registers.
   */
  readonly subSpecifications: readonly ExtractedDocument[];
  /**
   * The file-level specification this one is a region of, if any.
   *
   * Recorded so the register's structure is a relation in the graph rather than
   * an accident of which offsets fall inside which: "what decisions does this
   * register hold" is a question worth being able to ask.
   */
  readonly containerId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Front-matter keys that declare a relation, and what they mean.
 *
 * Every directional kind is spelled in **both** directions. A register that
 * records `depends-on` but not `depended-on-by` is not a smaller vocabulary, it
 * is a trap: the author writes the inverse, the key means nothing, and the edge
 * they declared is missing from a graph that reports itself as consistent. Which
 * half of a pair a repository writes is a filing convention, and a filing
 * convention is not something a linter gets to have an opinion about.
 *
 * `relates-to` is the exception, and it is not one: the relation is symmetric,
 * so it has no other direction to spell. `contains` is structural and never
 * written by hand. `tests/parsing.test.ts` holds both facts to the fire.
 */
export const RELATION_KEYS: Readonly<Record<string, { kind: EdgeKind; inverted: boolean }>> = {
  supersedes: { kind: 'supersedes', inverted: false },
  supercedes: { kind: 'supersedes', inverted: false },
  replaces: { kind: 'supersedes', inverted: false },
  obsoletes: { kind: 'supersedes', inverted: false },
  deprecates: { kind: 'supersedes', inverted: false },
  'superseded-by': { kind: 'supersedes', inverted: true },
  'superceded-by': { kind: 'supersedes', inverted: true },
  'replaced-by': { kind: 'supersedes', inverted: true },
  'obsoleted-by': { kind: 'supersedes', inverted: true },
  'deprecated-by': { kind: 'supersedes', inverted: true },
  'rolled-into': { kind: 'supersedes', inverted: true },
  amends: { kind: 'amends', inverted: false },
  extends: { kind: 'amends', inverted: false },
  refines: { kind: 'amends', inverted: false },
  clarifies: { kind: 'amends', inverted: false },
  revises: { kind: 'amends', inverted: false },
  'amended-by': { kind: 'amends', inverted: true },
  'extended-by': { kind: 'amends', inverted: true },
  'refined-by': { kind: 'amends', inverted: true },
  'clarified-by': { kind: 'amends', inverted: true },
  'revised-by': { kind: 'amends', inverted: true },
  'depends-on': { kind: 'depends-on', inverted: false },
  'dependent-on': { kind: 'depends-on', inverted: false },
  dependencies: { kind: 'depends-on', inverted: false },
  requires: { kind: 'depends-on', inverted: false },
  'builds-on': { kind: 'depends-on', inverted: false },
  'relies-on': { kind: 'depends-on', inverted: false },
  'depended-on-by': { kind: 'depends-on', inverted: true },
  'required-by': { kind: 'depends-on', inverted: true },
  dependents: { kind: 'depends-on', inverted: true },
  assumes: { kind: 'assumes', inverted: false },
  'assumed-by': { kind: 'assumes', inverted: true },
  'blocked-by': { kind: 'blocked-by', inverted: false },
  'blocked-on': { kind: 'blocked-by', inverted: false },
  'waiting-on': { kind: 'blocked-by', inverted: false },
  'waiting-for': { kind: 'blocked-by', inverted: false },
  'gated-on': { kind: 'blocked-by', inverted: false },
  'gated-by': { kind: 'blocked-by', inverted: false },
  blocks: { kind: 'blocked-by', inverted: true },
  'delegates-to': { kind: 'delegates-to', inverted: false },
  'delegated-to': { kind: 'delegates-to', inverted: false },
  'deferred-to': { kind: 'delegates-to', inverted: false },
  'tracked-in': { kind: 'delegates-to', inverted: false },
  'tracked-by': { kind: 'delegates-to', inverted: false },
  'continued-in': { kind: 'delegates-to', inverted: false },
  'delegated-from': { kind: 'delegates-to', inverted: true },
  related: { kind: 'relates-to', inverted: false },
  'relates-to': { kind: 'relates-to', inverted: false },
  'related-to': { kind: 'relates-to', inverted: false },
  'see-also': { kind: 'relates-to', inverted: false },
  references: { kind: 'references', inverted: false },
  reference: { kind: 'references', inverted: false },
  refs: { kind: 'references', inverted: false },
  'referenced-by': { kind: 'references', inverted: true },
};

/**
 * True when a front-matter value is shaped like a citation.
 *
 * The second half of the gate on {@link misreadRelationKeys}, and the half that
 * does the work. `sidebar_position: 4` and `ref: main` are a hair away from a
 * relation key by spelling alone; neither carries anything that could name a
 * document, and reporting them would make the rule an irritation rather than a
 * catch (ADR-0006).
 */
function looksLikeCitation(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (parsePrefixedRef(trimmed) !== null) return true;
  return looksLikePath(trimmed) && isDocumentTarget(trimmed) && !isExternal(trimmed);
}

/**
 * Front-matter keys that read as relations and declare none.
 *
 * Front matter is an open vocabulary and most of what lives there is nobody
 * else's business, so the bar is deliberately high: the key has to be one edit
 * from a relation key *and* carry something that could name a document. Both
 * conditions together are what separates `dependson: ADR-0001`, which is an edge
 * the author believes exists, from `description: ...`, which is a title.
 */
function misreadRelationKeys(
  byKey: ReadonlyMap<string, YamlEntry>,
  from: string,
  at: (start: number, end: number) => SourceRef,
): MisreadKey[] {
  const out: MisreadKey[] = [];
  for (const [key, entry] of byKey) {
    const folded = foldRelationKey(key);
    if (folded.length === 0 || RELATION_INDEX.has(folded)) continue;
    if (!valuesOf(entry).some(looksLikeCitation)) continue;
    const near = [...RELATION_INDEX.values()]
      .filter((relation) => withinOneEdit(folded, foldRelationKey(relation.canonical)))
      .map((relation) => relation.canonical);
    if (near.length === 0) continue;
    out.push({ key, suggestion: near.join(', '), from, at: at(entry.start, entry.end) });
  }
  return out;
}

/**
 * Folds a front-matter key to its lookup form.
 *
 * `depends-on`, `depends_on`, `dependsOn` and `Depends On` are one key written
 * four ways, and which one a repository uses is decided by whatever wrote the
 * front matter first. Dropping every separator collapses them - the YAML reader
 * has already lower-cased the key, which is what makes camel case fold too.
 *
 * Which case this folds to is arbitrary and no test pins it: both sides of every
 * comparison come through here, so upper would work exactly as well. Asserting
 * on it would be asserting on the implementation.
 */
export function foldRelationKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** The vocabulary above, indexed by folded key. */
const RELATION_INDEX: ReadonlyMap<string, { kind: EdgeKind; inverted: boolean; canonical: string }> = new Map(
  Object.entries(RELATION_KEYS).map(([canonical, relation]) => [
    foldRelationKey(canonical),
    { ...relation, canonical },
  ]),
);

/**
 * Keys a region must answer for itself, so the file's answer cannot shadow one.
 *
 * Identity and status and title are the three things a register exists to vary
 * row by row. The rest of the file's front matter describes the file, and a
 * decision inside the file is described by it too.
 */
const UNINHERITED: ReadonlySet<string> = new Set([...ID_KEYS, ...STATUS_KEYS, 'title', 'alias', 'aliases']);

/**
 * The front matter a region inherits from the file that contains it.
 *
 * [ADR-0009](../docs/adr/0009-a-specification-is-a-region.md) left this open,
 * and [ADR-0016](../docs/adr/0016-a-query-needs-a-sentence.md) made leaving it
 * open a defect. A repository can now write `document[fm.owner!=platform]` as a
 * rule of its own, and on a register every region answered nothing - which
 * `!=` reads as a mismatch, because an absent value is not the value. A file
 * whose front matter said `owner: platform` was reported twice for not being
 * owned by platform, and the message rendered `{0.fm.owner}` as the literal
 * placeholder. Confident, wrong, and unanswerable: the ADR-0006 failure.
 *
 * Two kinds of key stay behind. A relation key is a claim the file made -
 * `supersedes:` at the top of a register supersedes on behalf of the register,
 * not on behalf of each decision in it, and the edges were built from the
 * file's entries before this ran. And a key the region answers itself must not
 * be shadowed, which is {@link UNINHERITED}.
 */
export function inheritableFrontMatter(
  entries: readonly YamlEntry[],
): Readonly<Record<string, string | readonly string[]>> {
  return toRecord(
    entries.filter((entry) => !UNINHERITED.has(entry.key) && !RELATION_INDEX.has(foldRelationKey(entry.key))),
  );
}

/**
 * Phrases that give a link its meaning, longest-matching-nearest wins.
 *
 * Only phrases that genuinely commit the citing document are here. Vague ones
 * ("see", "covered by") stay out: a `references` edge is harmless, whereas a
 * wrongly inferred `assumes` edge produces a confident stale-premise finding
 * about a document that never depended on anything.
 */
const VERB_RULES: readonly { kind: EdgeKind; inverted: boolean; phrases: readonly string[] }[] = [
  {
    kind: 'supersedes',
    inverted: true,
    phrases: ['superseded by', 'superceded by', 'replaced by', 'obsoleted by', 'deprecated by', 'rolled into'],
  },
  { kind: 'supersedes', inverted: false, phrases: ['supersedes', 'supercedes', 'replaces', 'obsoletes', 'deprecates'] },
  { kind: 'amends', inverted: true, phrases: ['amended by', 'refined by', 'clarified by', 'revised by'] },
  { kind: 'amends', inverted: false, phrases: ['amends', 'refines', 'clarifies', 'revises'] },
  {
    kind: 'delegates-to',
    inverted: false,
    phrases: [
      'delegated to',
      'delegate to',
      'deferred to',
      'defer to',
      'moved to',
      'move to',
      'tracked in',
      'tracked by',
      'handed off to',
      'handed to',
      'hand off to',
      'follow up in',
      'follow-up in',
      'followup in',
      'continued in',
      'continues in',
      'punted to',
      'left to',
      'belongs in',
      'owned by',
      'will be decided in',
      'will be resolved in',
      'will be handled in',
      'will be handled by',
      'will be answered in',
      'to be decided in',
      'to be resolved in',
      'to be handled in',
      'to be answered in',
    ],
  },
  {
    kind: 'blocked-by',
    inverted: false,
    phrases: ['blocked by', 'blocked on', 'waiting on', 'waiting for', 'gated on', 'gated by', 'unblocked by'],
  },
  { kind: 'blocked-by', inverted: true, phrases: ['blocks', 'blocking'] },
  {
    kind: 'depends-on',
    inverted: false,
    phrases: ['depends on', 'depend on', 'dependent on', 'requires', 'builds on', 'built on', 'relies on'],
  },
  { kind: 'depends-on', inverted: true, phrases: ['depended on by'] },
  {
    kind: 'assumes',
    inverted: false,
    phrases: [
      'assumes',
      'assuming',
      'on the assumption of',
      'as decided in',
      'as established in',
      'as established by',
      'as stated in',
      'as specified in',
      'as required by',
      'as mandated by',
      'in accordance with',
      'constrained by',
      'mandated by',
      'governed by',
      'predicated on',
      'rests on',
      'follows from',
      'justified by',
      // A constraint the citing document designs around. "the row limit imposed
      // by ADR-0002" is the archetypal stale premise: when ADR-0002 is retired,
      // this document is still working around a cap that no longer exists.
      'imposed by',
      'required by',
      'dictated by',
      'determined by',
      'limited by',
      'capped by',
      'bounded by',
      'defined by',
      'defined in',
      'specified by',
      'set by',
      'per',
      'because',
      'since',
    ],
  },
];

/**
 * Words that cancel a governing phrase standing before them.
 *
 * The window allows a short noun phrase between a verb and the reference it
 * governs - "deferred to the sharding decision in [ADR-7]" is one statement.
 * It cannot allow a negation. A table entry reading "Owned by nobody today and
 * disclaimed by [138]" was being read as a delegation *to* 138, which is the
 * opposite of what the sentence says, and an inference that inverts its source
 * is worse than no inference at all.
 */
const NEGATION = /(?:^|\s)(?:no|not|nobody|none|never|neither|nor|nothing|without)(?:\s|$)/;

/** How close a governing phrase must sit to the reference it governs. */
const VERB_WINDOW = 40;

/**
 * Every governing phrase compiled into one alternation, plus a lookup table.
 *
 * Classification runs on every reference in the corpus, and testing a hundred
 * phrases one at a time made it the most expensive thing extraction did. The
 * alternation is sorted longest-first so that at any given position the regex
 * prefers `partially resolved` over `resolved`, matching the precedence the
 * per-phrase search had. Lookarounds rather than `\b`, because phrases contain
 * hyphens and `\b` does the wrong thing around them.
 */
const VERB_LOOKUP: ReadonlyMap<string, Classification> = new Map(
  VERB_RULES.flatMap((rule) =>
    rule.phrases.map((phrase) => [phrase, { kind: rule.kind, inverted: rule.inverted }] as const),
  ),
);

const VERB_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...VERB_LOOKUP.keys()]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

/** Headings under which a link is bookkeeping rather than a commitment. */
const WEAK_SECTIONS: ReadonlySet<string> = new Set([
  'see also',
  'references',
  'reference',
  'related',
  'related work',
  'related decisions',
  'related documents',
  'links',
  'further reading',
  'prior art',
  'history',
  'changelog',
  'change log',
  'revision history',
  'bibliography',
  'sources',
  'appendix',
  'more information',
  'resources',
  'index',
]);

/** Headings whose bullets are obligations even without a checkbox. */
const OBLIGATION_SECTIONS: ReadonlySet<string> = new Set([
  'open questions',
  'open question',
  'unresolved questions',
  'unanswered questions',
  'questions',
  'open issues',
  'action items',
  'actions',
  'todo',
  'to do',
  'to-do',
  'todos',
  'next steps',
  'follow ups',
  'follow-ups',
  'followups',
  'follow up',
  'follow-up',
  'unresolved',
  'outstanding',
  'outstanding questions',
  'tasks',
  'task list',
  'work items',
  'remaining work',
  'decisions needed',
  'blockers',
  'parking lot',
  'future work',
  'deferred',
]);

/**
 * Prefixes that look like specification identifiers but never are.
 *
 * The corpus filter in `resolve.ts` is the real defence; this list only keeps
 * the obvious noise out of the candidate set.
 */
const NOT_A_FAMILY: ReadonlySet<string> = new Set([
  'v',
  'ver',
  'version',
  'p',
  'pp',
  'fig',
  'figure',
  'table',
  'tbl',
  'section',
  'sect',
  'sec',
  'step',
  'item',
  'no',
  'num',
  'line',
  'ln',
  'col',
  'port',
  'pr',
  'issue',
  'gh',
  'utf',
  'ascii',
  'sha',
  'md',
  'http',
  'https',
  'ipv',
  'tls',
  'ssl',
  'es',
  'ecma',
  'x',
  'h',
  'p99',
  'base',
  'sql',
  'ipv4',
  'ipv6',
  'arm',
  'x86',
  'win',
  'node',
  'python',
  'java',
  'go',
  'c',
  'cpp',
]);

const BARE_REF = /\b([A-Za-z][A-Za-z0-9]{0,14})[\s._-]?(\d{1,6})\b/g;

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExtractInput {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly text: string;
  /**
   * This file is a historical record: a log of what was decided, not a
   * decision. Matched against the caller's history patterns, because deciding
   * which files those are is a repository's business and not a guess this
   * layer could justify making. See ADR-0011.
   */
  readonly record?: boolean | undefined;
}

/**
 * Reads one file into graph fragments, one entry per specification in it.
 *
 * A file yields at least itself. It yields more when it is a register: a
 * heading that carries an identifier *and* declares a status is a specification
 * in its own right, with its own lifecycle, its own obligations and its own
 * relations. See ADR-0009.
 */
export function extractSpecifications(input: ExtractInput): ExtractedDocument[] {
  const first = extractDocument(input);
  return first === null ? [] : [first, ...(first.subSpecifications as ExtractedDocument[])];
}

/** Reads a file's own specification. Returns `null` when it opts out. */
/** The one character that makes a text file read as binary to other tools. */
const NUL = '\u0000';

export function extractDocument(input: ExtractInput): ExtractedDocument | null {
  const scanned = scanMarkdown(input.text);
  const directives = parseDirectives(scanned.comments);
  if (directives.some((d) => d.name === 'spec-ignore')) return null;

  const index = scanned.index;
  const file = input.path;
  const problems: ParseProblem[] = [];
  const at = (start: number, end: number): SourceRef => refOf(file, index, start, end);

  const nul = input.text.indexOf(NUL);
  if (nul !== -1) {
    // Not a finding. Nothing about the graph is wrong, and the text parsed - a
    // NUL is whitespace to every rule here. It is a problem with the *input*,
    // which is what a ParseProblem is for, and it is worth one line because
    // spec-graph is likely the only tool that got this far: grep, diff and
    // every review interface read the file as binary and show nothing at all.
    //
    // The cause is almost always an encoding, not a keystroke. UTF-16 read as
    // UTF-8 puts a NUL between every character, and the document that produces
    // looks plausible in some editors and is mojibake everywhere else.
    problems.push({
      message: `contains a NUL byte, so grep, diff and review tooling read this file as binary - check whether it was saved as UTF-16`,
      at: at(nul, nul + 1),
    });
  }

  for (const directive of directives) {
    for (const unknown of directive.unknownAttributes) {
      problems.push({
        message: `unknown attribute "${unknown}" on @${directive.name}`,
        at: at(directive.start, directive.end),
      });
    }
  }

  const entries = scanned.frontMatter ? parseFrontMatter(scanned.frontMatter.raw, scanned.frontMatter.start) : [];
  const byKey = new Map<string, YamlEntry>();
  for (const entry of entries) byKey.set(entry.key, entry);
  const inherited = inheritableFrontMatter(entries);

  const h1 = scanned.headings.find((h) => h.level === 1) ?? null;
  const frontMatterId = firstValue(byKey, ID_KEYS) ?? null;

  const identityOf = (declaredId: string | null, directive: Directive | null): DocumentIdentity =>
    identify({
      path: input.path,
      declaredId,
      declaredAliases: [
        ...(directive ? attrList(directive, 'aliases') : []),
        ...valuesOf(byKey.get('aliases')),
        ...valuesOf(byKey.get('alias')),
      ],
      heading: h1?.text ?? null,
    });

  // A `@spec-node` written inside a register's section belongs to that section,
  // not to the file. Finding the file's own therefore needs the regions, and
  // finding the regions needs the file's identity - so the identity is settled
  // provisionally first, then again once the file's own directive is known.
  const provisional = identityOf(frontMatterId, null);
  const provisionalRegions = findSpecificationRegions(scanned, directives, provisional.id);
  const nodeDirective =
    directives.find(
      (directive) =>
        directive.name === 'spec-node' &&
        !provisionalRegions.some(
          (region) =>
            (region.heading !== null || region.row !== null) &&
            directive.start >= region.start &&
            directive.end <= region.end,
        ),
    ) ?? null;

  const declaredId = (nodeDirective ? attr(nodeDirective, 'id')?.value : null) ?? frontMatterId;
  const identity = declaredId === frontMatterId && nodeDirective === null
    ? provisional
    : identityOf(declaredId, nodeDirective);

  const status = readStatus(scanned, byKey, nodeDirective, index, file);
  const pathPhase = phaseFromPath(input.path);
  // A record is a categorical statement about what the file *is*, made by
  // configuration or by an explicit directive, so it outranks a status word
  // that happened to be written inside it.
  const record = input.record === true || directives.some((directive) => directive.name === 'spec-history');
  const phase: Phase = record ? 'record' : status.phase !== 'unknown' ? status.phase : pathPhase;

  const title =
    (nodeDirective ? attr(nodeDirective, 'title')?.value : null) ??
    asString(byKey.get('title')) ??
    h1?.text ??
    identity.id;

  const document: DocumentNode = {
    id: identity.id,
    kind: 'document',
    title,
    at: at(0, Math.min(scanned.text.length, index.lineEnd(1))),
    path: input.path,
    aliases: identity.aliases,
    phase,
    rawStatus: status.raw,
    statusAt: status.at,
    frontMatter: toRecord(entries),
  };

  // A register's sections are specifications too. The file is always the first
  // region, so a one-decision file behaves exactly as it did before.
  const regions =
    identity.id === provisional.id ? provisionalRegions : findSpecificationRegions(scanned, directives, identity.id);
  // Every region but the first: a heading section, or a row of a register kept
  // as a table.
  const subSpecifications = regions
    .filter((region) => region.heading !== null || region.row !== null)
    .map((region) =>
      buildRegion({
        region,
        containerId: identity.id,
        input,
        scanned,
        directives,
        index,
        file,
        pathPhase,
        record,
        inherited,
      }),
    );

  const ownerAt = (offset: number): string => {
    const region = regionAt(regions, offset);
    if (region === null) return identity.id;
    const owner = subSpecifications.find((spec) => spec.region === region);
    return owner?.document.id ?? identity.id;
  };

  const allItems = extractItems({ scanned, directives, ownerAt, file, index });
  const documentAt = (offset: number): DocumentNode => {
    const id = ownerAt(offset);
    if (id === identity.id) return document;
    return subSpecifications.find((spec) => spec.document.id === id)?.document ?? document;
  };

  const allReferences = extractReferences({
    scanned,
    directives,
    document,
    documentAt,
    items: allItems,
    byKey,
    status,
    claimed: regions.flatMap((region) => [...region.claimed]),
    file,
    index,
  });

  // Hand each region the items and references that fall inside it.
  const ownItems = allItems.filter((item) => item.document === identity.id);
  const ownReferences = allReferences.filter((reference) => belongsTo(reference, identity.id, allItems));
  const misreadKeys = misreadRelationKeys(byKey, identity.id, at);
  const anchors = new Set<string>(scanned.headings.map((h) => h.slug));

  const filled = subSpecifications.map((spec) => ({
    ...spec.extracted,
    items: allItems.filter((item) => item.document === spec.document.id),
    references: [
      // Column-declared relations first: they are typed by the header rather
      // than guessed from prose.
      ...spec.extracted.references,
      ...allReferences.filter((reference) => belongsTo(reference, spec.document.id, allItems)),
    ],
  }));

  return {
    document,
    items: ownItems,
    references: ownReferences,
    problems,
    misreadKeys,
    anchors,
    identity,
    scanned,
    subSpecifications: filled,
    containerId: null,
  };
}

/** True when a reference was written on a document or on one of its items. */
function belongsTo(reference: ReferenceCandidate, documentId: string, items: readonly ItemNode[]): boolean {
  if (reference.from === documentId) return true;
  const owner = items.find((item) => item.id === reference.from);
  return owner?.document === documentId;
}

interface RegionInput {
  readonly region: SpecificationRegion;
  readonly containerId: string;
  readonly input: ExtractInput;
  readonly scanned: ScannedDocument;
  readonly directives: readonly Directive[];
  readonly index: LineIndex;
  readonly file: string;
  readonly pathPhase: Phase;
  /** The whole file is a historical record, so every part of it is one too. */
  readonly record: boolean;
  /** The file's front matter, minus the keys a region must answer itself. */
  readonly inherited: Readonly<Record<string, string | readonly string[]>>;
}

interface BuiltRegion {
  readonly region: SpecificationRegion;
  readonly document: DocumentNode;
  readonly extracted: ExtractedDocument;
}

/**
 * Turns one region into a specification.
 *
 * It produces exactly the `DocumentNode` a whole file produces, which is the
 * reason every rule, query and reporter works on registers without knowing they
 * exist. The only deliberate differences: the node is anchored at its heading
 * rather than at line one, it carries the file's front matter rather than front
 * matter of its own, and it does not claim the file's path as an alias - the
 * file already does, and two nodes answering to one path would make every link
 * to that file ambiguous.
 */
function buildRegion(context: RegionInput): BuiltRegion {
  const { region, input, scanned, index, file, pathPhase, record, inherited } = context;
  const at = (start: number, end: number): SourceRef => refOf(file, index, start, end);

  const identity = identify({
    path: input.path,
    declaredId: region.declaredId,
    declaredAliases: region.directive ? attrList(region.directive, 'aliases') : [],
    heading: region.title,
    includePathAliases: false,
  });

  const declaredStatus = region.directive ? attr(region.directive, 'status') : null;
  const rawStatus = declaredStatus?.value ?? region.status?.text ?? null;
  const statusAt = declaredStatus
    ? at(declaredStatus.start, declaredStatus.end)
    : region.status
      ? at(region.status.start, region.status.end)
      : null;
  const declaredPhase = phaseOf(rawStatus);

  const document: DocumentNode = {
    id: identity.id,
    kind: 'document',
    title: (region.directive ? attr(region.directive, 'title')?.value : null) ?? region.title ?? identity.id,
    // Anchored at its heading, or at the row when the register is a table.
    at: at(region.start, Math.min(region.end, region.heading?.end ?? region.row?.end ?? region.end)),
    path: input.path,
    aliases: identity.aliases,
    // A section of a journal is part of the journal, whatever status word it
    // wrote for itself. Being a record is a statement about the file made from
    // outside it, and it does not stop at a heading.
    phase: record ? 'record' : declaredPhase !== 'unknown' ? declaredPhase : pathPhase,
    rawStatus,
    statusAt,
    frontMatter: inherited,
  };

  const anchors = new Set<string>(
    scanned.headings.filter((h) => h.start >= region.start && h.start < region.end).map((h) => h.slug),
  );

  // Relations a table declares by column, typed by the header the author wrote.
  const references: ReferenceCandidate[] = region.relations.map((relation) => ({
    kind: relation.kind,
    from: document.id,
    target: relation.target,
    origin: 'front-matter' as const,
    declaredAt: at(relation.start, relation.end),
    raw: `${relation.column}: ${relation.target}`,
    inverted: relation.inverted,
    opportunistic: false,
  }));

  return {
    region,
    document,
    extracted: {
      document,
      items: [],
      references,
      problems: [],
      // The file has already reported anything misread at the top of it, and
      // there is one file however many regions it holds.
      misreadKeys: [],
      anchors,
      identity,
      scanned,
      subSpecifications: [],
      containerId: context.containerId,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

interface StatusReading {
  readonly raw: string | null;
  readonly at: SourceRef | null;
  readonly phase: Phase;
}

/**
 * Finds the document status.
 *
 * Looks in the three places teams actually put it, in descending order of how
 * deliberate each is: a directive, a front-matter field, then the body of a
 * `## Status` section. A repository using none of them still gets a phase from
 * its directory layout, which is handled by the caller.
 */
function readStatus(
  scanned: ScannedDocument,
  byKey: ReadonlyMap<string, YamlEntry>,
  nodeDirective: Directive | null,
  index: LineIndex,
  file: string,
): StatusReading {
  if (nodeDirective) {
    const declared = attr(nodeDirective, 'status');
    if (declared) {
      return {
        raw: declared.value,
        at: refOf(file, index, declared.start, declared.end),
        phase: phaseOf(declared.value),
      };
    }
  }

  for (const key of STATUS_KEYS) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const raw = typeof entry.value === 'string' ? entry.value : entry.value.join(', ');
    if (raw.trim().length === 0) continue;
    return {
      raw,
      at: refOf(file, index, entry.valueStart, entry.end),
      phase: phaseOf(raw),
    };
  }

  const heading = scanned.headings.find((h) => isStatusHeading(h.text));
  if (heading) {
    const body = statusSectionBody(scanned, heading.line);
    if (body) {
      return {
        raw: body.text,
        at: refOf(file, index, body.start, body.end),
        phase: phaseOf(body.text),
      };
    }
  }

  return { raw: null, at: null, phase: 'unknown' };
}

/** The first non-blank line under a `## Status` heading. */
function statusSectionBody(
  scanned: ScannedDocument,
  headingLine: number,
): { text: string; start: number; end: number } | null {
  for (const line of scanned.lines) {
    if (line.line <= headingLine) continue;
    if (line.blank) continue;
    if (line.code) return null;
    const trimmed = line.content.trim();
    // A heading immediately after means the section is empty.
    if (trimmed.startsWith('#')) return null;
    const offset = line.contentStart + line.content.indexOf(trimmed);
    // Bullet lists under Status are a status history; take the first entry.
    const cleaned = trimmed.replace(/^[-*+]\s+/, '');
    const start = offset + (trimmed.length - cleaned.length);
    return { text: cleaned, start, end: start + cleaned.length };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

interface ItemContext {
  readonly scanned: ScannedDocument;
  readonly directives: readonly Directive[];
  /** The specification that owns an offset, which in a register is a section. */
  readonly ownerAt: (offset: number) => string;
  readonly file: string;
  readonly index: LineIndex;
}

function extractItems(context: ItemContext): ItemNode[] {
  const { scanned, directives, ownerAt, file, index } = context;
  const out: ItemNode[] = [];
  const ordinals = new Map<string, number>();

  for (const item of scanned.listItems) {
    const section = sectionPathAt(scanned, item.start);
    const inObligationSection = section.some((heading) => OBLIGATION_SECTIONS.has(normaliseHeading(heading)));
    const directive = directiveFor(directives, 'spec-item', { start: item.start, end: item.end }, 200);

    if (!isObligation(item, inObligationSection, directive)) continue;

    const documentId = ownerAt(item.start);
    const slug = section.length > 0 ? slugify(section[section.length - 1] as string) : 'item';
    // Ordinals count within a specification, so two decisions in one register
    // each get their own `#open-questions.1` rather than sharing a sequence.
    const key = `${documentId}#${slug}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);

    const declaredId = directive ? attr(directive, 'id')?.value : null;
    const id = `${documentId}#${declaredId ?? `${slug}.${ordinal}`}`;

    const state = resolveItemState({
      file,
      index,
      item,
      section,
      directive,
      inObligationSection,
    });

    out.push({
      id,
      kind: 'item',
      title: (directive ? attr(directive, 'title')?.value : null) ?? summarise(item.firstLine),
      at: refOf(file, index, item.start, item.end),
      document: documentId,
      section,
      text: summarise(item.firstLine),
      body: item.body,
      disposition: state.disposition,
      openness: state.openness,
      evidence: state.evidence,
      conflicts: state.conflicts,
    });
  }

  return out;
}

/**
 * Decides whether a bullet is an obligation.
 *
 * A checkbox or an explicit directive always makes one. Otherwise only
 * top-level bullets under a heading like "Open Questions" count: promoting
 * every bullet in a specification would bury the real obligations under the
 * document's own prose.
 */
function isObligation(item: ListItem, inObligationSection: boolean, directive: Directive | null): boolean {
  if (directive !== null) return true;
  if (item.checkbox !== null) return true;
  return inObligationSection && item.depth === 0;
}

/** The heading path enclosing an offset, outermost first. */
function sectionPathAt(scanned: ScannedDocument, offset: number): string[] {
  const path: { level: number; text: string }[] = [];
  for (const heading of scanned.headings) {
    if (heading.start > offset) break;
    while (path.length > 0 && (path[path.length - 1] as { level: number }).level >= heading.level) path.pop();
    path.push({ level: heading.level, text: heading.text });
  }
  return path.map((entry) => entry.text);
}

/**
 * Memoised because it is called for every heading above every reference and
 * every item, and a corpus has only a handful of distinct headings - `Context`,
 * `Decision`, `Open Questions`, `See also` - repeated thousands of times.
 */
const headingCache = new Map<string, string>();

function normaliseHeading(text: string): string {
  const cached = headingCache.get(text);
  if (cached !== undefined) return cached;
  const normalised = text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Bounded so a pathological corpus of unique headings cannot grow it forever.
  if (headingCache.size < 4096) headingCache.set(text, normalised);
  return normalised;
}

/**
 * One-line form of an item for reports.
 *
 * Link syntax is flattened to its label. A finding that quotes the obligation
 * back at the reader should read like the sentence they wrote, not like the
 * Markdown source of it.
 */
function summarise(text: string): string {
  const flat = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // `[[target|display]]` keeps the display half: that is the text a reader
    // of the rendered document actually sees.
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`;
}

/* -------------------------------------------------------------------------- */
/* References                                                                 */
/* -------------------------------------------------------------------------- */

interface ReferenceContext {
  readonly scanned: ScannedDocument;
  readonly directives: readonly Directive[];
  readonly document: DocumentNode;
  /** The specification that owns an offset, for a reference outside any item. */
  readonly documentAt: (offset: number) => DocumentNode;
  readonly items: readonly ItemNode[];
  readonly byKey: ReadonlyMap<string, YamlEntry>;
  readonly status: StatusReading;
  /** Cell ranges already typed by a table column header. */
  readonly claimed: readonly { start: number; end: number }[];
  readonly file: string;
  readonly index: LineIndex;
}

/** True when an offset falls in a cell a column header already accounted for. */
function isClaimed(claimed: readonly { start: number; end: number }[], offset: number): boolean {
  return claimed.some((range) => offset >= range.start && offset < range.end);
}

function extractReferences(context: ReferenceContext): ReferenceCandidate[] {
  const { scanned, directives, document, documentAt, items, byKey, status, claimed, file, index } = context;
  const out: ReferenceCandidate[] = [];
  const at = (start: number, end: number): SourceRef => refOf(file, index, start, end);

  // Front matter, walked in the order it was written rather than in the order
  // the vocabulary happens to be listed: a key the table does not know still has
  // to be looked at, and only the document knows which those are.
  for (const [key, entry] of byKey) {
    const relation = RELATION_INDEX.get(foldRelationKey(key));
    if (!relation) continue;
    for (const value of valuesOf(entry)) {
      const target = cleanTarget(value);
      if (target.length === 0) continue;
      out.push({
        kind: relation.kind,
        from: document.id,
        target,
        origin: 'front-matter',
        declaredAt: at(entry.valueStart, entry.end),
        raw: `${key}: ${value}`,
        inverted: relation.inverted,
        opportunistic: false,
      });
    }
  }

  // `status: Superseded by ADR-0009` is the most common supersession record of
  // all, and it never appears as a field of its own.
  if (status.raw && status.at) {
    for (const target of supersessionTargetsIn(status.raw)) {
      const cleaned = cleanTarget(target);
      if (cleaned.length === 0) continue;
      out.push({
        kind: 'supersedes',
        from: document.id,
        target: cleaned,
        origin: 'front-matter',
        declaredAt: status.at,
        raw: status.raw,
        inverted: true,
        opportunistic: true,
      });
    }
  }

  // Explicit edge directives.
  for (const directive of directives) {
    if (directive.name !== 'spec-edge') continue;
    const kind = attr(directive, 'kind')?.value as EdgeKind | undefined;
    const to = attr(directive, 'to');
    const from = attr(directive, 'from');
    if (!kind) continue;
    const owner = ownerOf(items, directive.start) ?? documentAt(directive.start).id;
    if (to) {
      out.push({
        kind,
        from: owner,
        target: to.value,
        origin: 'directive',
        declaredAt: at(to.start, to.end),
        raw: `@spec-edge kind="${kind}" to="${to.value}"`,
        inverted: false,
        opportunistic: false,
      });
    }
    if (from) {
      out.push({
        kind,
        from: owner,
        target: from.value,
        origin: 'directive',
        declaredAt: at(from.start, from.end),
        raw: `@spec-edge kind="${kind}" from="${from.value}"`,
        inverted: true,
        opportunistic: false,
      });
    }
  }

  // Prose links. A cell whose meaning a column header already gave is skipped,
  // so `| ADR-0002 | ... | [ADR-0001](0001.md) |` yields one typed edge rather
  // than a typed edge and a neutral citation beside it.
  const linked = new Set<string>();
  for (const link of scanned.links) {
    if (link.form === 'definition') continue;
    if (isClaimed(claimed, link.start)) continue;
    const target = cleanTarget(link.target);
    if (target.length === 0) continue;
    if (isExternal(target)) continue;

    const owner = ownerOf(items, link.start) ?? documentAt(link.start).id;
    const section = sectionPathAt(scanned, link.start);
    const classified = classifyReference(scanned.masked, link.start, link.end, section);

    linked.add(normaliseRef(stripAnchor(target)));
    out.push({
      kind: classified.kind,
      from: owner,
      target,
      origin: 'link',
      declaredAt: at(link.targetStart, link.targetStart + link.target.length),
      raw: renderLink(link),
      inverted: classified.inverted,
      opportunistic: false,
    });
  }

  // Bare identifiers in prose. Everything already covered by a link is skipped
  // so a citation written as `[ADR-7](0007.md)` is not counted twice.
  for (const bare of findBareReferences(scanned)) {
    const key = normaliseRef(bare.text);
    if (linked.has(key)) continue;
    if (isClaimed(claimed, bare.start)) continue;
    const owner = ownerOf(items, bare.start) ?? documentAt(bare.start).id;
    const section = sectionPathAt(scanned, bare.start);
    const classified = classifyReference(scanned.masked, bare.start, bare.end, section);
    out.push({
      kind: classified.kind,
      from: owner,
      target: bare.text,
      origin: 'text',
      declaredAt: at(bare.start, bare.end),
      raw: bare.text,
      inverted: classified.inverted,
      opportunistic: true,
    });
  }

  return withoutOverlaps(out);
}

/**
 * Collapses candidates that describe the same written citation.
 *
 * `Superseded by ADR-0009` in a status section is read twice: the status
 * reader reports the whole line, and prose scanning reports the identifier
 * inside it. One written citation is one reference - so when the target
 * resolves it must not become two edges, and when it does not it must not
 * become two findings on one line a reader can only fix once.
 *
 * The narrower span wins, because it points at the text that has to change.
 *
 * Only overlapping spans collapse. Two sentences citing the same missing
 * document are two citations, and silently reporting one of them would leave
 * the other to be discovered on the next run.
 */
function withoutOverlaps(candidates: readonly ReferenceCandidate[]): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = [];
  for (const candidate of candidates) {
    const index = out.findIndex(
      (other) =>
        other.kind === candidate.kind &&
        other.from === candidate.from &&
        other.inverted === candidate.inverted &&
        normaliseRef(other.target) === normaliseRef(candidate.target) &&
        overlapping(other.declaredAt, candidate.declaredAt),
    );
    if (index === -1) {
      out.push(candidate);
      continue;
    }
    const held = out[index] as ReferenceCandidate;
    // The status reader runs before prose scanning, so today the wider span is
    // always the one already held and this comparison always replaces it. It is
    // written as a comparison rather than an unconditional swap because which
    // reader runs first is not a property worth depending on, and a mutant that
    // makes it unconditional is equivalent only by that accident.
    if (width(candidate.declaredAt) < width(held.declaredAt)) out[index] = candidate;
  }
  return out;
}

const width = (ref: SourceRef): number => ref.span.end.offset - ref.span.start.offset;

/**
 * Whether two spans cover any of the same text.
 *
 * Offsets alone, with no file comparison: every candidate here was built from
 * one scan of one file, so there is no second file for them to be offsets into.
 */
function overlapping(a: SourceRef, b: SourceRef): boolean {
  return a.span.start.offset < b.span.end.offset && b.span.start.offset < a.span.end.offset;
}

/** The item whose block contains an offset, if any. */
function ownerOf(items: readonly ItemNode[], offset: number): string | null {
  let best: ItemNode | null = null;
  for (const item of items) {
    const span = item.at.span;
    if (offset < span.start.offset || offset >= span.end.offset) continue;
    // Innermost wins when items nest.
    if (best === null || span.start.offset > best.at.span.start.offset) best = item;
  }
  return best?.id ?? null;
}

export interface Classification {
  readonly kind: EdgeKind;
  readonly inverted: boolean;
}

/**
 * Decides what a reference means from the words around it.
 *
 * The nearest governing phrase within {@link VERB_WINDOW} characters wins, and
 * the search never crosses a sentence boundary. With nothing to go on, a
 * reference under a "See also" heading is bookkeeping and everything else is a
 * neutral citation.
 */
export function classifyReference(
  text: string,
  start: number,
  end: number,
  section: readonly string[],
): Classification {
  const before = sentenceBefore(text, start);

  // Left to right, so the last match within the window is the nearest one - and
  // the nearest governing phrase is the one that governs.
  let best: Classification | null = null;
  VERB_PATTERN.lastIndex = 0;
  for (let m = VERB_PATTERN.exec(before); m !== null; m = VERB_PATTERN.exec(before)) {
    const phrase = m[0] as string;
    const end = (m.index ?? 0) + phrase.length;
    const distance = before.length - end;
    if (distance > VERB_WINDOW) continue;
    // What sits between the phrase and the reference has to be connective. A
    // negation in there reverses the claim the phrase would otherwise make.
    if (NEGATION.test(before.slice(end))) continue;
    const rule = VERB_LOOKUP.get(phrase);
    if (rule) best = rule;
  }

  if (best) return best;

  // "[ADR-0009] supersedes this decision": the reference is the subject, so the
  // relation runs the other way.
  const after = sentenceAfter(text, end);
  for (const rule of VERB_RULES) {
    if (rule.inverted) continue;
    for (const phrase of rule.phrases) {
      if (!after.startsWith(phrase)) continue;
      if (rule.kind === 'assumes' || rule.kind === 'depends-on') continue;
      return { kind: rule.kind, inverted: true };
    }
  }

  const innermost = section.length > 0 ? normaliseHeading(section[section.length - 1] as string) : '';
  if (WEAK_SECTIONS.has(innermost)) return { kind: 'relates-to', inverted: false };
  for (const heading of section) {
    if (WEAK_SECTIONS.has(normaliseHeading(heading))) return { kind: 'relates-to', inverted: false };
  }

  return { kind: 'references', inverted: false };
}

/** A sentence end, a blank line, or the start of a new block-level item. */
/**
 * A table cell edge ends a statement too.
 *
 * The pipe matters more than it looks. A table row is a list of independent
 * fields, and without it the look-behind window reaches back across the row
 * boundary into the previous row's prose. An index of archived documents whose
 * last column ended "...before assuming the drift was fixed" turned every
 * following row's link into an `assumes` edge, and so turned every archived
 * document it listed into a stale premise.
 */
const STATEMENT_BREAK = /[.?!;]\s|\n\s*\n|\n\s*[-*+>#]|\|/g;

/**
 * Lower-cased, whitespace-collapsed text back to the start of the statement.
 *
 * The search stops at the last boundary: a governing phrase in the *previous*
 * sentence does not govern this reference. "We deferred that to ADR-3. See also
 * [ADR-9]." must not read as a delegation to ADR-9.
 */
function sentenceBefore(text: string, start: number): string {
  const window = text.slice(Math.max(0, start - 160), start);
  let cut = 0;
  STATEMENT_BREAK.lastIndex = 0;
  for (let m = STATEMENT_BREAK.exec(window); m !== null; m = STATEMENT_BREAK.exec(window)) {
    cut = (m.index ?? 0) + (m[0] as string).length;
  }
  return window
    .slice(cut)
    .toLowerCase()
    .replace(/[`*_~"'()\[\],]/g, ' ')
    .replace(/\s+/g, ' ');
}

function sentenceAfter(text: string, end: number): string {
  const window = text.slice(end, Math.min(text.length, end + 80));
  const stop = /[.?!;\n|]/.exec(window);
  const cut = stop ? window.slice(0, stop.index) : window;
  return cut.toLowerCase().replace(/[`*_~"'()\[\],]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface BareReference {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Finds identifiers written as plain prose, such as "as decided in ADR-0007".
 *
 * Link constructs are blanked first. Without that, `[ADR-7](https://x/adr-7)`
 * would yield three references to the same thing - one real and two harvested
 * out of a URL - which is precisely the mis-match that makes hand-rolled regex
 * checks untrustworthy.
 */
function findBareReferences(scanned: ScannedDocument): BareReference[] {
  // Slice-based for the same reason as the scanner's masking: this runs over
  // every document, and a per-character array is the wrong shape for the job.
  const source = scanned.masked;
  let text = '';
  let cursor = 0;
  for (const link of scanned.links) {
    const start = Math.max(link.start, cursor);
    const end = Math.min(link.end, source.length);
    if (end <= start) continue;
    text += source.slice(cursor, start);
    text += source.slice(start, end).replace(/[^\n\r]/g, ' ');
    cursor = end;
  }
  text += source.slice(cursor);

  const out: BareReference[] = [];
  BARE_REF.lastIndex = 0;
  for (let m = BARE_REF.exec(text); m !== null; m = BARE_REF.exec(text)) {
    const prefix = (m[1] as string).toLowerCase();
    if (NOT_A_FAMILY.has(prefix)) continue;
    if (prefix.length < 2) continue;
    const start = m.index ?? 0;
    // A token glued to a path separator or an extension is not a citation.
    const before = text[start - 1] ?? ' ';
    const after = text[start + (m[0] as string).length] ?? ' ';
    if (before === '/' || before === '.' || after === '/') continue;
    out.push({ text: m[0] as string, start, end: start + (m[0] as string).length });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function firstValue(byKey: ReadonlyMap<string, YamlEntry>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const entry = byKey.get(key);
    if (!entry) continue;
    const value = asString(entry);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

function asString(entry: YamlEntry | undefined): string | null {
  if (!entry) return null;
  if (typeof entry.value === 'string') return entry.value.trim().length > 0 ? entry.value.trim() : null;
  return entry.value.length > 0 ? (entry.value[0] as string) : null;
}

/** Strips Markdown decoration a target may still be wearing. */
function cleanTarget(value: string): string {
  return value
    .trim()
    .replace(/^[`'"<(\[]+/, '')
    .replace(/[`'">)\]]+$/, '')
    .replace(/[.,;]+$/, '')
    .trim();
}

function stripAnchor(target: string): string {
  const hash = target.indexOf('#');
  return hash <= 0 ? target : target.slice(0, hash);
}

function renderLink(link: Link): string {
  switch (link.form) {
    case 'wiki':
      return `[[${link.target}]]`;
    case 'autolink':
      return `<${link.target}>`;
    case 'reference':
    case 'shortcut':
      return `[${link.text}][${link.label ?? ''}]`;
    default:
      return `[${link.text}](${link.target})`;
  }
}

/** Exposed for tests and for callers that classify their own sections. */
export { OBLIGATION_SECTIONS, sectionPathAt, WEAK_SECTIONS };
