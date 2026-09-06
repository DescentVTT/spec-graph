/**
 * Item state resolution.
 *
 * The premise of this module is that `- [ ]` and `- [x]` are the *least*
 * reliable statement a document makes about an obligation. Real specifications
 * record outcomes in prose, on a continuation line, days after the checkbox was
 * written and nobody went back to tick it:
 *
 * ```md
 * - [ ] Should the write path shard before the migration?
 *       **Resolved (2026-03):** no - one node holds three years of growth.
 * ```
 *
 * A grep for `- [ ]` calls that an open question and re-opens a settled debate.
 * A grep for `- [x]` misses it entirely. spec-graph reads both signals, lets the
 * more specific one win, and *reports the disagreement* rather than hiding it,
 * because a checkbox that contradicts its own body is itself a defect worth
 * knowing about.
 */

import type { Directive } from './directives.js';
import { attr } from './directives.js';
import type { ListItem } from './markdown.js';
import { refOf, type LineIndex } from './source.js';
import { OPENNESS_OF, type Disposition, type Openness, type SourceRef, type StateSignal } from './types.js';

/** Which signal wins when two disagree. Higher is more specific. */
const SIGNAL_PRIORITY: Readonly<Record<StateSignal['source'], number>> = {
  directive: 5,
  marker: 4,
  strikethrough: 3,
  checkbox: 2,
  section: 1,
  default: 0,
};

/**
 * Checkbox characters.
 *
 * `[ ]` and `[x]` are universal; the rest come from conventions that several
 * ecosystems share (`[~]` partial, `[-]` dropped, `[?]` question, `[/]` in
 * progress). Reading them costs nothing and refusing to would throw away the
 * one place a document states its nuance unambiguously.
 */
const CHECKBOX_STATE: Readonly<Record<string, Disposition>> = {
  ' ': 'unresolved',
  x: 'satisfied',
  X: 'satisfied',
  '+': 'satisfied',
  '~': 'narrowed',
  '/': 'narrowed',
  '-': 'rejected',
  '?': 'unresolved',
  '!': 'unresolved',
  '*': 'unresolved',
};

/**
 * Prose markers, by the state they announce.
 *
 * Matched only in the qualified forms real documents use - `**Resolved:**`,
 * `RESOLVED -`, `**Moot**` - never as bare words, so ordinary prose such as
 * "we resolved to keep the queue" does not close an item.
 */
const MARKERS: Readonly<Record<Disposition, readonly string[]>> = {
  satisfied: [
    'resolved',
    'answered',
    'decided',
    'settled',
    'done',
    'complete',
    'completed',
    'closed',
    'fixed',
    'shipped',
    'addressed',
    'implemented',
    'solved',
    'confirmed',
  ],
  narrowed: [
    'partially resolved',
    'partially answered',
    'partially done',
    'partly resolved',
    'narrowed',
    'narrowed to',
    'scoped down',
    'reduced scope',
    'reduced to',
    'partial',
    'in progress',
    'remaining',
    'split',
  ],
  delegated: [
    'delegated',
    'delegated to',
    'moved to',
    'tracked in',
    'tracked by',
    'handed off',
    'handed off to',
    'handed to',
    'deferred to',
    'follow up in',
    'follow-up in',
    'followup in',
    'continued in',
    'owned by',
  ],
  'accepted-debt': [
    'accepted debt',
    'accepted as debt',
    'accepted risk',
    'known limitation',
    'known issue',
    'known gap',
    'technical debt',
    'tech debt',
    'wontfix',
    "won't fix",
    'will not fix',
    'by design',
    'tolerated',
    'living with it',
  ],
  rejected: [
    'rejected',
    'declined',
    'dropped',
    'not doing',
    'will not do',
    'abandoned',
    'cancelled',
    'canceled',
    'withdrawn',
  ],
  obviated: [
    'no longer applicable',
    'no longer relevant',
    'no longer needed',
    'overtaken by events',
    'premise invalid',
    'obviated',
    'obsolete',
    'not applicable',
    'moot',
    'void',
    'n/a',
    'obe',
  ],
  unresolved: ['unresolved', 'still open', 'open question', 'tbd', 'undecided', 'reopened'],
};

