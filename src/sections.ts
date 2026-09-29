/**
 * Specification regions: the part of a file that one specification occupies.
 *
 * `spec-graph` began by assuming one specification per file, because that is
 * how MADR, KEPs and Rust RFCs are laid out. Plenty of organisations do not
 * work that way. A register, a whitepaper or a living architecture document
 * holds dozens of decisions in one file, each with its own identifier, its own
 * status and its own dependencies - and to an engine that binds a document to a
 * file, every one of them is invisible.
 *
 * The fix is small once stated: **a specification is a region of a file, not a
 * file.** A file yields at least one region - itself - and may yield more.
 * Everything downstream is unchanged, because a region produces exactly the
 * same `DocumentNode` a whole file produced.
 *
 * What this module decides is where those regions begin and end, and it is
 * deliberately hard to convince. A heading has to carry an identifier *and* the
 * section has to declare a status before it counts. One signal is not enough:
 * `## Q3 2026 Roadmap` parses as family `Q`, number 3, and `## v1.2.0` in a
 * changelog parses as family `v`, number 1. Neither is a specification, and
 * neither declares a status.
 */

import { attr, type Directive } from './directives.js';
import { HAS_LETTER_OR_DIGIT, isExternal, parsePrefixedRef } from './identity.js';
import { isStatusHeading } from './lifecycle.js';
import {
  isMarkdownLine,
  isOnlyComment,
  type Heading,
  type Range,
  type ScannedDocument,
  type Table,
  type TableCell,
  type TableRow,
} from './markdown.js';
import type { EdgeKind } from './types.js';

/** A status as written, and where it was written. */
export interface RegionStatus {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A relation read from a table column rather than from prose. */
export interface TableRelation {
  readonly kind: EdgeKind;
  readonly inverted: boolean;
  readonly target: string;
  readonly start: number;
  readonly end: number;
  /** The column header that gave it its meaning, for the diagnostic. */
  readonly column: string;
}

export interface SpecificationRegion {
  /** The heading that opens the region, or `null` for the file or a table row. */
  readonly heading: Heading | null;
  /** The table row that is the region, when it is one. */
  readonly row: TableRow | null;
  /** Offset the region starts at. */
  readonly start: number;
  /** Offset just past the region. */
  readonly end: number;
  /** Identifier read from the heading or the identifier column. */
  readonly declaredId: string | null;
  readonly title: string | null;
  readonly status: RegionStatus | null;
  /** A `@spec-node` directive inside the region, when there is one. */
  readonly directive: Directive | null;
  /** Relations declared by column, empty for a heading region. */
  readonly relations: readonly TableRelation[];
  /**
   * Cells whose content is already accounted for as a typed relation.
   *
   * Prose scanning skips these, so a link in a `Depends on` column produces one
   * typed edge rather than a typed edge and a neutral citation beside it.
   */
  readonly claimed: readonly Range[];
}

/** Column headers that name the row's identifier. */
const ID_COLUMNS = /^(?:id|ids|ref|reference|key|no|number|#|adr|rfc|kep|oi|decision|spec|specification)$/;

/** Column headers that name the row's status. */
const STATUS_COLUMNS = /^(?:status|state|stage|lifecycle|phase)$/;

/** Column headers that name the row's title. */
const TITLE_COLUMNS = /^(?:title|name|summary|description|subject|decision|topic)$/;

/**
 * Column headers that declare a relation.
 *
 * Written the way a header is written - "Depends on", "Superseded by" - rather
 * than the way a front-matter key is, because that is what an author types at
 * the top of a column.
 */
const RELATION_COLUMNS: Readonly<Record<string, { kind: EdgeKind; inverted: boolean }>> = {
  'depends on': { kind: 'depends-on', inverted: false },
  'depends-on': { kind: 'depends-on', inverted: false },
  dependencies: { kind: 'depends-on', inverted: false },
  requires: { kind: 'depends-on', inverted: false },
  supersedes: { kind: 'supersedes', inverted: false },
  replaces: { kind: 'supersedes', inverted: false },
  'superseded by': { kind: 'supersedes', inverted: true },
  'replaced by': { kind: 'supersedes', inverted: true },
  'blocked by': { kind: 'blocked-by', inverted: false },
  'blocked on': { kind: 'blocked-by', inverted: false },
  blocks: { kind: 'blocked-by', inverted: true },
  amends: { kind: 'amends', inverted: false },
  extends: { kind: 'amends', inverted: false },
  assumes: { kind: 'assumes', inverted: false },
  'delegates to': { kind: 'delegates-to', inverted: false },
  'delegated to': { kind: 'delegates-to', inverted: false },
  'tracked in': { kind: 'delegates-to', inverted: false },
  related: { kind: 'relates-to', inverted: false },
  'related to': { kind: 'relates-to', inverted: false },
  'see also': { kind: 'relates-to', inverted: false },
  references: { kind: 'references', inverted: false },
};

/** Cell values that mean "nothing here". */
const MARKDOWN_LINK = /!?\[([^\]]*)\]\(([^)]*)\)/g;
const EMPTY_CELL = /^(?:-+|—|–|n\/?a|none|nil|tbd|\.|_+)$/i;

