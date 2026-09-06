/**
 * Offset arithmetic.
 *
 * Every finding spec-graph reports points at a line and a column, and every
 * intermediate structure carries raw offsets instead of copies of the text.
 * Converting between the two is therefore on the hot path, so the line table is
 * built once per file and searched with a binary search rather than by counting
 * newlines from the start each time.
 */

import type { Position, SourceRef, Span } from './types.js';

export interface LineIndex {
  /** Number of lines. A file ending in a newline does not gain a trailing line. */
  readonly lineCount: number;
  /** Offset at which the given 1-based line starts. */
  lineStart(line: number): number;
  /** Offset just past the given 1-based line, excluding its terminator. */
  lineEnd(line: number): number;
  /** Text of the given 1-based line, without its terminator. */
  lineText(line: number): string;
  /** Convert an absolute offset to a `{ line, column }` position. */
  positionAt(offset: number): Position;
}

/**
 * Builds the line table for `text`.
 *
 * Recognises all three line terminators. `\r\n` counts once: a Windows checkout
 * of a spec must produce the same line numbers as a POSIX one, or half the
 * team gets diagnostics pointing at the wrong place.
 */
export function createLineIndex(text: string): LineIndex {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      starts.push(i + 1);
    } else if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      starts.push(i + 1);
    }
  }
  // A terminator at the very end opens a line that contains nothing. Drop it so
  // `lineCount` matches what an editor shows.
  if (starts.length > 1 && starts[starts.length - 1] === text.length) starts.pop();

  const lineCount = starts.length;

  const startOf = (line: number): number => {
    const clamped = line < 1 ? 1 : line > lineCount ? lineCount : line;
    return starts[clamped - 1] as number;
  };

  const endOf = (line: number): number => {
    const clamped = line < 1 ? 1 : line > lineCount ? lineCount : line;
    if (clamped === lineCount) {
      let end = text.length;
      while (end > (starts[clamped - 1] as number)) {
        const ch = text.charCodeAt(end - 1);
        if (ch === 10 || ch === 13) end -= 1;
        else break;
      }
      return end;
    }
    let end = starts[clamped] as number;
    while (end > (starts[clamped - 1] as number)) {
      const ch = text.charCodeAt(end - 1);
      if (ch === 10 || ch === 13) end -= 1;
      else break;
    }
    return end;
  };

  return {
    lineCount,
    lineStart: startOf,
    lineEnd: endOf,
    lineText: (line) => text.slice(startOf(line), endOf(line)),
    positionAt(offset: number): Position {
      const clamped = offset < 0 ? 0 : offset > text.length ? text.length : offset;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= clamped) lo = mid;
        else hi = mid - 1;
      }
      return { offset: clamped, line: lo + 1, column: clamped - (starts[lo] as number) + 1 };
    },
  };
}

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