/** Words accepted in a `state=` attribute, including friendly synonyms. */
const STATE_ALIASES: Readonly<Record<string, Disposition>> = {
  open: 'unresolved',
  unresolved: 'unresolved',
  todo: 'unresolved',
  narrowed: 'narrowed',
  partial: 'narrowed',
  delegated: 'delegated',
  satisfied: 'satisfied',
  resolved: 'satisfied',
  done: 'satisfied',
  closed: 'satisfied',
  'accepted-debt': 'accepted-debt',
  debt: 'accepted-debt',
  wontfix: 'accepted-debt',
  rejected: 'rejected',
  declined: 'rejected',
  obviated: 'obviated',
  moot: 'obviated',
};

const MARKER_PATTERN = buildMarkerPattern();

export interface StateInput {
  readonly file: string;
  readonly index: LineIndex;
  readonly item: ListItem;
  /** Heading path the item sits under. */
  readonly section: readonly string[];
  /** A `@spec-item` directive attached to the item, when there is one. */
  readonly directive: Directive | null;
  /** True when the item sits under a heading that declares obligations. */
  readonly inObligationSection: boolean;
}

export interface ResolvedState {
  readonly disposition: Disposition;
  readonly openness: Openness;
  readonly evidence: StateSignal;
  /** Signals that disagree with `evidence` about how open the item is. */
  readonly conflicts: readonly StateSignal[];
}

/** Collects every state signal on an item and decides between them. */
export function resolveItemState(input: StateInput): ResolvedState {
  const { file, index, item } = input;
  const signals: StateSignal[] = [];

  const at = (start: number, end: number): SourceRef => refOf(file, index, start, end);

  if (input.directive) {
    const declared = attr(input.directive, 'state');
    if (declared) {
      const mapped = STATE_ALIASES[declared.value.toLowerCase()];
      if (mapped) {
        signals.push({
          source: 'directive',
          disposition: mapped,
          raw: declared.value,
          at: at(declared.start, declared.end),
        });
      }
    }
  }

  // Markers are searched in the masked body: a fenced example nested under an
  // item must never be able to close it.
  for (const found of findMarkers(item.maskedBody)) {
    signals.push({
      source: 'marker',
      disposition: found.disposition,
      raw: found.raw,
      at: at(item.textStart + found.start, item.textStart + found.end),
    });
  }

  const struck = strikethroughOf(item.firstLine);
  if (struck) {
    signals.push({
      source: 'strikethrough',
      disposition: 'satisfied',
      raw: struck,
      at: at(item.textStart, item.textStart + item.firstLine.length),
    });
  }

  if (item.checkbox !== null && item.checkboxStart !== null) {
    const mapped = CHECKBOX_STATE[item.checkbox];
    if (mapped) {
      signals.push({
        source: 'checkbox',
        disposition: mapped,
        raw: `[${item.checkbox}]`,
        at: at(item.checkboxStart, item.checkboxStart + 3),
      });
    }
  }

  if (input.inObligationSection) {
    signals.push({
      source: 'section',
      disposition: 'unresolved',
      raw: input.section[input.section.length - 1] ?? '',
      at: at(item.start, item.end),
    });
  }

  if (signals.length === 0) {
    const fallback: StateSignal = {
      source: 'default',
      disposition: 'unresolved',
      raw: '',
      at: at(item.start, item.end),
    };
    return { disposition: 'unresolved', openness: 'open', evidence: fallback, conflicts: [] };
  }

  // The most specific signal wins; ties go to the one written last, which is
  // the one a reader of the document sees as the final word.
  let winner = signals[0] as StateSignal;
  for (const signal of signals) {
    const better = SIGNAL_PRIORITY[signal.source] - SIGNAL_PRIORITY[winner.source];
    if (better > 0 || (better === 0 && signal.at.span.start.offset > winner.at.span.start.offset)) {
      winner = signal;
    }
  }

  const openness = OPENNESS_OF[winner.disposition];
  // Only disagreement about *openness* is a conflict. A body that says
  // "Resolved" under a ticked checkbox agrees with it; one under an empty
  // checkbox does not, and that is worth a human looking at.
  const conflicts = signals.filter(
    (signal) => signal !== winner && signal.source !== 'section' && OPENNESS_OF[signal.disposition] !== openness,
  );

  return { disposition: winner.disposition, openness, evidence: winner, conflicts };
}

