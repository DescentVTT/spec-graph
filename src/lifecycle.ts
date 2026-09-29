/**
 * Status vocabulary normalisation.
 *
 * Every specification ecosystem invented its own status words, and no two agree.
 * MADR says `accepted`; Kubernetes KEPs say `implementable`; Rust RFCs say
 * `merged`; a hundred internal wikis say `Live`, `Signed off`, or `DONE ✅`.
 *
 * spec-graph refuses to care. What it needs from a status is one bit - *can this
 * document still absorb an obligation?* - and that bit is recoverable from all
 * of those vocabularies at once. The tables below are the only place in the
 * codebase that knows any ecosystem-specific word, which is what keeps the
 * engine domain-agnostic: supporting a new convention is a table entry, never a
 * rule change.
 */

import type { Phase, Receptivity } from './types.js';

/**
 * Recognised status words, most terminal first.
 *
 * Order matters. A status of "accepted, superseded by ADR-0009" is retired, not
 * active: retirement is terminal, so a retirement word anywhere in the string
 * wins over anything else in it.
 *
 * A hyphenated term is found anywhere in the status, so a row needs no term
 * another in it already finds: `replaced` reads "replaced by", `review` reads
 * "in review" and "under review", and `in-progress` reads "work in progress".
 *
 * A Chinese term is the English word it translates, in Traditional and in
 * Simplified characters, and sits in that word's row. Chinese writes no space
 * between words, so a term in Han characters is found anywhere in the status,
 * as a hyphenated one is, and the same economy applies: `棄用` reads `已棄用`,
 * and `待審` reads `待審核`. The superseded forms are rules of their own, in
 * {@link supersededInChinese}.
 */
const VOCABULARY: readonly (readonly [Phase, readonly string[]])[] = [
  [
    'retired',
    [
      // Read as itself, though it starts with a negation. The active row's
      // `採納` inside it is not read, because that negation stands before it.
      '不採納',
      '不采纳',
      '棄用',
      '弃用',
      '廢棄',
      '废弃',
      '已停用',
      '已過時',
      '已过时',
      '否決',
      '否决',
      '已拒絕',
      '已拒绝',
      '撤回',
      '作廢',
      '作废',
      '延後',
      '延后',
      '暫緩',
      '暂缓',
      '擱置',
      '搁置',
      'superseded',
      // Misspelled in the wild often enough that omitting it would silently
      // mis-classify real documents as active.
      'superceded',
      'supersedes-by',
      'replaced',
      'deprecated',
      'obsolete',
      'obsoleted',
      'retired',
      'rejected',
      'declined',
      'withdrawn',
      'abandoned',
      'cancelled',
      'canceled',
      'dropped',
      'revoked',
      'reverted',
      'moved',
      'historical',
      'defunct',
      'inactive',
      'dead',
      'void',
      'closed',
      'postponed',
      'deferred',
      'not-planned',
      'wontfix',
    ],
  ],
  [
    // A finished round of work kept as it was left: spec-brief archives a brief
    // by writing this word and moving the file. Every spec-* tool reads it as a
    // record rather than as a retired decision - depending on one is normal,
    // its unticked boxes were never going to be ticked, and its links still
    // have to go somewhere (ADR-0011). After retirement, so a brief written
    // `archived, superseded by B-0007` is still retired.
    'record',
    ['archived', 'archive', '封存', '歸檔', '归档'],
  ],
  [
    'frozen',
    [
      'final',
      'finalised',
      'finalized',
      'frozen',
      'locked',
      'ratified',
      'immutable',
      'sealed',
      'standard',
      'published',
      '定案',
      '已凍結',
      '已冻结',
    ],
  ],
  // Ahead of `active`, whose `accepted` it contains: read after it, as the
  // rest of the draft row is, `provisionally accepted` would be active. `暫定`
  // is the same word, and `暫定接受` holds the active row's `接受`.
  ['draft', ['provisionally-accepted', '暫定', '暂定']],
  [
    'active',
    [
      '接受',
      '採納',
      '采纳',
      '核准',
      '批准',
      '生效',
      '已實施',
      '已实施',
      '已完成',
      'accepted',
      'active',
      'approved',
      'adopted',
      'agreed',
      'implementable',
      'implemented',
      'implementing',
      'current',
      'effective',
      'in-effect',
      'enforced',
      'stable',
      'merged',
      'released',
      'shipped',
      'live',
      'done',
      'complete',
      'completed',
      'signed-off',
      'committed',
    ],
  ],
  [
    'draft',
    [
      '草稿',
      '草案',
      '提議',
      '提议',
      '提案',
      '審查中',
      '审查中',
      '審核中',
      '审核中',
      '討論中',
      '讨论中',
      '待審',
      '待审',
      'draft',
      'drafting',
      'proposed',
      'proposal',
      'provisional',
      'prospective',
      'wip',
      'in-progress',
      'review',
      'reviewing',
      'discussion',
      'discussing',
      'pending',
      'idea',
      'exploratory',
      'candidate',
      'open',
      'new',
      'unreviewed',
      'rfc',
      'experimental',
      'alpha',
      'beta',
      'incubating',
    ],
  ],
];