/** `## ADR-0007: Sharding` - an identifier at the very start of a heading. */
const HEADING_ID = /^\s*([A-Za-z]{1,15}[\s._-]?\d{1,6})\b/;

/** `**Status:** Accepted`, `Status: Accepted`, `*Status* : Accepted`, `**狀態：** 已接受`. */
const INLINE_STATUS = /^[ \t>]*[*_]{0,2}\s*(?:status|狀態|状态)\s*[*_]{0,2}\s*[:：]\s*(.+?)\s*$/im;

/**
 * Finds every specification in a file.
 *
 * The first entry is always the file itself, so a caller that ignores the rest
 * behaves exactly as it did before regions existed.
 */
export function findSpecificationRegions(
  scanned: ScannedDocument,
  directives: readonly Directive[],
  /** The file's own identifier, so its title heading is not read as a sub-region. */
  fileId: string,
): SpecificationRegion[] {
  // The file's own relations come from its front matter and prose, never from
  // here, and it claims no cell: nothing reads either list off this region.
  const whole: SpecificationRegion = {
    heading: null,
    row: null,
    start: scanned.bodyStart,
    end: scanned.text.length,
    declaredId: null,
    title: null,
    status: null,
    directive: null,
    relations: [],
    claimed: [],
  };

  const regions: SpecificationRegion[] = [];
  const folded = fold(fileId);
  const fileRef = parsePrefixedRef(fileId);

  for (let i = 0; i < scanned.headings.length; i += 1) {
    const heading = scanned.headings[i] as Heading;
    const declaredId = HEADING_ID.exec(heading.text)?.[1];
    if (declaredId === undefined) continue;
    // The file's own title heading names the file, not a region inside it.
    if (fold(declaredId) === folded) continue;
    // Padding is not part of an identity anywhere else - `ADR-40`, `ADR-040`
    // and `ADR-0040` all resolve to one document - so a heading that spells the
    // number differently from the file name is still that file's own title.
    // Comparing the text alone made `# ADR-040` inside `0040-enforce.md` a
    // region within the file it names: one decision, two nodes, and a citation
    // arriving at whichever spelling it happened to use.
    // `HEADING_ID` captures only what `PREFIXED_ID` parses, so `ref` is never
    // null here; the check is for the type.
    const ref = parsePrefixedRef(declaredId);
    if (ref !== null && fileRef !== null && ref.family === fileRef.family && ref.number === fileRef.number) continue;

    const end = regionEnd(scanned, i);
    const directive = directiveIn(directives, heading.end, end);
    const status = readRegionStatus(scanned, heading.end, end);

    // Two independent signals are required. An identifier alone matches
    // `## Q3 2026 Roadmap` and `## v1.2.0`; a status alone matches every
    // ordinary `## Status` section in a normal ADR.
    if (status === null && directive === null) continue;

    // A directive's id wins, but only if it is a name. One that is not - the
    // lone backslash `id=\"ADR-9\"` parses to, written inside a string - would
    // be discarded when the region is identified, and a region with nothing
    // to go by falls back to the file's own name: the file then contained
    // itself, and the section vanished. The heading's id is the one to keep.
    const directiveId = directive ? attr(directive, 'id')?.value : undefined;

    regions.push({
      heading,
      row: null,
      start: heading.start,
      end,
      declaredId: directiveId !== undefined && HAS_LETTER_OR_DIGIT.test(directiveId) ? directiveId : declaredId,
      title: heading.text,
      status,
      directive,
      relations: [],
      // Prose inside a section is prose: a heading region claims no cell.
      claimed: [],
    });
  }

  return [whole, ...regions, ...findTableRegions(scanned)];
}

