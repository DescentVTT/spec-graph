/**
 * What spec-graph reads out of a document's front matter.
 *
 * The reader is spec-core's, copied into `src/vendor/spec-core/markdown/`: the
 * subset of YAML that specifications use - scalars, quoted scalars, inline and
 * block sequences, `#` comments and, as spec-graph reads it, one level of nested
 * mapping flattened to `parent.child` - with the offset of every key and value,
 * because when a status is wrong the report has to point at the line that
 * declares it.
 *
 * Anything richer is recognised and not guessed at: a value continued on the
 * next line, a plain value holding `: `, a block scalar, an anchor. Such a value
 * is not read, and the reason is a parse problem at the value, so a key that
 * says nothing to the graph says why under `--verbose`. Each problem says
 * whether it left something out and which key, for the count a run prints
 * without `--verbose`.
 *
 * What stays here is the shape the rest of spec-graph reads: a key in lower
 * case, which is how a relation key, a status key and `fm.<key>` in a selector
 * have always been compared, and a value that is a string or a list of them.
 */

import { frontMatterKind, readFrontMatter, type FrontMatter as Read } from './vendor/spec-core/markdown/index.js';
import type { ScannedDocument } from './markdown.js';

export interface YamlEntry {
  /** Lower-cased key. Nested keys are flattened with a dot. */
  readonly key: string;
  readonly value: string | readonly string[];
  /** Offset of the key. */
  readonly start: number;
  /** Offset just past the value. */
  readonly end: number;
  /** Offset of the first character of the value, for precise diagnostics. */
  readonly valueStart: number;
}

/** Something in the front matter that was not read, and where. */
export interface FrontMatterProblem {
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /**
   * Whether it left something out: a value, a line or the whole block. A key
   * written twice is a problem that leaves nothing out, since the last is read.
   */
  readonly unread: boolean;
  /**
   * The key, lower-cased, whose value or line was left out, when the line
   * names one; `null` for a line that names none and for the whole block.
   */
  readonly key: string | null;
}

export interface FrontMatterReading {
  readonly entries: readonly YamlEntry[];
  readonly problems: readonly FrontMatterProblem[];
}

const NOTHING: FrontMatterReading = { entries: [], problems: [] };

/** A line that reads as `key:` at any indentation, and the key it names. */
const KEY_SHAPE = /^[ \t]*([A-Za-z_][\w.-]*)[ \t]*:/;

/** Reads a scanned document's front matter. */
export function readEntries(scanned: ScannedDocument): FrontMatterReading {
  const block = scanned.frontMatter;
  if (block === null) return neverClosed(scanned);
  const index = scanned.index;
  // The block and nothing after it: the reader splits what it is given into
  // lines, and the body is none of its business.
  const read = readFrontMatter(scanned.text.slice(0, block.bodyStart), { nested: true });
  // The scan found a closed block, and the reader closes one by the same rule.
  if (read === null) return NOTHING;
  const { entries, problems } = entriesOf(read, 0);
  return {
    entries,
    problems: [
      ...read.problems.map((problem) => {
        // A key written twice is read, the last of it; any other line with a
        // problem is not, and the key it looks like it names is what went
        // missing - `  status: accepted`, indented under nothing, is a status.
        const unread = !read.entries.some((entry) => entry.line === problem.line);
        const text = index.lineText(problem.line + 1);
        return {
          message: `front matter: ${problem.message}`,
          start: index.lineStart(problem.line + 1),
          end: index.lineEnd(problem.line + 1),
          unread,
          key: KEY_SHAPE.exec(text)?.[1]?.toLowerCase() ?? null,
        };
      }),
      ...problems,
    ].sort((a, b) => a.start - b.start),
  };
}

/**
 * Front matter that opens and never closes, which the scan reads as a rule
 * and Markdown after it, so nothing in it reaches the graph.
 *
 * The scan closes a block by the rule the reader does, so this is the one case
 * it leaves null with a first line that opens one. The usual cause is a closer
 * that only looks like one: `----` and `....` closed front matter here before
 * 0.9.0, and neither is one of YAML's document markers.
 */
function neverClosed(scanned: ScannedDocument): FrontMatterReading {
  const index = scanned.index;
  const kind = frontMatterKind(index.lineText(1));
  if (kind === null) return NOTHING;
  const delimiter = kind === 'yaml' ? '---' : '+++';
  return {
    entries: [],
    problems: [
      {
        message: `front matter: opened here and never closed, so none of it is read - close it with "${delimiter}" on a line of its own`,
        start: index.lineStart(1),
        end: index.lineEnd(1),
        unread: true,
        key: null,
      },
    ],
  };
}

/**
 * Parses front-matter text: what lies between the delimiters, as
 * `FrontMatter.raw` holds it.
 *
 * @param raw The text between the delimiters. It cannot hold a line that would
 *   close them, as text a scan read between them never does.
 * @param baseOffset Offset of `raw` within the containing file, so the returned
 *   spans address the file rather than the fragment.
 */
export function parseFrontMatter(raw: string, baseOffset = 0): YamlEntry[] {
  // The reader reads front matter at the top of a document, so the text goes
  // back between delimiters, and every offset back by the four characters the
  // opening one takes. The line break before the closing one is a blank line
  // when `raw` already ends in one, and a blank line is no key's.
  const read = readFrontMatter(`---\n${raw}\n---`, { nested: true });
  // Never null: the text opens with a delimiter and closes with one.
  return read === null ? [] : entriesOf(read, baseOffset - 4).entries;
}

/** The entries a reading holds, and the values it could not read as problems. */
function entriesOf(read: Read, shift: number): { entries: YamlEntry[]; problems: FrontMatterProblem[] } {
  const entries: YamlEntry[] = [];
  const problems: FrontMatterProblem[] = [];
  for (const entry of read.entries) {
    const { value } = entry;
    if (value.kind === 'unsupported') {
      problems.push({
        message: `front matter: "${entry.key}" is not read: ${value.reason}`,
        start: entry.valueStart + shift,
        end: entry.valueEnd + shift,
        unread: true,
        key: entry.key.toLowerCase(),
      });
      continue;
    }
    entries.push({
      key: entry.key.toLowerCase(),
      value: value.kind === 'scalar' ? value.scalar.text : value.items.map((item) => item.text),
      start: entry.keyStart + shift,
      end: entry.valueEnd + shift,
      valueStart: entry.valueStart + shift,
    });
  }
  return { entries, problems };
}

/** Collapses parsed entries into the flat record stored on a document node. */
export function toRecord(entries: readonly YamlEntry[]): Record<string, string | readonly string[]> {
  const out: Record<string, string | readonly string[]> = {};
  for (const entry of entries) out[entry.key] = entry.value;
  return out;
}

/** Every value of a key as a flat list, whether it was a scalar or a sequence. */
export function valuesOf(entry: YamlEntry | undefined): string[] {
  if (!entry) return [];
  return typeof entry.value === 'string'
    ? entry.value.length > 0
      ? [entry.value]
      : []
    : [...entry.value];
}
