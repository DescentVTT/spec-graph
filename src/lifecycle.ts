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
 */
const VOCABULARY: readonly (readonly [Phase, readonly string[]])[] = [
  [
    'retired',
    [
      'superseded',
      // Misspelled in the wild often enough that omitting it would silently
      // mis-classify real documents as active.
      'superceded',
      'supersedes-by',
      'replaced',
      'replaced-by',
      'deprecated',
      'obsolete',
      'obsoleted',
      'retired',
      'archived',
      'archive',
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
    'frozen',
    ['final', 'finalised', 'finalized', 'frozen', 'locked', 'ratified', 'immutable', 'sealed', 'standard', 'published'],
  ],
  [
    'active',
    [
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
      'draft',
      'drafting',
      'proposed',
      'proposal',
      'provisional',
      'prospective',
      'wip',
      'work-in-progress',
      'in-progress',
      'review',
      'in-review',
      'under-review',
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
      'provisionally-accepted',
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
const STATUS_HEADINGS: ReadonlySet<string> = new Set(['status', 'state', 'stage', 'lifecycle', 'current status']);

/**
 * Reduces a status string to lookup form.
 *
 * Strips Markdown emphasis, badge syntax, emoji and dates, so `**Accepted**`,
 * `` `accepted` ``, `Accepted ✅` and `Accepted (2026-03-01)` all land on the
 * same token.
 */
export function normaliseStatus(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_~"'#]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
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
  const text = normaliseStatus(raw);
  if (text.length === 0) return 'unknown';
  const words = new Set(text.split(' '));
  const hyphenated = text.replace(/ /g, '-');

  for (const [phase, terms] of VOCABULARY) {
    for (const term of terms) {
      if (term.includes('-')) {
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
  return STATUS_HEADINGS.has(text.trim().toLowerCase().replace(/[:*_`]/g, '').trim());
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
  // The file name itself is not a directory; a document called `archive.md` is
  // not retired.
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
 */
export function supersessionTargetsIn(raw: string): string[] {
  const out: string[] = [];
  const pattern = /(?:superse[dc]ed|replaced|obsoleted)\s*(?:by|with|through)?\s*[:\-—]?\s*(.+)$/i;
  const match = pattern.exec(raw.replace(/[`*_]/g, ''));
  if (!match) return out;
  const tail = match[1] as string;
  for (const token of tail.split(/[,;]|\band\b/)) {
    const cleaned = token
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[()<>"']/g, ' ')
      .trim();
    if (cleaned.length > 0 && cleaned.length < 200) out.push(cleaned);
  }
  return out;
}
