/**
 * A structural Markdown scanner.
 *
 * This is deliberately **not** a CommonMark implementation. spec-graph needs six
 * things from a document - front matter, headings, list items with their
 * continuations, HTML comments, links, and a reliable map of what is code - and
 * a full parser would cost a dependency tree, an AST walk, and a position
 * mapping layer to get back the offsets we want in the first place.
 *
 * What the scanner does guarantee is the part that makes regex-based spec
 * linters lie:
 *
 * - **Code never counts.** Fenced blocks, indented blocks and inline spans are
 *   masked before a single link is extracted, so an example in a code sample
 *   never becomes a graph edge.
 * - **Items are blocks, not lines.** A list item owns its wrapped continuation
 *   lines and its nested content, so a resolution written on the second line of
 *   a bullet is found instead of missed.
 * - **Everything carries absolute offsets.** No re-scanning, no drift between
 *   the text a rule matched and the position it reports.
 */

import { createLineIndex, type LineIndex } from './source.js';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface FrontMatter {
  /** The body between the delimiters, exclusive. */
  readonly raw: string;
  /** Offset of the first character of `raw`. */
  readonly start: number;
  readonly end: number;
  /** Offset just past the closing delimiter line. */
  readonly bodyStart: number;
}

export interface ScannedLine {
  /** 1-based. */
  readonly line: number;
  /** Offset of the raw line start. */
  readonly start: number;
  /** Offset just past the line, excluding its terminator. */
  readonly end: number;
  /** Offset of the first character after any block-quote markers. */
  readonly contentStart: number;
  /** Line text after block-quote markers, indentation intact. */
  readonly content: string;
  /** Indentation of `content`, tabs counted as four columns. */
  readonly indent: number;
  readonly blank: boolean;
  readonly quoteDepth: number;
  /** Inside a fenced or indented code block, fence delimiters included. */
  readonly code: boolean;
}