/** Path segments that retire every document beneath them. */
const RETIRING_DIRECTORIES: ReadonlySet<string> = new Set([
  'archive',
  'archived',
  'attic',
  'deprecated',
  'graveyard',
  'historical',
  'obsolete',
  'rejected',
  'retired',
  'superseded',
  'superceded',
  'withdrawn',
]);

/** Front-matter keys that may carry a status, in order of preference. */
export const STATUS_KEYS: readonly string[] = ['status', 'state', 'stage', 'lifecycle', 'phase', 'adr-status'];

/** Heading names whose body declares the document status. */
const STATUS_HEADINGS: ReadonlySet<string> = new Set([
  'status',
  'state',
  'stage',
  'lifecycle',
  'current status',
  '狀態',
  '状态',
]);

/** A term written in Han characters, which is found anywhere in a status rather than as a word. */
const HAN = /\p{Script=Han}/u;

/**
 * What cancels a Han term written directly after it: `未接受`, `尚未核准` and
 * `不再生效` are not accepted, approved or in effect. `尚未` ends in `未`, so
 * it needs no entry of its own.
 */
const HAN_NEGATIONS: readonly string[] = ['不', '未', '非', '沒', '没', '無', '无', '勿', '不再'];

/**
 * `被 ADR-0003 取代`, and `被取代` with nothing between: superseded, in the
 * passive, with the successor between `被` and the verb. Thirty characters
 * leave room for a name or two and not for a clause, and the gap never runs
 * past the end of a sentence: `被團隊接受。取代 ADR-0002 的方案另議` is no
 * supersession of this document.
 */
const PASSIVE_SUPERSESSION = /被([^。；！？]{0,30}?)所?(?:取而代之|取代|替代)/gu;

/**
 * `已取代` said alone. Followed by a name - `已取代 ADR-0002`, `已取代舊方案`,
 * after spaces or a colon - it usually says what *this* document replaced, and
 * reading it either way would be a guess.
 */
const SUPERSEDED_ALONE = /已取代(?![\s:：]*[\p{L}\p{N}])/gu;

/**
 * Strips what decorates a status and keeps its punctuation: HTML, emphasis,
 * link syntax, emoji and dates. Lower-cased, since every term is.
 */
