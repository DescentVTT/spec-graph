/**
 * Document identity and reference normalisation.
 *
 * Foreign-key validation across a corpus of Markdown only works if `ADR-7`,
 * `ADR-0007`, `adr 7`, `[[0007-sharding]]` and `../adr/0007-sharding.md` are
 * understood to name the same document. Getting that wrong in either direction
 * is fatal: too strict and every real repository drowns in false "broken
 * reference" findings, too loose and `RFC 7` silently resolves to `ADR-7`.
 *
 * The resolution here is deliberately asymmetric. **Textual aliases** (`adr-7`)
 * are global, because a prefix already names the family. **Bare numbers** (`7`,
 * `#0007`) are resolved only within the citing document's own family, because a
 * repository with both `adr/0007` and `rfc/0007` is normal and guessing between
 * them would be worse than reporting nothing.
 */

/** Directory names that name a specification family, mapped to a canonical prefix. */
const FAMILY_DIRECTORIES: Readonly<Record<string, string>> = {
  adr: 'ADR',
  adrs: 'ADR',
  'architecture-decisions': 'ADR',
  'decision-records': 'ADR',
  decisions: 'ADR',
  rfc: 'RFC',
  rfcs: 'RFC',
  'text/rfcs': 'RFC',
  kep: 'KEP',
  keps: 'KEP',
  enhancements: 'KEP',
  proposal: 'PROPOSAL',
  proposals: 'PROPOSAL',
  design: 'DESIGN',
  designs: 'DESIGN',
  prd: 'PRD',
  prds: 'PRD',
  spec: 'SPEC',
  specs: 'SPEC',
};

/** Front-matter keys that may carry an explicit identifier, in preference order. */
export const ID_KEYS: readonly string[] = ['id', 'adr', 'adr-id', 'rfc', 'rfc-id', 'kep-number', 'number', 'slug'];

/** `ADR-0007`, `KEP 1234`, `rfc2119`: a family prefix followed by a number. */
const PREFIXED_ID = /^([A-Za-z][A-Za-z0-9_]{0,15}?)[\s._-]*(\d{1,6})$/;
/** A bare number, optionally hash-prefixed: `7`, `#0007`. */
const BARE_NUMBER = /^#?(\d{1,6})$/;

export interface DocumentIdentity {
  /** The canonical id: `ADR-0007`, or a path when nothing better exists. */
  readonly id: string;
  /** Family prefix, upper-cased. `null` when the document is not numbered. */
  readonly family: string | null;
  /** Sequence number without leading zeros. `null` when not numbered. */
  readonly number: number | null;
  /** Every lower-cased spelling that should resolve to this document. */
  readonly aliases: readonly string[];
}

export interface IdentityInput {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** An id declared by a directive or front matter, if any. */
  readonly declaredId: string | null;
  /** Extra aliases declared by a directive or front matter. */
  readonly declaredAliases: readonly string[];
  /** The document H1, if any. */
  readonly heading: string | null;
}

/**
 * Derives a document's canonical id and every alias that should reach it.
 *
 * Evidence is used in order of how deliberate it is: an explicit declaration,
 * then the file name, then the H1. Whatever loses still contributes aliases, so
 * a reference written in any of those forms still resolves.
 */
export function identify(input: IdentityInput): DocumentIdentity {
  const stem = fileStem(input.path);
  const directoryFamily = familyFromPath(input.path);
  const aliases = new Set<string>();

  const add = (value: string | null | undefined): void => {
    if (!value) return;
    const key = normaliseRef(value);
    if (key.length > 0) aliases.add(key);
  };

  const candidates: { family: string | null; number: number | null; label: string }[] = [];

  const consider = (raw: string | null, allowBare: boolean): void => {
    if (!raw) return;
    const cleaned = raw.trim();
    if (cleaned.length === 0) return;
    const prefixed = PREFIXED_ID.exec(cleaned);
    if (prefixed) {
      candidates.push({
        family: (prefixed[1] as string).toUpperCase(),
        number: Number.parseInt(prefixed[2] as string, 10),
        label: cleaned,
      });
      return;
    }
    const bare = BARE_NUMBER.exec(cleaned);
    if (bare && allowBare) {
      candidates.push({
        family: directoryFamily,
        number: Number.parseInt(bare[1] as string, 10),
        label: cleaned,
      });
      return;
    }
    candidates.push({ family: null, number: null, label: cleaned });
  };

  consider(input.declaredId, true);
  // `0007-sharding-the-write-path.md` and `kep-1234-foo.md` both start with the
  // identifier; take the leading token rather than the whole stem.
  consider(leadingToken(stem), true);
  consider(headingId(input.heading), false);

  const numbered = candidates.find((c) => c.number !== null);
  const family = numbered?.family ?? directoryFamily;
  const number = numbered?.number ?? null;

  let id: string;
  if (number !== null && family !== null) {
    id = `${family}-${padNumber(number, stem, input.declaredId)}`;
  } else if (input.declaredId) {
    id = input.declaredId.trim();
  } else if (number !== null) {
    id = String(number);
  } else {
    id = stem.length > 0 ? stem : input.path;
  }

  add(id);
  add(stem);
  add(input.path);
  add(stripExtension(input.path));
  add(input.declaredId);
  for (const alias of input.declaredAliases) add(alias);
  if (input.heading) add(headingId(input.heading));

  if (number !== null && family !== null) {
    // Every spelling a human might type. `normaliseRef` folds separators, so
    // `adr-7`, `adr 7` and `adr7` collapse to one key; the padding variants do
    // not, and each needs registering.
    for (const digits of numberSpellings(number, stem)) {
      add(`${family}-${digits}`);
    }
  }

  return { id, family, number, aliases: [...aliases] };
}

