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

import { existsSync, readFileSync } from 'node:fs';

import { dirnamePosix, toPosix } from './paths.js';
import { compileProjectRules, type ProjectRule } from './project-rules.js';
import { RULE_IDS } from './rules.js';
import { isProjectRule, type AnyRuleId, type RuleId, type Severity } from './types.js';

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
  /** Fail when a baseline entry no longer occurs. See ADR-0012. */
  readonly ratchet?: boolean | undefined;
  readonly severities?: Partial<Record<AnyRuleId, Severity>> | undefined;
  readonly strict?: boolean | undefined;
  readonly maxRelated?: number | undefined;
  /**
   * Conventions this repository checks that spec-graph does not.
   *
   * A selector, a sentence and a severity. Compiled here rather than carried as
   * raw JSON, so a rule that cannot run is reported at load time next to every
   * other configuration problem - and not as a rule that quietly finds nothing.
   * See ADR-0016.
   */
  readonly rules?: readonly ProjectRule[] | undefined;
}

export interface LoadedConfig {
  readonly config: SpecGraphConfig;
  /** Where it came from, for `--verbose` and for error messages. */
  readonly source: string | null;
  /** Keys that were present but unusable. Reported, never silently dropped. */
  readonly problems: readonly string[];
}

export interface DiscoveredConfig extends LoadedConfig {
  /**
   * The directory the configuration was found in.
   *
   * This is the root of the run. Every path in spec-graph is relative to it -
   * node identities, baseline keys, SARIF locations - so the configuration file
   * naming the repository is the same statement as the repository having a
   * root. See ADR-0018.
   */
  readonly root: string;
}

/** Injected so discovery can be tested without a directory tree. */
export interface DiscoveryIO {
  readonly read?: ((path: string) => string) | undefined;
  readonly exists?: ((path: string) => boolean) | undefined;
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

/**
 * Finds the configuration by walking up from a directory.
 *
 * A monorepo is invoked from inside a package - `packages/auth`, or
 * `docs/architecture` - and reading configuration from the working directory
 * meant that the same repository checked differently depending on where
 * somebody stood in it. ADR-0010 worried that discovery would make a run
 * depend on where it started. It does the opposite: because the directory
 * holding the configuration becomes the root, a run from anywhere inside the
 * repository produces byte-identical output to a run from the top.
 *
 * The walk stops at the repository, which is a directory holding `.git`.
 * Above that is somebody else's checkout or a home directory, and a run that
 * silently picked up a configuration file nobody in the repository can see
 * would be worse than no discovery at all. See ADR-0018.
 */
export function discoverConfig(from: string, io: DiscoveryIO = {}): DiscoveredConfig {
  const read = io.read ?? defaultRead;
  const exists = io.exists ?? existsSync;
  const start = toPosix(from).replace(/\/+$/, '');

  let directory = start;
  for (;;) {
    const loaded = loadConfig(directory, read);
    if (loaded.source !== null) return { ...loaded, root: directory };
    if (exists(`${directory}/.git`)) break;
    const parent = dirnamePosix(directory);
    // Two guards for one job, and each makes the other unreachable: a path with
    // no separator left in it gives back `''`, and `''` gives back itself. Only
    // one of them can ever fire, which is why neither has a test - removing
    // either leaves the loop terminating on the other.
    if (parent === '' || parent === directory) break;
    directory = parent;
  }
  return { ...EMPTY, root: start };
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

  if (raw['ratchet'] !== undefined) {
    if (typeof raw['ratchet'] !== 'boolean') problems.push(`${source}: "ratchet" must be true or false`);
    else config.ratchet = raw['ratchet'];
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
      const severities: Partial<Record<AnyRuleId, Severity>> = {};
      for (const [rule, level] of Object.entries(value)) {
        // A project rule is named here by its full id, `project:no-drafts`, the
        // same spelling `--rule` takes and a report prints. Whether one exists
        // is checked below, once both halves of the file have been read.
        if (!RULE_IDS.includes(rule as RuleId) && !isProjectRule(rule as AnyRuleId)) {
          problems.push(`${source}: unknown rule "${rule}" in "severities"`);
          continue;
        }
        if (level !== 'error' && level !== 'warn' && level !== 'info' && level !== 'off') {
          problems.push(`${source}: "severities.${rule}" must be error, warn, info or off`);
          continue;
        }
        severities[rule as AnyRuleId] = level;
      }
      config.severities = severities;
    }
  }

  const compiled = raw['rules'] === undefined ? null : compileProjectRules(raw['rules'], source);
  if (compiled !== null) {
    problems.push(...compiled.problems);
    config.rules = compiled.rules;
  }

  // A severity naming a project rule that nothing defines is a line that will
  // never do anything, and reading like it does is the one thing a
  // configuration file must not be allowed to do.
  const defined = new Set<string>((compiled?.rules ?? []).map((rule) => rule.id));
  for (const rule of Object.keys(config.severities ?? {})) {
    if (!isProjectRule(rule as AnyRuleId) || defined.has(rule)) continue;
    problems.push(`${source}: "severities.${rule}" names no rule in "rules"`);
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
  'ratchet',
  'rules',
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