/* -------------------------------------------------------------------------- */
/* Registers kept as tables                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads a table whose columns describe specifications.
 *
 * A table qualifies when it has an identifier column *and* either a status
 * column or at least one relation column. Two signals again, for the same
 * reason: a table of identifiers and prose is a citation list, and promoting
 * every row of it to a specification would invent a register nobody wrote.
 */
export function findTableRegions(scanned: ScannedDocument): SpecificationRegion[] {
  const out: SpecificationRegion[] = [];

  for (const table of scanned.tables) {
    const schema = readSchema(table);
    if (schema === null) continue;

    for (const row of table.rows) {
      const idCell = row.cells[schema.id];
      if (!idCell) continue;
      const id = flatten(idCell.text);
      // A row is named by its id cell or not at all. An empty one, a
      // placeholder, or punctuation alone - `?` for a row nobody has numbered
      // yet - names nothing, and a region with no name fell back to the file's:
      // the register then contained itself, and the row vanished.
      if (!HAS_LETTER_OR_DIGIT.test(id) || EMPTY_CELL.test(id)) continue;

      // `row.cells[null]` is undefined too, so the null checks on the optional
      // columns are for the type; and `statusText` is read only beside a cell.
      const statusCell = schema.status === null ? undefined : row.cells[schema.status];
      const statusText = statusCell ? flatten(statusCell.text) : '';
      const status: RegionStatus | null =
        statusCell && statusText.length > 0 && !EMPTY_CELL.test(statusText)
          ? { text: statusText, start: statusCell.start, end: statusCell.end }
          : null;

      const titleCell = schema.title === null ? undefined : row.cells[schema.title];
      const title = titleCell ? flatten(titleCell.text) : null;

      const relations: TableRelation[] = [];
      // The status cell is left to prose, as a status line under a heading is:
      // `Superseded by ADR-0002` there names the row's successor, and claimed
      // it named nothing at all.
      const claimed: Range[] = [{ start: idCell.start, end: idCell.end }];

      for (const [column, relation] of schema.relations) {
        const cell = row.cells[column];
        if (!cell) continue;
        claimed.push({ start: cell.start, end: cell.end });
        for (const target of splitTargets(cell)) {
          relations.push({
            kind: relation.kind,
            inverted: relation.inverted,
            target: target.text,
            start: target.start,
            end: target.end,
            column: (table.headers[column] as TableCell).text,
          });
        }
      }

      out.push({
        heading: null,
        row,
        start: row.start,
        end: row.end,
        declaredId: id,
        title: title !== null && title.length > 0 ? title : null,
        status,
        directive: null,
        relations,
        claimed,
      });
    }
  }

  return out;
}

interface TableSchema {
  readonly id: number;
  readonly status: number | null;
  readonly title: number | null;
  readonly relations: readonly (readonly [number, { kind: EdgeKind; inverted: boolean }])[];
}

