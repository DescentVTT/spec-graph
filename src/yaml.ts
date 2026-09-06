/**
 * A front-matter reader for the subset of YAML that specifications actually use.
 *
 * Front matter in an ADR is a flat bag of scalars and lists. Pulling in a full
 * YAML implementation to read `status: accepted` would add a parser with its own
 * CVE history, and would still need wrapping to recover the byte offset of the
 * value - which is the whole reason we parse it ourselves: when a status is
 * wrong, the report has to point at the line that declares it.
 *
 * Supported: scalars, quoted scalars, inline `[a, b]` sequences, block `- item`
 * sequences, one level of nested mapping (flattened to `parent.child`), and `#`
 * comments. Anything richer is preserved as the raw scalar text rather than
 * being silently mangled.
 */

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

const KEY_LINE = /^(\s*)([A-Za-z0-9_.$-]+)\s*:(.*)$/;
const SEQUENCE_ITEM = /^(\s*)-\s*(.*)$/;

/**
 * Parses front-matter text.
 *
 * @param raw The text between the delimiters.
 * @param baseOffset Offset of `raw` within the containing file, so the returned
 *   spans address the file rather than the fragment.
 */
export function parseFrontMatter(raw: string, baseOffset = 0): YamlEntry[] {
  const entries: YamlEntry[] = [];
  const lines = splitLines(raw);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as SplitLine;
    const match = KEY_LINE.exec(line.text);
    if (!match) continue;

    const indent = (match[1] as string).length;
    const key = (match[2] as string).toLowerCase();
    const rest = match[3] as string;
    const restStart = line.start + indent + (match[2] as string).length + 1;
    const trimmed = stripComment(rest).trim();

    if (trimmed.length > 0) {
      const valueStart = restStart + rest.indexOf(trimmed);
      entries.push({
        key,
        value: parseScalarOrFlow(trimmed),
        start: baseOffset + line.start + indent,
        end: baseOffset + valueStart + trimmed.length,
        valueStart: baseOffset + valueStart,
      });
      continue;
    }

    // An empty value opens either a block sequence or a nested mapping.
    const block = readBlock(lines, i + 1, indent);
    if (block.kind === 'sequence') {
      entries.push({
        key,
        value: block.items,
        start: baseOffset + line.start + indent,
        end: baseOffset + block.end,
        valueStart: baseOffset + block.valueStart,
      });
      i = block.lastIndex;
    } else if (block.kind === 'mapping') {
      for (const child of block.entries) {
        entries.push({
          key: `${key}.${child.key}`,
          value: child.value,
          start: baseOffset + child.start,
          end: baseOffset + child.end,
          valueStart: baseOffset + child.valueStart,
        });
      }
      i = block.lastIndex;
    } else {
      entries.push({
        key,
        value: '',
        start: baseOffset + line.start + indent,
        end: baseOffset + line.end,
        valueStart: baseOffset + line.end,
      });
    }
  }

  return entries;
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

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface SplitLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function splitLines(raw: string): SplitLine[] {
  const out: SplitLine[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === '\n') {
      let end = i;
      if (end > start && raw[end - 1] === '\r') end -= 1;
      out.push({ text: raw.slice(start, end), start, end });
      start = i + 1;
    }
  }
  if (out.length > 0 && (out[out.length - 1] as SplitLine).text === '' && raw.endsWith('\n')) out.pop();
  return out;
}

type Block =
  | { kind: 'sequence'; items: string[]; end: number; valueStart: number; lastIndex: number }
  | { kind: 'mapping'; entries: YamlEntry[]; lastIndex: number }
  | { kind: 'empty'; lastIndex: number };

function readBlock(lines: readonly SplitLine[], from: number, indent: number): Block {
  const items: string[] = [];
  let valueStart = -1;
  let end = -1;
  let last = from - 1;

  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] as SplitLine;
    if (line.text.trim().length === 0) {
      last = i;
      continue;
    }
    const lineIndent = line.text.length - line.text.trimStart().length;
    if (lineIndent <= indent) break;

    const seq = SEQUENCE_ITEM.exec(line.text);
    if (!seq) {
      if (items.length > 0) break;
      // A nested mapping: re-parse the indented region as its own document.
      const region = collectRegion(lines, from, indent);
      if (region.text.trim().length === 0) return { kind: 'empty', lastIndex: from - 1 };
      const nested = parseFrontMatter(region.text, region.start);
      return { kind: 'mapping', entries: nested, lastIndex: region.lastIndex };
    }

    const value = stripComment(seq[2] as string).trim();
    const offset = line.start + line.text.indexOf(value, (seq[1] as string).length + 1);
    if (valueStart === -1) valueStart = value.length > 0 ? offset : line.start;
    items.push(unquote(value));
    end = line.start + line.text.length;
    last = i;
  }

  if (items.length === 0) return { kind: 'empty', lastIndex: from - 1 };
  return { kind: 'sequence', items, end, valueStart, lastIndex: last };
}

function collectRegion(
  lines: readonly SplitLine[],
  from: number,
  indent: number,
): { text: string; start: number; lastIndex: number } {
  let last = from - 1;
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] as SplitLine;
    if (line.text.trim().length === 0) {
      last = i;
      continue;
    }
    const lineIndent = line.text.length - line.text.trimStart().length;
    if (lineIndent <= indent) break;
    last = i;
  }
  if (last < from) return { text: '', start: 0, lastIndex: from - 1 };
  const start = (lines[from] as SplitLine).start;
  const stop = (lines[last] as SplitLine).end;
  const parts: string[] = [];
  for (let i = from; i <= last; i += 1) parts.push((lines[i] as SplitLine).text);
  return { text: parts.join('\n'), start, lastIndex: last };
  void stop;
}

/** Drops a trailing `#` comment, respecting quotes. */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t')) {
      return value.slice(0, i);
    }
  }
  return value;
}

function parseScalarOrFlow(value: string): string | string[] {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitFlow(inner).map(unquote);
  }
  return unquote(value);
}

/** Splits `a, "b, c", d` on commas that are not inside quotes. */
function splitFlow(value: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((part) => part.length > 0);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return value;
}