/* -------------------------------------------------------------------------- */
/* Marker matching                                                            */
/* -------------------------------------------------------------------------- */

interface MarkerHit {
  readonly disposition: Disposition;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

function buildMarkerPattern(): RegExp {
  const phrases = Object.values(MARKERS)
    .flat()
    // Longest first so `partially resolved` is not eaten by `resolved`.
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    // Allow the writer to hyphenate or space multi-word markers either way.
    .map((phrase) => phrase.replace(/\\?[ -]/g, '[ \\-]'));

  return new RegExp(
    // A marker only counts at the start of a statement: the start of the item,
    // a new line, after a sentence ends, or after an emphasis opener.
    String.raw`(?:^|\n|[.?!]\s+|[(\[])` +
      // Skip block-quote and list markers, but only when the marker character is
      // followed by whitespace. Without that guard the `*` of `**Resolved**`
      // reads as a bullet and the emphasis wrapper is lost.
      String.raw`(?:[ \t>•]|(?:[-*+]|\d{1,9}[.)])[ \t]+)*` +
      // Optional emphasis wrapper, remembered so `**Moot**` qualifies without a colon.
      String.raw`(\*{1,2}|_{1,2})?` +
      String.raw`\s*(${phrases.join('|')})` +
      String.raw`(\*{1,2}|_{1,2})?` +
      // An optional dated parenthetical: `Resolved (2026-03):`.
      String.raw`\s*(?:[(\[][^)\]\n]{0,60}[)\]])?` +
      // Optional, and validated in code below: an emphasised or shouted marker
      // stands on its own, a bare lower-case word never does.
      String.raw`\s*([:：]|[-–—]\s|\.|$|\n)?`,
    'gim',
  );
}

function findMarkers(body: string): MarkerHit[] {
  const out: MarkerHit[] = [];
  const dispositionOf = markerLookup();

  MARKER_PATTERN.lastIndex = 0;
  for (let m = MARKER_PATTERN.exec(body); m !== null; m = MARKER_PATTERN.exec(body)) {
    const phrase = m[2] as string;
    const emphasisOpen = m[1];
    const emphasisClose = m[3];
    const qualifier = (m[4] ?? '').trim();

    const emphasised = emphasisOpen !== undefined && emphasisClose !== undefined;
    const punctuated = qualifier === ':' || qualifier === '：' || qualifier.startsWith('-') || qualifier === '.';
    const shouted = phrase === phrase.toUpperCase() && /[A-Z]/.test(phrase);

    // Without one of these three the match is ordinary prose. "We resolved to
    // keep the queue" must not close an item.
    if (!emphasised && !punctuated && !shouted) continue;

    const disposition = dispositionOf.get(normalisePhrase(phrase));
    if (!disposition) continue;

    const start = (m.index ?? 0) + (m[0] as string).indexOf(phrase);
    out.push({ disposition, raw: phrase, start, end: start + phrase.length });

    // Overlapping alternatives would double-count; resume after this match.
    MARKER_PATTERN.lastIndex = start + phrase.length;
  }

  return out;
}

function markerLookup(): Map<string, Disposition> {
  const map = new Map<string, Disposition>();
  for (const [disposition, phrases] of Object.entries(MARKERS) as [Disposition, readonly string[]][]) {
    for (const phrase of phrases) map.set(normalisePhrase(phrase), disposition);
  }
  return map;
}

function normalisePhrase(phrase: string): string {
  return phrase.toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

/** Returns the struck text when the whole line is wrapped in `~~`. */
function strikethroughOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('~~') || !trimmed.endsWith('~~') || trimmed.length < 5) return null;
  const inner = trimmed.slice(2, -2);
  return inner.includes('~~') ? null : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Exposed for the query language, which lets users filter on these names. */
export const KNOWN_STATE_WORDS: readonly string[] = Object.keys(STATE_ALIASES);
