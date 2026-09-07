/**
 * Repository configuration.
 *
 * Three ADRs left the same open question: `--ignore-ref` patterns, include
 * globs and rule severities all belong to a repository rather than to whoever
 * typed the command, and an npm script was doing that job by accumulating
 * flags. A CI invocation carrying eight `--ignore-ref` arguments is a
 * configuration file that has not admitted what it is.
 *
 * The format is JSON, parsed with `JSON.parse`. That is not a shortcut - it is
 * the reason this file exists at all. spec-graph has no runtime dependencies,
 * and a YAML or TOML reader would be the largest thing in the package, to read
 * a file with nine keys in it.
 *
 * Every key mirrors a flag, and a flag always wins. Configuration is where a
 * team writes down what is true of the repository; a flag is where somebody
 * overrides it for one run.
 */

import { readFileSync } from 'node:fs';

import { RULE_IDS } from './rules.js';
import type { RuleId, Severity } from './types.js';

/** File names looked for, in order. The first that exists is the one used. */
export const CONFIG_FILES: readonly string[] = Object.freeze([
  '.spec-graph.json',
  'spec-graph.config.json',
]);

/** The `package.json` key read when no config file is present. */
export const CONFIG_PACKAGE_KEY = 'spec-graph';

export interface SpecGraphConfig {
  readonly patterns?: readonly string[] | undefined;
  readonly ignore?: readonly string[] | undefined;
  readonly ignoreReferences?: readonly string[] | undefined;
  /**
   * Families a bare identifier in prose may name.
   *
   * When set, `ADR-0099` is only ever read as a citation if `ADR` is listed.
   * Everything else in prose stays prose.
   */
  readonly families?: readonly string[] | undefined;
  /** Families that are never citations, whatever else the corpus contains. */
  readonly ignoreFamilies?: readonly string[] | undefined;
  /**
   * Files that are logs of what was decided rather than decisions themselves.
   *
   * Journals, changelogs, minutes. Their links are still checked; their
   * obligations and lifecycle are not. See ADR-0011.
   */
  readonly historyPatterns?: readonly string[] | undefined;
  /** Path to the accepted-debt baseline, relative to the root. See ADR-0012. */
  readonly baseline?: string | undefined;
  readonly severities?: Partial<Record<RuleId, Severity>> | undefined;
  readonly strict?: boolean | undefined;
  readonly maxRelated?: number | undefined;
}

export interface LoadedConfig {
  readonly config: SpecGraphConfig;
  /** Where it came from, for `--verbose` and for error messages. */
  readonly source: string | null;
  /** Keys that were present but unusable. Reported, never silently dropped. */
  readonly problems: readonly string[];
}

const EMPTY: LoadedConfig = { config: {}, source: null, problems: [] };

/**
 * Reads configuration from a directory.
 *
 * Never throws. A malformed config is reported as a problem and the run
 * continues with defaults: a broken config file should not stop a team seeing
 * the findings it was going to show them anyway.
 */
export function loadConfig(root: string, read: (path: string) => string = defaultRead): LoadedConfig {
  for (const name of CONFIG_FILES) {
    const raw = tryRead(read, `${root}/${name}`);
    if (raw === null) continue;
    return parseConfig(raw, name);
  }

  const pkg = tryRead(read, `${root}/package.json`);
  if (pkg === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkg);
  } catch {
    return EMPTY;
  }
  if (!isRecord(parsed)) return EMPTY;
  const section = parsed[CONFIG_PACKAGE_KEY];
  if (section === undefined) return EMPTY;
  if (!isRecord(section)) {
    return { config: {}, source: `package.json`, problems: [`"${CONFIG_PACKAGE_KEY}" must be an object`] };
  }
  return readFields(section, `package.json#${CONFIG_PACKAGE_KEY}`);
}

/** Parses config text. Exported so the shape can be tested without a disk. */
export function parseConfig(raw: string, source: string): LoadedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom(raw));
  } catch (error) {
    return { config: {}, source, problems: [`${source} is not valid JSON: ${(error as Error).message}`] };
  }
  if (!isRecord(parsed)) return { config: {}, source, problems: [`${source} must contain a JSON object`] };
  return readFields(parsed, source);
}

function readFields(raw: Record<string, unknown>, source: string): LoadedConfig {
  const problems: string[] = [];
  const config: {
    -readonly [K in keyof SpecGraphConfig]: SpecGraphConfig[K];
  } = {};

  const strings = (key: keyof SpecGraphConfig): readonly string[] | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      problems.push(`${source}: "${key}" must be an array of strings`);
      return undefined;
    }
    return value as string[];
  };

  config.patterns = strings('patterns');
  config.ignore = strings('ignore');
  config.ignoreReferences = strings('ignoreReferences');
  config.families = strings('families');
  config.ignoreFamilies = strings('ignoreFamilies');
  config.historyPatterns = strings('historyPatterns');

  if (raw['baseline'] !== undefined) {
    if (typeof raw['baseline'] !== 'string' || raw['baseline'].trim().length === 0) {
      problems.push(`${source}: "baseline" must be a path`);
    } else {
      config.baseline = raw['baseline'];
    }
  }

  if (raw['strict'] !== undefined) {
    if (typeof raw['strict'] !== 'boolean') problems.push(`${source}: "strict" must be true or false`);
    else config.strict = raw['strict'];
  }

  if (raw['maxRelated'] !== undefined) {
    const value = raw['maxRelated'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      problems.push(`${source}: "maxRelated" must be a non-negative whole number`);
    } else {
      config.maxRelated = value;
    }
  }

  if (raw['severities'] !== undefined) {
    const value = raw['severities'];
    if (!isRecord(value)) {
      problems.push(`${source}: "severities" must be an object of rule to severity`);
    } else {
      const severities: Partial<Record<RuleId, Severity>> = {};
      for (const [rule, level] of Object.entries(value)) {
        if (!RULE_IDS.includes(rule as RuleId)) {
          problems.push(`${source}: unknown rule "${rule}" in "severities"`);
          continue;
        }
        if (level !== 'error' && level !== 'warn' && level !== 'info' && level !== 'off') {
          problems.push(`${source}: "severities.${rule}" must be error, warn, info or off`);
          continue;
        }
        severities[rule as RuleId] = level;
      }
      config.severities = severities;
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${source}: unknown key "${key}"`);
  }

  return { config, source, problems };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'patterns',
  'ignore',
  'ignoreReferences',
  'families',
  'ignoreFamilies',
  'historyPatterns',
  'baseline',
  'severities',
  'strict',
  'maxRelated',
  // Tolerated so an editor can be pointed at a schema without being told off.
  '$schema',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryRead(read: (path: string) => string, path: string): string | null {
  try {
    return withoutBom(read(path));
  } catch {
    return null;
  }
}

/**
 * Drops a leading byte-order mark.
 *
 * `JSON.parse` rejects one, and several Windows editors write one by default -
 * a config that silently stops applying because of an invisible first character
 * is the worst kind of configuration bug.
 */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function defaultRead(path: string): string {
  return readFileSync(path, 'utf8');
}
