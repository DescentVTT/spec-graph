/**
 * Offset arithmetic.
 *
 * Every finding spec-graph reports points at a line and a column, and every
 * intermediate structure carries raw offsets instead of copies of the text.
 * Converting between the two is therefore on the hot path, so the line table is
 * built once per file and searched with a binary search rather than by counting
 * newlines from the start each time.
 */

import type { LineIndex } from './vendor/spec-core/text/index.js';
import type { SourceRef, Span } from './types.js';

/**
 * The line table is spec-core's, which is the one this file wrote: all three
 * line terminators, with CRLF counted once, so a Windows checkout of a spec
 * produces the line numbers a POSIX one does.
 */
export { createLineIndex, type LineIndex } from './vendor/spec-core/text/index.js';

/** Builds a {@link Span} from two offsets. */
export function spanOf(index: LineIndex, start: number, end: number): Span {
  return { start: index.positionAt(start), end: index.positionAt(end) };
}

/** Builds a {@link SourceRef} from two offsets. */
export function refOf(file: string, index: LineIndex, start: number, end: number): SourceRef {
  return { file, span: spanOf(index, start, end) };
}

/** `path:line:column`, the form every editor and terminal knows how to open. */
export function formatRef(ref: SourceRef): string {
  return `${ref.file}:${ref.span.start.line}:${ref.span.start.column}`;
}

/**
 * Sort key for deterministic report ordering.
 *
 * CI output that reorders between runs is output nobody diffs, so ordering is
 * total: file, then line, then column, then length.
 */
export function compareRefs(a: SourceRef, b: SourceRef): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.span.start.line !== b.span.start.line) return a.span.start.line - b.span.start.line;
  if (a.span.start.column !== b.span.start.column) return a.span.start.column - b.span.start.column;
  return a.span.end.offset - b.span.end.offset;
}