function undecorated(raw: string): string {
  // An underscore between two letters joins two words - `not_planned`,
  // `in_progress` - where one at either end of a word is emphasis. Stripped
  // with the emphasis, it ran the two words into one that is neither.
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, ' ')
    .replace(/[`*_~"'#]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .toLowerCase();
}

/**
 * Reduces a status string to lookup form.
 *
 * Strips Markdown emphasis, badge syntax, emoji and dates, so `**Accepted**`,
 * `` `accepted` ``, `Accepted ✅` and `Accepted (2026-03-01)` all land on the
 * same token.
 */
export function normaliseStatus(raw: string): string {
  return undecorated(raw)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether a negation stands directly before the offset. */
function negatedAt(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return HAN_NEGATIONS.some((negation) => before.endsWith(negation));
}

/** Whether a Han term occurs in the text with no negation directly before it. */
function hanTermIn(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (!negatedAt(text, at)) return true;
  }
  return false;
}

/** The text between `被` and the verb of every passive supersession not negated. */
function passiveSupersessions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PASSIVE_SUPERSESSION)) {
    if (!negatedAt(text, match.index)) out.push(match[1] as string);
  }
  return out;
}

/** Whether a status says it was superseded, in Chinese. */
function supersededInChinese(text: string): boolean {
  if (passiveSupersessions(text).length > 0) return true;
  for (const match of text.matchAll(SUPERSEDED_ALONE)) {
    if (!negatedAt(text, match.index)) return true;
  }
  return false;
}

/**
 * Maps a raw status string onto a lifecycle phase.
 *
 * Returns `unknown` rather than guessing when nothing matches: a document with
 * an unrecognised status is not evidence of anything, and inventing a phase for
 * it would produce exactly the confident-but-wrong findings this tool exists to
 * eliminate.
 */
export function phaseOf(raw: string | null | undefined): Phase {
  if (raw === null || raw === undefined) return 'unknown';
  const plain = undecorated(raw);
  // Retirement wins wherever it is written, so the superseded forms need no
  // place in the table's order.
  if (supersededInChinese(plain)) return 'retired';
  const text = plain.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = new Set(text.split(' '));
  const hyphenated = text.replace(/ /g, '-');

  for (const [phase, terms] of VOCABULARY) {
    for (const term of terms) {
      if (HAN.test(term)) {
        if (hanTermIn(plain, term)) return phase;
      } else if (term.includes('-')) {
        if (hyphenated.includes(term)) return phase;
      } else if (words.has(term)) {
        return phase;
      }
    }
  }
  return 'unknown';
}

/** Whether a document in this phase can take on a new open obligation. */
export function receptivityOf(phase: Phase): Receptivity {
  switch (phase) {
    case 'draft':
    case 'active':
      return 'receptive';
    case 'frozen':
    case 'retired':
    // A record was never asking for an obligation, so it cannot take one on.
    // Sealed for the same reason a retired document is, by a different route.
    case 'record':
      return 'sealed';
    case 'unknown':
      return 'unknown';
  }
}

/** True when the phase means the document no longer binds anybody. */
export function isRetired(phase: Phase): boolean {
  return phase === 'retired';
}

/** True when the heading names a section that declares the document status. */
export function isStatusHeading(text: string): boolean {
  return STATUS_HEADINGS.has(text.toLowerCase().replace(/[:：*_`]/g, '').trim());
}

/**
 * Infers retirement from where a file lives.
 *
 * Moving an ADR into `docs/adr/archive/` is the most common way a team retires a
 * decision without touching its front matter, and a graph that misses it will
 * happily let obligations be delegated into the archive.
 */
export function phaseFromPath(posixPath: string): Phase {
  const segments = posixPath.toLowerCase().split('/');
  // The file name itself is not a directory; a document called `archive`, with
  // or without an extension, is not retired.
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (RETIRING_DIRECTORIES.has(segments[i] as string)) return 'retired';
  }
  return 'unknown';
}

/**
 * Pulls a supersession target out of a status string.
 *
 * `Superseded by ADR-0009` is the single most common way a supersession is ever
 * recorded, and it is written in the status field rather than as a link. Reading
 * it here means the relation reaches the graph even in repositories that never
 * adopted an explicit field for it.
 *
 * In Chinese the successor stands between `被` and the verb: `已被 ADR-0003
 * 取代`. Left unread, a document that said so and one that said it supersedes
 * this one disagreed, and `unreciprocated-supersession` asked for a
 * `superseded-by` key the status had already given.
 */
export function supersessionTargetsIn(raw: string): string[] {
  const out: string[] = [];
  const plain = raw.replace(/[`*_]/g, '');
  // The tail runs to the end of the line, not of the string: a status that
  // wraps onto a second line still names its successor on the first.
  const pattern = /(?:super[sc]eded|replaced|obsoleted)\s*(?:by|with|through)?\s*[:\-–—]?\s*(.+)/i;
  const match = pattern.exec(plain);
  // A link inside the passive is read by its label, as a status is: its path
  // would run the name past the thirty characters the form allows.
  const tails = match ? [match[1] as string] : passiveSupersessions(plain.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
  for (const tail of tails) {
    for (const token of tail.split(/[,;、，；和及與与]|\band\b/)) {
      const cleaned = token
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[()<>"'（）]/g, ' ')
        .trim();
      if (cleaned.length > 0 && cleaned.length < 200) out.push(cleaned);
    }
  }
  return out;
}