/**
 * Folds a reference to its lookup key.
 *
 * Case, separators and surrounding punctuation carry no meaning in a citation,
 * so `ADR-0007`, `adr 0007` and `Adr_0007` all become `adr0007`.
 */
export function normaliseRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[#<([]+|[)\]>.,;:]+$/g, '')
    .replace(/[\s._-]+/g, '')
    .trim();
}

/** Splits a `target#anchor` reference. */
export function splitAnchor(target: string): { target: string; anchor: string | null } {
  const hash = target.indexOf('#');
  if (hash === -1) return { target, anchor: null };
  // A leading `#` is an in-document anchor, not a separator.
  if (hash === 0) return { target: '', anchor: target.slice(1) };
  return { target: target.slice(0, hash), anchor: target.slice(hash + 1) };
}

/** Parses `ADR-0007` into its family and number, or returns `null`. */
export function parsePrefixedRef(value: string): { family: string; number: number } | null {
  const match = PREFIXED_ID.exec(value.trim().replace(/^[#([]+/, ''));
  if (!match) return null;
  return { family: (match[1] as string).toUpperCase(), number: Number.parseInt(match[2] as string, 10) };
}

/** Parses a bare `7` or `#0007`, or returns `null`. */
export function parseBareRef(value: string): number | null {
  const match = BARE_NUMBER.exec(value.trim());
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/** True when a reference target names a location rather than an identifier. */
export function looksLikePath(target: string): boolean {
  return target.includes('/') || /\.(md|markdown|mdx|txt|rst)$/i.test(target);
}

/** True when a reference target points outside the repository. */
export function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
}

/** The family prefix implied by a document's directory, if any. */
export function familyFromPath(posixPath: string): string | null {
  const segments = posixPath.toLowerCase().split('/');
  // Nearest enclosing directory wins: `docs/rfcs/adr/0007.md` is an ADR.
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const found = FAMILY_DIRECTORIES[segments[i] as string];
    if (found) return found;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function fileStem(posixPath: string): string {
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  // `docs/adr/0007-sharding/README.md` is identified by its directory.
  if (/^(readme|index)$/i.test(stem)) {
    const parent = posixPath.slice(0, posixPath.lastIndexOf('/'));
    return parent.slice(parent.lastIndexOf('/') + 1);
  }
  return stem;
}

function stripExtension(posixPath: string): string {
  const dot = posixPath.lastIndexOf('.');
  const slash = posixPath.lastIndexOf('/');
  return dot > slash ? posixPath.slice(0, dot) : posixPath;
}

/** `kep-1234-foo` -> `kep-1234`; `0007-sharding` -> `0007`; `sharding` -> `sharding`. */
function leadingToken(stem: string): string {
  const prefixed = /^([A-Za-z]{1,15}[\s._-]?\d{1,6})(?:[\s._-]|$)/.exec(stem);
  if (prefixed) return prefixed[1] as string;
  const bare = /^(\d{1,6})(?:[\s._-]|$)/.exec(stem);
  if (bare) return bare[1] as string;
  return stem;
}

/** `# ADR-0007: Sharding the write path` -> `ADR-0007`. */
function headingId(heading: string | null): string | null {
  if (!heading) return null;
  const match = /^\s*([A-Za-z]{1,15}[\s._-]?\d{1,6})\b/.exec(heading);
  return match ? (match[1] as string) : null;
}

/**
 * Chooses the digit width of the canonical id.
 *
 * A repository that writes `0007` everywhere should see `ADR-0007` in reports,
 * not `ADR-7`. The file name is the most reliable witness of the local
 * convention, so it decides.
 */
function padNumber(number: number, stem: string, declared: string | null): string {
  const fromDeclared = declared ? /(\d{1,6})/.exec(declared) : null;
  const fromStem = /(\d{1,6})/.exec(stem);
  const witness = (fromDeclared?.[1] ?? fromStem?.[1]) as string | undefined;
  const width = witness && Number.parseInt(witness, 10) === number ? witness.length : String(number).length;
  return String(number).padStart(width, '0');
}

/** Zero-padded spellings a citation might reasonably use. */
function numberSpellings(number: number, stem: string): string[] {
  const out = new Set<string>([String(number)]);
  const witness = /(\d{1,6})/.exec(stem);
  if (witness && Number.parseInt(witness[1] as string, 10) === number) out.add(witness[1] as string);
  for (const width of [3, 4]) out.add(String(number).padStart(width, '0'));
  return [...out];
}