function readSchema(table: Table): TableSchema | null {
  let id: number | null = null;
  let status: number | null = null;
  let title: number | null = null;
  const relations: [number, { kind: EdgeKind; inverted: boolean }][] = [];

  table.headers.forEach((header, column) => {
    const name = normaliseHeader(header.text);
    if (id === null && ID_COLUMNS.test(name)) {
      id = column;
      return;
    }
    if (status === null && STATUS_COLUMNS.test(name)) {
      status = column;
      return;
    }
    const relation = RELATION_COLUMNS[name];
    if (relation) {
      relations.push([column, relation]);
      return;
    }
    if (title === null && TITLE_COLUMNS.test(name)) title = column;
  });

  // Without an id column every row would be skipped for want of an id cell;
  // this says so before reading any of them.
  if (id === null) return null;
  if (status === null && relations.length === 0) return null;
  return { id, status, title, relations };
}

function normaliseHeader(text: string): string {
  return flatten(text)
    .toLowerCase()
    .replace(/[^a-z0-9/#\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a cell into the identifiers it lists, keeping each one's offset. */
function splitTargets(cell: TableCell): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  // Every target is reported at the cell's span. A cell is short, and an offset
  // recovered back through a flattening is an offset that can drift.
  const push = (raw: string): void => {
    const target = raw.trim();
    if (target.length === 0 || EMPTY_CELL.test(target)) return;
    out.push({ text: target, start: cell.start, end: cell.end });
  };
  const prose = (segment: string): void => {
    for (const piece of flatten(segment).split(/\s*(?:[,;]|\band\b)\s*/i)) push(piece);
  };

  // Links are taken out whole rather than flattened with everything else: a
  // path would otherwise be cut in half by its own slash, and its underscores
  // stripped as emphasis.
  // A fresh matcher per cell. `prose` calls `flatten`, which drives the shared
  // pattern; one /g regex advanced from inside its own scan resets its cursor
  // and never terminates.
  const links = new RegExp(MARKDOWN_LINK.source, 'g');
  let last = 0;
  for (let match = links.exec(cell.text); match !== null; match = links.exec(cell.text)) {
    prose(cell.text.slice(last, match.index));
    // Both groups always take part in a match, so the `?? ''` below and in the
    // label are for the type.
    const destination = (match[2] ?? '').trim();
    // A link states where its target lives; its label states only what the
    // target is called (ADR-0008). In a column the author has already typed,
    // the destination is the claim - `[see](adr/0050.md)` is a dependency on
    // that file, not on the word "see". An external or in-page destination
    // names no document here, so the label is what is left to try.
    const local = destination.length > 0 && !destination.startsWith('#') && !isExternal(destination);
    push(local ? destination : (match[1] ?? ''));
    last = match.index + match[0].length;
  }
  prose(cell.text.slice(last));
  return out;
}

/** Reduces a cell to its text: link labels rather than link syntax. */
function flatten(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where a heading's section ends: the next heading at the same level or above. */
function regionEnd(scanned: ScannedDocument, index: number): number {
  const heading = scanned.headings[index] as Heading;
  for (let i = index + 1; i < scanned.headings.length; i += 1) {
    const next = scanned.headings[i] as Heading;
    if (next.level <= heading.level) return next.start;
  }
  return scanned.text.length;
}

/**
 * Reads a status declared inside a region.
 *
 * Two forms, both common: a labelled line (`**Status:** Accepted`) and a
 * sub-heading (`### Status` with the value beneath it). Only the region is
 * searched, so one decision in a register cannot inherit its neighbour's.
 */
export function readRegionStatus(scanned: ScannedDocument, start: number, end: number): RegionStatus | null {
  const labelled = readLabelledStatus(scanned, start, end);
  if (labelled) return labelled;
  return readHeadedStatus(scanned, start, end);
}

function readLabelledStatus(scanned: ScannedDocument, start: number, end: number): RegionStatus | null {
  for (const line of scanned.lines) {
    if (line.contentStart < start) continue;
    if (line.contentStart >= end) break;
    // A template's commented-out `Status: proposed | accepted` is a hint to
    // whoever fills it in, not a status the region declares, and one in code or
    // a <pre> block is an example.
    if (!isMarkdownLine(line) || line.blank || line.comment) continue;
    const match = INLINE_STATUS.exec(line.content);
    if (!match) continue;
    // `**Status:** Accepted` closes its emphasis *after* the colon, so the
    // closing marker lands in the captured value. Strip it rather than let it
    // reach the report as part of the status a reader is shown.
    const value = (match[1] as string).replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '');
    if (value.length === 0) continue;
    const offset = line.contentStart + line.content.lastIndexOf(value);
    return { text: value, start: offset, end: offset + value.length };
  }
  return null;
}

function readHeadedStatus(scanned: ScannedDocument, start: number, end: number): RegionStatus | null {
  // The upper bound decides nothing on its own: under a heading at or past
  // `end` there is no line before `end`, and the loop below stops there.
  const heading = scanned.headings.find((h) => h.start >= start && h.start < end && isStatusHeading(h.text));
  if (!heading) return null;

  for (const line of scanned.lines) {
    if (line.line <= heading.line) continue;
    if (line.contentStart >= end) break;
    if (line.blank || isOnlyComment(scanned, line)) continue;
    if (!isMarkdownLine(line)) return null;
    if (opensHeading(scanned, line.line)) return null;
    const trimmed = line.content.trim();
    // A bullet list under Status is a status history; the first entry is current.
    const cleaned = trimmed.replace(/^[-*+]\s+/, '');
    const offset = line.contentStart + line.content.indexOf(trimmed) + (trimmed.length - cleaned.length);
    return { text: cleaned, start: offset, end: offset + cleaned.length };
  }
  return null;
}

/**
 * Whether a heading begins on this line, which ends a status section's search
 * for its value.
 *
 * Asked of the scanner rather than of the line's first character, because a
 * setext heading's text line starts with no `#`: under `### Status` it read as
 * the status, and a register took the next decision's title for its own.
 */
export function opensHeading(scanned: ScannedDocument, line: number): boolean {
  return scanned.headings.some((heading) => heading.line === line);
}

/**
 * The last `@spec-node` directive inside a region: the one written last, which
 * is the one a reader sees as the final word.
 *
 * Directives arrive in the order they were written, so each candidate starts
 * after the one before it and the comparison below only restates that. And
 * `start` is where a heading's line ends, a comment written on it included,
 * so no directive begins exactly there and `<` against `<=` decides nothing.
 */
function directiveIn(directives: readonly Directive[], start: number, end: number): Directive | null {
  let found: Directive | null = null;
  for (const directive of directives) {
    if (directive.name !== 'spec-node') continue;
    if (directive.start < start || directive.end > end) continue;
    if (found === null || directive.start > found.start) found = directive;
  }
  return found;
}

/**
 * Case- and separator-insensitive comparison, matching reference folding.
 *
 * Applied to both sides of one comparison, so which case it folds to does not
 * matter; the separators take every space with them, so the trim does not
 * either; and `+` only saves work.
 */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

/** The region containing an offset, innermost first. `null` when only the file does. */
export function regionAt(regions: readonly SpecificationRegion[], offset: number): SpecificationRegion | null {
  let best: SpecificationRegion | null = null;
  for (const region of regions) {
    // The whole-file region owns nothing in particular; it is the fallback.
    if (region.heading === null && region.row === null) continue;
    if (offset < region.start || offset >= region.end) continue;
    // No two regions of one file open at the same offset, so `>` and `>=`
    // agree here.
    if (best === null || region.start > best.start) best = region;
  }
  return best;
}
