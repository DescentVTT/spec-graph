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

import { isMarkdownLine, type HtmlComment, type ListItem, type ScannedDocument } from './markdown.js';

export type DirectiveName = 'spec-node' | 'spec-item' | 'spec-edge' | 'spec-ignore' | 'spec-history';

const KNOWN: ReadonlySet<string> = new Set<DirectiveName>([
  'spec-node',
  'spec-item',
  'spec-edge',
  'spec-ignore',
  'spec-history',
]);

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
  // Takes no attributes: the file either is a record or it is not.
  'spec-history': [],
  'spec-item': ['id', 'state', 'title', 'owner', 'note'],
  'spec-edge': ['kind', 'to', 'from', 'reason'],
  'spec-ignore': ['reason'],
};

/**
 * Reads every spec-graph directive out of a document's HTML comments.
 *
 * Only out of a comment that closes. One that opens a line and never does runs
 * to the end of the document, and read as a directive, a stray
 * `<!-- @spec-ignore` would drop the file, and a stray `<!-- @spec-node` would
 * take every `name=value` in the rest of it as an attribute.
 */
export function parseDirectives(comments: readonly HtmlComment[]): Directive[] {
  const out: Directive[] = [];
  for (const comment of comments) {
    if (comment.closed === false) continue;
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
 *
 * It answers for one region with no view of the others, so a directive in reach
 * of two items is found for both. Extraction uses `bindItemDirectives`.
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

/**
 * Pairs each `@spec-item` directive with the one list item it annotates.
 *
 * A directive is written for one item, so it binds to one: the item directly
 * below it, with nothing but blank lines and other comments between, or else
 * the item it is written in, the innermost where items nest. An item that
 * several bind to takes the last one written.
 *
 * A directive alone on its line is in an item only when indented further than
 * that item's marker, which is how CommonMark reads it. Indented under an item,
 * it annotates that item and not the sibling below; flush between two items, it
 * annotates the second.
 */
export function bindItemDirectives(
  scanned: ScannedDocument,
  directives: readonly Directive[],
): Map<ListItem, Directive> {
  const bound = new Map<ListItem, Directive>();
  const wanted = directives.filter((directive) => directive.name === 'spec-item');
  // Most documents carry none. Sparing them the pass over their lines changes
  // how long this takes and nothing else.
  if (wanted.length === 0) return bound;

  const { lines, listItems } = scanned;
  const masked = scanned.masks.structure;
  // The indentation of each line holding nothing but whitespace and comments.
  // Code and raw-text HTML are masked too, so they are told apart by their flags.
  const quiet = new Map<number, number>();
  // For every other line, where the run of quiet lines directly above it began,
  // when there was one.
  const quietFrom = new Map<number, number | undefined>();
  let run: number | undefined;
  for (const line of lines) {
    if (isMarkdownLine(line) && masked.slice(line.contentStart, line.end).trim() === '') {
      quiet.set(line.line, line.indent);
      run ??= line.start;
      continue;
    }
    quietFrom.set(line.line, run);
    run = undefined;
  }

  // The items whose text the cursor is in, outermost first. Items nest, so one
  // that has ended is always on top. An item ends at the end of a line, the next
  // thing starts on a later one, and no two things start together, so `<` and
  // `<=` read alike in every comparison of offsets below.
  const open: ListItem[] = [];
  const close = (offset: number): void => {
    while (open.length > 0 && (open[open.length - 1] as ListItem).end <= offset) open.pop();
  };
  let next = 0;
  for (const directive of wanted) {
    while (next < listItems.length && (listItems[next] as ListItem).start < directive.start) {
      const item = listItems[next] as ListItem;
      close(item.start);
      open.push(item);
      next += 1;
    }
    close(directive.start);

    // Sharing its line with text, a directive is in whatever that text is in.
    const indent = quiet.get(directive.line) ?? Infinity;
    // No deeper than the scanner already went to find where these items end.
    let depth = open.length - 1;
    while (depth >= 0 && (open[depth] as ListItem).indent >= indent) depth -= 1;
    const holder = open[depth];

    const below = listItems[next];
    const directlyAbove = below !== undefined && (quietFrom.get(below.line) ?? Infinity) <= directive.start;
    if (directlyAbove && (holder === undefined || below.start < holder.end)) {
      bound.set(below, directive);
      continue;
    }
    // Flush under an item and above no other, it continues the item as any
    // unindented line does.
    const written = holder ?? open[open.length - 1];
    if (written !== undefined) bound.set(written, directive);
  }
  return bound;
}
