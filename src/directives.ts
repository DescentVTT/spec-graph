/**
 * Explicit annotations, written as HTML comments.
 *
 * Inference covers the overwhelming majority of real documents, but inference
 * that cannot be overridden is a trap: the first time it guesses wrong about a
 * document somebody cannot restructure, the whole tool gets switched off. These
 * directives are the escape hatch, and they are HTML comments so they stay
 * invisible in GitHub, MkDocs, Docusaurus and every other renderer.
 *
 * ```md
 * <!-- @spec-node id="ADR-0007" status="accepted" aliases="adr-7, sharding" -->
 * <!-- @spec-item id="shard-key" state="narrowed" -->
 * <!-- @spec-edge kind="delegates-to" to="ADR-0011#scope" -->
 * <!-- @spec-ignore -->
 * ```
 *
 * A directive always wins over anything inferred, and says so in the report, so
 * an override is visible rather than mysterious.
 */

import type { HtmlComment } from './markdown.js';

export type DirectiveName = 'spec-node' | 'spec-item' | 'spec-edge' | 'spec-ignore';

const KNOWN: ReadonlySet<string> = new Set<DirectiveName>(['spec-node', 'spec-item', 'spec-edge', 'spec-ignore']);

export interface Attribute {
  readonly value: string;
  /** Absolute offset of the value text, quotes excluded. */
  readonly start: number;
  readonly end: number;
}

export interface Directive {
  readonly name: DirectiveName;
  readonly attributes: ReadonlyMap<string, Attribute>;
  /** Offset of the enclosing comment. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
  /** Attribute names that were written but are not part of this directive. */
  readonly unknownAttributes: readonly string[];
}

const DIRECTIVE_HEAD = /^\s*@([a-z][a-z0-9-]*)/;
const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;

/** Attributes each directive understands. Anything else is reported, not ignored. */
const SCHEMA: Readonly<Record<DirectiveName, readonly string[]>> = {
  'spec-node': ['id', 'status', 'title', 'aliases', 'kind'],
  'spec-item': ['id', 'state', 'title', 'owner', 'note'],
  'spec-edge': ['kind', 'to', 'from', 'reason'],
  'spec-ignore': ['reason'],
};

/** Reads every spec-graph directive out of a document's HTML comments. */
export function parseDirectives(comments: readonly HtmlComment[]): Directive[] {
  const out: Directive[] = [];
  for (const comment of comments) {
    const head = DIRECTIVE_HEAD.exec(comment.inner);
    if (!head) continue;
    const name = head[1] as string;
    if (!KNOWN.has(name)) continue;

    const directiveName = name as DirectiveName;
    const bodyStart = (head.index ?? 0) + (head[0] as string).length;
    const body = comment.inner.slice(bodyStart);
    const attributes = new Map<string, Attribute>();
    const unknown: string[] = [];
    const allowed = SCHEMA[directiveName];

    ATTRIBUTE.lastIndex = 0;
    for (let m = ATTRIBUTE.exec(body); m !== null; m = ATTRIBUTE.exec(body)) {
      const key = (m[1] as string).toLowerCase();
      const quoted = m[3] ?? m[4];
      const bare = m[5];
      // A bare attribute is a flag: `<!-- @spec-ignore reason -->`.
      const value = quoted ?? bare ?? 'true';
      const raw = m[2];
      const valueOffset =
        raw === undefined
          ? (m.index ?? 0) + (m[0] as string).length
          : (m.index ?? 0) + (m[0] as string).indexOf(raw) + (quoted === undefined ? 0 : 1);
      const start = comment.innerStart + bodyStart + valueOffset;

      if (!allowed.includes(key)) unknown.push(key);
      attributes.set(key, { value, start, end: start + value.length });
    }

    out.push({
      name: directiveName,
      attributes,
      start: comment.start,
      end: comment.end,
      line: comment.line,
      unknownAttributes: unknown,
    });
  }
  return out;
}

/** Reads an attribute, trimmed. Returns `null` when absent or blank. */
export function attr(directive: Directive, name: string): Attribute | null {
  const found = directive.attributes.get(name);
  if (!found) return null;
  const trimmed = found.value.trim();
  if (trimmed.length === 0) return null;
  const offset = found.value.indexOf(trimmed);
  return { value: trimmed, start: found.start + offset, end: found.start + offset + trimmed.length };
}

/** Splits a comma- or whitespace-separated attribute into its parts. */
export function attrList(directive: Directive, name: string): string[] {
  const found = attr(directive, name);
  if (!found) return [];
  return found.value
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Finds the directive that annotates a given region.
 *
 * A `@spec-item` directive may sit on the line above the item, on the same
 * line, or inside the item body. All three read naturally in the source, so all
 * three are accepted, with the closest preceding directive winning.
 */
export function directiveFor(
  directives: readonly Directive[],
  name: DirectiveName,
  region: { start: number; end: number },
  /** How far above the region a directive may sit and still apply. */
  lookBehind: number,
): Directive | null {
  let best: Directive | null = null;
  for (const directive of directives) {
    if (directive.name !== name) continue;
    const inside = directive.start >= region.start && directive.end <= region.end;
    const above = directive.end <= region.start && region.start - directive.end <= lookBehind;
    if (!inside && !above) continue;
    if (best === null || directive.start > best.start) best = directive;
  }
  return best;
}