export interface Heading {
  readonly level: number;
  readonly text: string;
  /** GitHub-compatible anchor slug. */
  readonly slug: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface ListItem {
  /** The whole block: marker line plus continuations and nested content. */
  readonly start: number;
  readonly end: number;
  /** Offset of the list marker itself. */
  readonly markerStart: number;
  readonly marker: string;
  /** Offset where the item text begins, after marker and any checkbox. */
  readonly textStart: number;
  /** The character inside `[ ]`, or `null` when the item has no checkbox. */
  readonly checkbox: string | null;
  readonly checkboxStart: number | null;
  /** First line of item text, trimmed. */
  readonly firstLine: string;
  /** Full item text including continuations and nested content. */
  readonly body: string;
  /**
   * `body` with code and comments blanked out, same length and offsets.
   *
   * Anything that searches item text for meaning - resolution markers above
   * all - must read this rather than `body`, or a fenced example nested under
   * the item will close it.
   */
  readonly maskedBody: string;
  readonly line: number;
  /** How many list items enclose this one. Top-level items are `0`. */
  readonly depth: number;
  readonly indent: number;
}

export interface HtmlComment {
  readonly start: number;
  readonly end: number;
  /** Text between `<!--` and `-->`. */
  readonly inner: string;
  readonly innerStart: number;
  readonly line: number;
}

export type LinkForm = 'inline' | 'reference' | 'shortcut' | 'autolink' | 'wiki' | 'definition';

export interface Link {
  /** Visible label. Empty for autolinks and definitions. */
  readonly text: string;
  /** Destination as written: a path or a URL. */
  readonly target: string;
  /** Offset of the whole construct. */
  readonly start: number;
  readonly end: number;
  /**
   * Offset of `target` inside the source, for precise diagnostics.
   *
   * For a reference link this is inside the definition, not inside the use:
   * `[design][one]` has no destination of its own, and the line a human edits
   * to fix it is the one that says what `one` points at.
   */
  readonly targetStart: number;
  /**
   * The reference label, for the two forms written with one.
   *
   * `null` everywhere else. Kept because `target` is the destination the label
   * stands for, and a report quoting `[design][docs/gone.md]` would be quoting
   * something the author never wrote.
   */
  readonly label: string | null;
  readonly form: LinkForm;
  readonly line: number;
}

export interface TableCell {
  /** Cell text as written, trimmed. */
  readonly text: string;
  /** Offset of the trimmed text, so a finding can point at the cell itself. */
  readonly start: number;
  readonly end: number;
}

export interface TableRow {
  readonly cells: readonly TableCell[];
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface Table {
  readonly start: number;
  readonly end: number;
  /** Header cells, trimmed. A table without a header row is not a table. */
  readonly headers: readonly TableCell[];
  readonly rows: readonly TableRow[];
}

export interface ScannedDocument {
  readonly text: string;
  readonly index: LineIndex;
  readonly frontMatter: FrontMatter | null;
  /** Offset where the body starts, after any front matter. */
  readonly bodyStart: number;
  readonly lines: readonly ScannedLine[];
  readonly headings: readonly Heading[];
  readonly listItems: readonly ListItem[];
  readonly comments: readonly HtmlComment[];
  readonly links: readonly Link[];
  readonly tables: readonly Table[];
  /** Code and comments blanked out, offsets and line breaks preserved. */
  readonly masked: string;
  /** True when the offset falls inside code, a comment, or front matter. */
  isMasked(offset: number): boolean;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export function scanMarkdown(source: string): ScannedDocument {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const index = createLineIndex(text);
  const frontMatter = readFrontMatter(text, index);
  const bodyStart = frontMatter ? frontMatter.bodyStart : 0;

  const lines = scanLines(text, index, bodyStart);
  // Raw-text HTML joins the code ranges rather than sitting beside them: what
  // both have in common is that their content is not Markdown, and every reader
  // downstream - comments, links, tables - already asks that one question.
  const codeRanges = mergeRanges([...collectCodeRanges(lines, bodyStart), ...collectRawTextHtml(lines, bodyStart)]);
  const comments = scanComments(text, index, bodyStart, codeRanges);

  const inlineCode = scanInlineCode(text, bodyStart, codeRanges, comments);
  const maskRanges = [
    ...(frontMatter ? [{ start: 0, end: frontMatter.bodyStart }] : []),
    ...codeRanges,
    ...inlineCode,
    ...comments.map((c) => ({ start: c.start, end: c.end })),
  ];
  const masked = applyMask(text, maskRanges);
  const sortedMask = mergeRanges(maskRanges);

  const headings = scanHeadings(lines);
  const listItems = scanListItems(lines, text, masked);
  const links = scanLinks(masked, text, index);
  const tables = scanTables(lines, text, masked);

  return {
    text,
    index,
    frontMatter,
    bodyStart,
    lines,
    headings,
    listItems,
    comments,
    links,
    tables,
    masked,
    isMasked: (offset) => containsOffset(sortedMask, offset),
  };
}

/* -------------------------------------------------------------------------- */
/* Front matter                                                               */
/* -------------------------------------------------------------------------- */

const FENCE_FM = /^(-{3,}|\+{3,})[ \t]*$/;

function readFrontMatter(text: string, index: LineIndex): FrontMatter | null {
  if (index.lineCount === 0) return null;
  const first = index.lineText(1);
  const open = FENCE_FM.exec(first);
  if (!open) return null;
  const closer = (open[1] as string).startsWith('-') ? /^(-{3,}|\.{3,})[ \t]*$/ : /^\+{3,}[ \t]*$/;

  for (let line = 2; line <= index.lineCount; line += 1) {
    if (closer.test(index.lineText(line))) {
      const start = index.lineStart(2);
      const end = index.lineStart(line);
      const bodyStart = line < index.lineCount ? index.lineStart(line + 1) : text.length;
      return { raw: text.slice(start, end), start, end, bodyStart };
    }
  }
  // An unterminated opener is a horizontal rule, not front matter.
  return null;
}

/* -------------------------------------------------------------------------- */
/* Line classification                                                        */
/* -------------------------------------------------------------------------- */

const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*(?:#+[ \t]*)?$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/** Counts indentation in columns, expanding tabs to the next multiple of four. */
function measureIndent(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Strips `>` block-quote markers, returning the offset and text of the content. */
function stripQuotes(raw: string, lineStart: number): { contentStart: number; content: string; depth: number } {
  let i = 0;
  let depth = 0;
  for (;;) {
    let j = i;
    let spaces = 0;
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t') && spaces < 3) {
      spaces += 1;
      j += 1;
    }
    if (raw[j] !== '>') break;
    j += 1;
    if (raw[j] === ' ') j += 1;
    depth += 1;
    i = j;
  }
  return { contentStart: lineStart + i, content: raw.slice(i), depth };
}

function scanLines(text: string, index: LineIndex, bodyStart: number): ScannedLine[] {
  const out: ScannedLine[] = [];
  const firstLine = index.positionAt(bodyStart).line;

  let fence: { char: string; length: number; indent: number } | null = null;
  let inList = false;
  let listIndent = 0;
  let previousBlank = true;
  let indentedCode = false;

  for (let line = firstLine; line <= index.lineCount; line += 1) {
    const start = index.lineStart(line);
    const end = index.lineEnd(line);
    if (end < bodyStart) continue;
    const raw = text.slice(start, end);
    const { contentStart, content, depth } = stripQuotes(raw, start);
    const indent = measureIndent(content);
    const blank = content.trim().length === 0;

    let code = false;

    if (fence) {
      code = true;
      const close = FENCE_OPEN.exec(content);
      if (
        close &&
        (close[2] as string)[0] === fence.char &&
        (close[2] as string).length >= fence.length &&
        (close[3] as string).trim().length === 0 &&
        measureIndent(close[1] as string) <= fence.indent + 3
      ) {
        fence = null;
      }
    } else {
      const open = FENCE_OPEN.exec(content);
      if (open && (open[3] as string).indexOf('`') === -1) {
        fence = {
          char: (open[2] as string)[0] as string,
          length: (open[2] as string).length,
          indent: measureIndent(open[1] as string),
        };
        code = true;
        indentedCode = false;
      } else if (blank) {
        code = indentedCode;
      } else {
        // Indented code is only recognised outside list containers. Inside a
        // list, four-space indentation is ordinary continuation far more often
        // than it is a code block, and masking a continuation would silently
        // drop the links and resolutions written there.
        if (!inList && indent >= 4 && (previousBlank || indentedCode)) {
          code = true;
          indentedCode = true;
        } else {
          indentedCode = false;
        }
      }
    }

    if (!code && !blank) {
      const marker = LIST_MARKER.exec(content);
      if (marker) {
        inList = true;
        listIndent = indent;
      } else if (inList && indent === 0 && previousBlank) {
        inList = false;
        listIndent = 0;
      } else if (inList && indent <= listIndent && previousBlank && ATX_HEADING.test(content)) {
        inList = false;
        listIndent = 0;
      }
      if (ATX_HEADING.test(content) && indent < 4) {
        inList = false;
        listIndent = 0;
      }
    }

    out.push({ line, start, end, contentStart, content, indent, blank, quoteDepth: depth, code });
    previousBlank = blank;
  }

  return out;
}

/**
 * `<script>`, `<style>`, `<pre>` and `<textarea>` blocks.
 *
 * These four are the only HTML elements whose content is not Markdown - the
 * CommonMark spec calls them out by name for exactly that reason - and the
 * distinction is load-bearing here rather than pedantic. A page explaining how
 * to annotate a document puts `<!-- @spec-node id="..." -->` inside a script
 * sample or a `<pre>` block, and reading that as a directive lets a worked
 * example rename the document it appears in.
 *
 * `<div>` and `<details>` are deliberately not on the list. Their content *is*
 * Markdown, and a decision written inside a collapsed `<details>` section is
 * still a decision.
 */
const RAW_TEXT_OPEN = /^<(script|pre|style|textarea)(?:[\s>]|$)/i;
const RAW_TEXT_CLOSE = /<\/(?:script|pre|style|textarea)>/i;

function collectRawTextHtml(lines: readonly ScannedLine[], bodyStart: number): Range[] {
  const ranges: Range[] = [];
  let open: { start: number; end: number } | null = null;
  for (const line of lines) {
    if (line.code) continue;
    if (open === null) {
      if (!RAW_TEXT_OPEN.test(line.content.trimStart())) continue;
      open = { start: Math.max(line.start, bodyStart), end: line.end };
    } else {
      open.end = line.end;
    }
    // The close tag ends the block on the line that carries it, whichever of
    // the four it names. An unclosed block runs to the end of the document,
    // which is what a browser does with it too.
    if (RAW_TEXT_CLOSE.test(line.content)) {
      ranges.push(open);
      open = null;
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

function collectCodeRanges(lines: readonly ScannedLine[], bodyStart: number): Range[] {
  const ranges: Range[] = [];
  let open: { start: number; end: number } | null = null;
  for (const line of lines) {
    if (line.code) {
      const start = Math.max(line.start, bodyStart);
      if (open && open.end >= line.start - 2) open.end = line.end;
      else {
        if (open) ranges.push(open);
        open = { start, end: line.end };
      }
    } else if (open) {
      ranges.push(open);
      open = null;
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

/* -------------------------------------------------------------------------- */
/* Headings                                                                   */
/* -------------------------------------------------------------------------- */

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()<>#!|]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    // GitHub hyphenates every whitespace character, so a run of two spaces left
    // behind by stripped punctuation becomes two hyphens, not one.
    .replace(/\s/g, '-');
}

function scanHeadings(lines: readonly ScannedLine[]): Heading[] {
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as ScannedLine;
    if (line.code || line.blank) continue;

    const atx = ATX_HEADING.exec(line.content);
    if (atx && line.indent < 4) {
      const body = (atx[2] ?? '').trim();
      out.push({
        level: (atx[1] as string).length,
        text: body,
        slug: slugify(body),
        start: line.contentStart,
        end: line.end,
        line: line.line,
      });
      continue;
    }

    // Setext: an underline of `=` or `-` directly below a paragraph line. The
    // preceding line must not itself be a heading, a list item or a fence.
    const next = lines[i + 1];
    if (!next || next.code || next.blank) continue;
    const under = SETEXT_UNDERLINE.exec(next.content);
    if (!under) continue;
    if (LIST_MARKER.test(line.content) || THEMATIC_BREAK.test(line.content)) continue;
    if (line.indent >= 4) continue;
    const body = line.content.trim();
    if (body.length === 0) continue;
    out.push({
      level: (under[1] as string)[0] === '=' ? 1 : 2,
      text: body,
      slug: slugify(body),
      start: line.contentStart,
      end: next.end,
      line: line.line,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* List items                                                                 */
/* -------------------------------------------------------------------------- */

const CHECKBOX = /^\[([ xX~\-?!*/+])\](?=[ \t]|$)/;

function scanListItems(lines: readonly ScannedLine[], text: string, masked: string): ListItem[] {
  const out: ListItem[] = [];
  // Indents of the list items currently enclosing the cursor, outermost first.
  const stack: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as ScannedLine;
    if (line.code || line.blank) continue;
    const marker = LIST_MARKER.exec(line.content);
    if (!marker) continue;

    const indent = measureIndent(marker[1] as string);
    while (stack.length > 0 && indent <= (stack[stack.length - 1] as number)) stack.pop();
    const depth = stack.length;
    stack.push(indent);

    const markerStart = line.contentStart + (marker[1] as string).length;
    let textStart = markerStart + (marker[2] as string).length + (marker[3] as string).length;

    const rest = text.slice(textStart, line.end);
    const box = CHECKBOX.exec(rest);
    let checkbox: string | null = null;
    let checkboxStart: number | null = null;
    if (box) {
      checkbox = box[1] as string;
      checkboxStart = textStart;
      textStart += (box[0] as string).length;
      while (text[textStart] === ' ' || text[textStart] === '\t') textStart += 1;
    }

    const end = findItemEnd(lines, i, indent);
    const firstLine = text.slice(textStart, line.end).trim();
    const body = text.slice(textStart, end);

    out.push({
      start: line.contentStart,
      end,
      markerStart,
      marker: marker[2] as string,
      textStart,
      checkbox,
      checkboxStart,
      firstLine,
      body,
      maskedBody: masked.slice(textStart, end),
      line: line.line,
      depth,
      indent,
    });
  }

  return out;
}

/**
 * Finds where a list item block ends.
 *
 * The item owns its wrapped continuation lines and everything nested under it.
 * It gives up ownership at the next sibling or shallower marker, at any
 * heading, and at the first non-indented line after a blank one.
 */
function findItemEnd(lines: readonly ScannedLine[], startIndex: number, indent: number): number {
  let end = (lines[startIndex] as ScannedLine).end;
  let sawBlank = false;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] as ScannedLine;
    if (line.blank) {
      sawBlank = true;
      continue;
    }
    if (!line.code) {
      if (line.indent < 4 && ATX_HEADING.test(line.content)) break;
      if (line.indent <= indent) {
        if (sawBlank) break;
        if (LIST_MARKER.test(line.content)) break;
        if (THEMATIC_BREAK.test(line.content)) break;
      }
    }
    if (line.indent <= indent && sawBlank) break;
    end = line.end;
    sawBlank = false;
  }

  return end;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** `| :--- | ---: | :-: |` - the row that makes the line above it a header. */
const TABLE_DELIMITER = /^\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/;

/**
 * Finds pipe tables, with an offset for every cell.
 *
 * Cell offsets are the point: a register kept as a table needs findings that
 * name the cell declaring the relation, not the row and not the file.
 *
 * Splitting happens on the masked copy so a pipe inside inline code cannot
 * invent a column, while the text comes from the original.
 */
function scanTables(lines: readonly ScannedLine[], text: string, masked: string): Table[] {
  const out: Table[] = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = lines[i] as ScannedLine;
    const delimiter = lines[i + 1] as ScannedLine;
    if (header.code || header.blank || delimiter.code) continue;
    if (!header.content.includes('|')) continue;
    if (!TABLE_DELIMITER.test(delimiter.content.trim())) continue;

    const headers = splitRow(header, text, masked);
    if (headers.length === 0) continue;

    const rows: TableRow[] = [];
    let end = delimiter.end;
    for (let j = i + 2; j < lines.length; j += 1) {
      const line = lines[j] as ScannedLine;
      if (line.blank || line.code || !line.content.includes('|')) break;
      const cells = splitRow(line, text, masked);
      if (cells.length === 0) break;
      rows.push({ cells, start: line.contentStart, end: line.end, line: line.line });
      end = line.end;
    }

    out.push({ start: header.contentStart, end, headers, rows });
    i += rows.length + 1;
  }

  return out;
}

/** Splits one row into cells, keeping each cell's offset in the source. */
function splitRow(line: ScannedLine, text: string, masked: string): TableCell[] {
  const from = line.contentStart;
  const to = line.end;
  const bounds: number[] = [];
  for (let i = from; i < to; i += 1) {
    if (masked[i] !== '|') continue;
    // A pipe escaped with a backslash is content, not a column edge.
    if (i > from && text[i - 1] === '\\') continue;
    bounds.push(i);
  }
  if (bounds.length === 0) return [];

  const cells: TableCell[] = [];
  // A leading pipe opens the first cell; without one the row starts at `from`.
  let cursor = (bounds[0] as number) === from ? from + 1 : from;
  for (const bound of bounds) {
    if (bound < cursor) continue;
    cells.push(makeCell(text, cursor, bound));
    cursor = bound + 1;
  }
  // Trailing content after the last pipe is a final cell unless the row ended
  // with a border pipe.
  if (cursor < to && text.slice(cursor, to).trim().length > 0) cells.push(makeCell(text, cursor, to));

  return cells;
}

function makeCell(text: string, start: number, end: number): TableCell {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  return { text: trimmed, start: start + leading, end: start + leading + trimmed.length };
}

/* -------------------------------------------------------------------------- */
/* HTML comments                                                              */
/* -------------------------------------------------------------------------- */

function scanComments(text: string, index: LineIndex, bodyStart: number, code: readonly Range[]): HtmlComment[] {
  const out: HtmlComment[] = [];
  const merged = mergeRanges(code);
  let from = bodyStart;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) break;
    if (containsOffset(merged, open)) {
      from = open + 4;
      continue;
    }
    const close = text.indexOf('-->', open + 4);
    if (close === -1) break;
    out.push({
      start: open,
      end: close + 3,
      inner: text.slice(open + 4, close),
      innerStart: open + 4,
      line: index.positionAt(open).line,
    });
    from = close + 3;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Inline code                                                                */
/* -------------------------------------------------------------------------- */

function scanInlineCode(
  text: string,
  bodyStart: number,
  code: readonly Range[],
  comments: readonly HtmlComment[],
): Range[] {
  const blocked = mergeRanges([...code, ...comments.map((c) => ({ start: c.start, end: c.end }))]);
  const out: Range[] = [];
  let i = bodyStart;

  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    if (containsOffset(blocked, i)) {
      i += 1;
      continue;
    }
    let runStart = i;
    while (text[i] === '`') i += 1;
    const runLength = i - runStart;
    // An escaped backtick does not open a span.
    if (runStart > 0 && text[runStart - 1] === '\\') continue;

    let j = i;
    let closed = -1;
    while (j < text.length) {
      if (text[j] !== '`') {
        j += 1;
        continue;
      }
      const closeStart = j;
      while (text[j] === '`') j += 1;
      if (j - closeStart === runLength && !containsOffset(blocked, closeStart)) {
        closed = j;
        break;
      }
    }
    if (closed === -1) continue;
    out.push({ start: runStart, end: closed });
    i = closed;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Masking                                                                    */
/* -------------------------------------------------------------------------- */

function mergeRanges(ranges: readonly Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [{ ...(sorted[0] as Range) }];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i] as Range;
    const last = out[out.length - 1] as { start: number; end: number };
    if (next.start <= last.end) last.end = Math.max(last.end, next.end);
    else out.push({ ...next });
  }
  return out;
}

function containsOffset(sorted: readonly Range[], offset: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = sorted[mid] as Range;
    if (offset < range.start) hi = mid - 1;
    else if (offset >= range.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Blanks out the given ranges.
 *
 * Line terminators survive so every offset, line and column in the masked copy
 * still matches the original. Callers slice the original text for content and
 * search the masked copy for structure.
 */
function applyMask(text: string, ranges: readonly Range[]): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return text;

  // Built from slices rather than a per-character array. Masking runs over every
  // byte of every document, and a `split('')`/`join('')` round trip allocates an
  // array entry per character - on a large corpus that was the single most
  // expensive thing the scanner did.
  let out = '';
  let cursor = 0;
  for (const range of merged) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    out += text.slice(cursor, start);
    // The character class is deliberately not Unicode-aware: a surrogate pair
    // must become two spaces so that every later offset still lines up.
    out += text.slice(start, end).replace(NON_TERMINATOR, ' ');
    cursor = end;
  }
  return out + text.slice(cursor);
}

const NON_TERMINATOR = /[^\n\r]/g;

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/;
const AUTOLINK = /<((?:https?|ftp|mailto):[^>\s]+)>/g;

/** How far a bracket construct may run before we call it unbalanced prose. */
const MAX_LINK_SPAN = 4096;

function scanLinks(masked: string, text: string, index: LineIndex): Link[] {
  const out: Link[] = [];
  const definitions = new Map<string, { target: string; targetStart: number }>();
  const definitionRanges: Range[] = [];

  // Pass 1: reference definitions. These are the destination table the other
  // two written-with-a-label forms are read through, which is why the whole
  // document is swept for them before a single use is looked at: a definition
  // is conventionally written at the foot of the file, long after the links
  // that use it.
  for (let line = 1; line <= index.lineCount; line += 1) {
    const start = index.lineStart(line);
    const content = masked.slice(start, index.lineEnd(line));
    const match = DEFINITION.exec(content);
    if (!match) continue;
    const label = (match[1] as string).trim().toLowerCase();
    const rawTarget = match[2] as string;
    const targetStart = start + content.indexOf(rawTarget, (match[1] as string).length);
    const target = unwrapAngle(rawTarget);
    // First definition wins, as in CommonMark.
    if (!definitions.has(label)) definitions.set(label, { target, targetStart });
    definitionRanges.push({ start, end: start + (match[0] as string).length });
    out.push({
      text: (match[1] as string).trim(),
      target,
      start,
      end: start + (match[0] as string).length,
      targetStart,
      label: (match[1] as string).trim(),
      form: 'definition',
      line,
    });
  }

  // Pass 2: autolinks.
  AUTOLINK.lastIndex = 0;
  for (let m = AUTOLINK.exec(masked); m !== null; m = AUTOLINK.exec(masked)) {
    const start = m.index;
    out.push({
      text: '',
      target: m[1] as string,
      start,
      end: start + (m[0] as string).length,
      targetStart: start + 1,
      label: null,
      form: 'autolink',
      line: index.positionAt(start).line,
    });
  }

  // Pass 3: bracket constructs, left to right.
  const definedAt = mergeRanges(definitionRanges);
  let i = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch !== '[') {
      i += 1;
      continue;
    }
    // The label of a definition is not itself a shortcut link to anything.
    if (containsOffset(definedAt, i)) {
      i += 1;
      continue;
    }
    const isImage = i > 0 && masked[i - 1] === '!';

    if (masked[i + 1] === '[') {
      const close = masked.indexOf(']]', i + 2);
      if (close !== -1 && close - i <= MAX_LINK_SPAN && masked.slice(i + 2, close).indexOf('\n') === -1) {
        const target = text.slice(i + 2, close).trim();
        if (target.length > 0) {
          out.push({
            text: target,
            target: wikiTarget(target),
            start: i,
            end: close + 2,
            targetStart: i + 2,
            label: null,
            form: 'wiki',
            line: index.positionAt(i).line,
          });
          i = close + 2;
          continue;
        }
      }
    }

    const labelEnd = matchBracket(masked, i);
    if (labelEnd === -1) {
      i += 1;
      continue;
    }
    const label = text.slice(i + 1, labelEnd);
    const after = masked[labelEnd + 1];

    if (after === '(') {
      const dest = readDestination(masked, labelEnd + 2);
      if (dest) {
        if (!isImage) {
          out.push({
            text: label.trim(),
            target: unwrapAngle(text.slice(dest.start, dest.end).trim()),
            start: isImage ? i - 1 : i,
            end: dest.close + 1,
            targetStart: dest.start,
            label: null,
            form: 'inline',
            line: index.positionAt(i).line,
          });
        }
        i = dest.close + 1;
        continue;
      }
    } else if (after === '[') {
      const refEnd = matchBracket(masked, labelEnd + 1);
      if (refEnd !== -1) {
        const ref = text.slice(labelEnd + 2, refEnd).trim();
        const written = ref.length > 0 ? ref : label.trim();
        const defined = definitions.get(written.toLowerCase());
        // A label with no definition is not a link. Every renderer prints
        // `[design][one]` verbatim when nothing says what `one` is, so reading
        // it as a citation invents a reference the author never made - and
        // then reports it as broken.
        if (!isImage && defined) {
          out.push({
            text: label.trim(),
            target: defined.target,
            start: i,
            end: refEnd + 1,
            targetStart: defined.targetStart,
            label: written,
            form: 'reference',
            line: index.positionAt(i).line,
          });
        }
        i = refEnd + 1;
        continue;
      }
    } else if (!isImage) {
      const written = label.trim();
      const defined = definitions.get(written.toLowerCase());
      if (defined) {
        out.push({
          text: written,
          target: defined.target,
          start: i,
          end: labelEnd + 1,
          targetStart: defined.targetStart,
          label: written,
          form: 'shortcut',
          line: index.positionAt(i).line,
        });
        i = labelEnd + 1;
        continue;
      }
    }

    i = labelEnd + 1;
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Finds the `]` matching the `[` at `open`, honouring nesting and escapes. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  const limit = Math.min(text.length, open + MAX_LINK_SPAN);
  for (let i = open; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n' && text[i + 1] === '\n') return -1;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Reads a link destination starting just after `(`. */
function readDestination(text: string, from: number): { start: number; end: number; close: number } | null {
  let i = from;
  const limit = Math.min(text.length, from + MAX_LINK_SPAN);
  while (i < limit && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i += 1;

  const start = i;
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    if (close === -1 || close > limit) return null;
    const paren = text.indexOf(')', close);
    if (paren === -1 || paren > limit) return null;
    return { start, end: close + 1, close: paren };
  }

  let depth = 0;
  while (i < limit) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\n') break;
    i += 1;
  }
  const end = i;
  // Skip an optional title, then require the closing paren.
  let j = i;
  while (j < limit && text[j] !== ')') {
    if (text[j] === '\n' && text[j + 1] === '\n') return null;
    j += 1;
  }
  if (j >= limit || text[j] !== ')') return null;
  if (end === start) return null;
  return { start, end, close: j };
}

function unwrapAngle(value: string): string {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
}

/** `[[0007-thing|Display]]` and `[[0007-thing]]` both target `0007-thing`. */
function wikiTarget(raw: string): string {
  const pipe = raw.indexOf('|');
  return (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
}
