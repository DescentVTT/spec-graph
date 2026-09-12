/**
 * The command line.
 *
 * Four verbs, because there are four questions worth asking of a specification
 * graph: is it consistent (`check`), what does it contain (`query`), what does
 * it look like (`graph`), and what will you check for me (`rules`).
 *
 * Exit codes are the contract with CI: `0` clean, `1` findings, `2` the tool
 * itself could not run. A usage mistake never masquerades as a passing build.
 */

import {
  applyBaseline,
  EMPTY_BASELINE,
  formatBaseline,
  parseBaseline,
  type Baseline,
  type StaleEntry,
} from './baseline.js';
import { discoverConfig, loadConfig, type SpecGraphConfig } from './config.js';
import { isGlob, underRoot } from './glob.js';
import { analyse, DEFAULT_PATTERNS, withDiagnostics, type AnalyseOptions, type AnalysisResult } from './runner.js';
import {
  formatGraph,
  formatJson,
  formatMarkdown,
  formatReport,
  formatSarif,
  shouldUseAscii,
  shouldUseColor,
  type GraphFormat,
} from './report.js';
import type { ProjectRule } from './project-rules.js';
import {
  DEFAULT_SEVERITIES,
  resolveStrict,
  RULE_DECISIONS,
  RULE_DESCRIPTIONS,
  RULE_IDS,
  RULE_QUERIES,
} from './rules.js';
import { toPosix } from './paths.js';
import { formatRef } from './source.js';
import { execute, parseQuery, QueryError, renderMatch, type Match, type QuerySpec } from './select.js';
import { isProjectRule, type AnyRuleId, type RuleId, type Severity, type SpecNode } from './types.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Command = 'check' | 'query' | 'graph' | 'rules';

export interface CliOptions {
  readonly command: Command;
  readonly patterns: readonly string[];
  readonly root: string;
  /**
   * Whether `--root` was given.
   *
   * When it was, the caller has named the root and configuration is read from
   * exactly there. When it was not, the root is discovered - which is a
   * different question from what the root currently is. See ADR-0018.
   */
  readonly rootExplicit: boolean;
  readonly ignore: readonly string[];
  /** Reference targets to leave unreported when they do not resolve. */
  readonly ignoreReferences: readonly string[];
  /** Families a bare identifier may name. Empty means any family in the corpus. */
  readonly families: readonly string[];
  /** Families that are never citations. */
  readonly ignoreFamilies: readonly string[];
  /** Files that log what was decided rather than deciding it. */
  readonly historyPatterns: readonly string[];
  /** Accepted-debt file to read. `null` means none was asked for. */
  readonly baseline: string | null;
  /** Where to write the current findings as accepted debt. */
  readonly recordBaseline: string | null;
  /**
   * Fail when the baseline allows something that no longer happens.
   *
   * The other side of the ratchet, and off by default for the reason ADR-0012
   * gives: failing a build because somebody fixed something is a strange way to
   * encourage them. A team that has decided its debt only goes one way asks for
   * it explicitly, and then a dead exemption cannot outlive the defect.
   */
  readonly ratchet: boolean;
  /** Skip the repository configuration file entirely. */
  readonly noConfig: boolean;
  readonly format: 'human' | 'json' | 'sarif' | 'markdown';
  readonly graphFormat: GraphFormat;
  readonly severities: Partial<Record<AnyRuleId, Severity>>;
  readonly color: boolean | null;
  readonly ascii: boolean | null;
  readonly verbose: boolean;
  readonly documentsOnly: boolean;
  readonly max: number;
  readonly maxWarnings: number;
  /** Raise every warning to an error. Explicit `--rule` overrides still win. */
  readonly strict: boolean;
  readonly selector: string | null;
  readonly help: boolean;
  readonly version: boolean;
}

export interface CliIO {
  readonly argv?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly stdout?: ((text: string) => void) | undefined;
  readonly stderr?: ((text: string) => void) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly isTTY?: boolean | undefined;
}

export const HELP = `spec-graph - turn Markdown specifications into a verifiable graph

USAGE
  spec-graph [check] [patterns...] [options]
  spec-graph query <selector|project:rule> [patterns...] [options]
  spec-graph graph [patterns...] [--graph-format dot|mermaid|json]
  spec-graph rules [rule-id] [--explain]

COMMANDS
  check     Validate the specification graph. The default.
  query     Run a selector - or a registered project rule, by its id - and
            print the matching paths.
  graph     Export the graph for Graphviz, Mermaid, or another tool.
  rules     List the diagnostics that will run, built in and project. Name one
            to see only that one; --explain adds its selector and the ADR that
            decided it.

OPTIONS
  --root <dir>            Directory the patterns resolve against. Without it,
                          .spec-graph.json is looked for in the working
                          directory and then upward as far as the repository,
                          and the directory holding it becomes the root - so a
                          run from a subdirectory reports what a run from the
                          top reports. Paths typed on the command line stay
                          relative to where they were typed.
  --ignore <glob>         Skip paths. Repeatable.
  --ignore-ref <glob>     Do not report these reference targets when they fail
                          to resolve, for repositories where [[...]] tags a
                          concept rather than naming a file. Repeatable.
                          Suppresses findings only, never edges.
  --family <name>         Families a bare identifier in prose may name. When
                          given, everything else stays prose. Repeatable.
  --ignore-family <name>  Families that are never citations - RFC when the repo
                          cites RFC 2119 and keeps its own RFCs. Repeatable.
  --history <glob>        Files that log what was decided rather than deciding
                          it - journals, changelogs, minutes. Their links are
                          still checked; their obligations are not. Repeatable.
  --baseline <file>       Accept the findings recorded in this file and report
                          only what is new since. Missing file = accept nothing.
  --record-baseline <f>   Write today's findings to this file as accepted debt,
                          and exit 0 without judging them.
  --ratchet               Also fail when a baseline entry no longer occurs, so
                          a paid-off exemption cannot outlive the defect.
  --no-config             Ignore .spec-graph.json and the package.json key.
  --format <fmt>          human, json, sarif or markdown. sarif is the
                          interchange format GitHub code scanning and editors
                          already read; markdown is a table for a pull-request
                          comment or $GITHUB_STEP_SUMMARY (default: human)
  --graph-format <fmt>    dot, mermaid or json (default: dot)
  --documents-only        Leave items out of the exported graph
  --rule <id>=<severity>  Override one rule: error, warn, info or off. A project
                          rule is named in full: project:no-draft-dependency.
                          Repeatable.
  --max <n>               Show at most n findings (0 = no limit)
  --max-warnings <n>      Fail when warnings exceed n (default: no limit)
  --strict                Raise every warning to an error. An explicit --rule
                          still wins, so --strict --rule x=warn exempts x.
  --color / --no-color    Force colour on or off
  --ascii                 Use ASCII glyphs only
  --verbose               Include parse problems, per-file detail, and every
                          reference --ignore-ref or --ignore-family silenced
  -h, --help              Show this help
  -v, --version           Show the version

SELECTORS
  A selector is a path through the graph.

    item[openness=open] -delegates-to-> document[phase=retired]
    document[phase=active] -assumes-> document[phase=retired]
    document =supersedes=> document
    *[path^=docs/adr] -contains-> item[state=accepted-debt]

  Node types:  document, item, * (any)
  Attributes:  id, kind, title, path, file, line, phase, status, receptivity,
               alias, document, state (or disposition), openness, section,
               text, body, evidence, conflicted, fm.<front-matter-key>
  Operators:   = != ^= $= *= ~=   and [attr] for "is present"
               ~= is a regular expression, matched by an automaton that cannot
               backtrack: linear in the subject, whatever the pattern. It reads
               the usual syntax minus backreferences and lookaround, which are
               not regular - both are refused when the selector is read, with
               the character pointed at
  Relations:   -kind->  <-kind-   =kind=>  <=kind=   (= forms are transitive)

EXIT CODES
  0  clean
  1  findings at error severity (or over --max-warnings)
  2  the tool could not run

CONFIGURATION
  Anything repeated on every run belongs in the repository rather than in the
  command. spec-graph reads the first of these that exists:

    .spec-graph.json, spec-graph.config.json, or a "spec-graph" key in
    package.json

    { "patterns": ["docs/**/*.md"],
      "ignoreReferences": ["trap *"],
      "ignoreFamilies": ["RFC"],
      "historyPatterns": ["**/JOURNAL_*.md", "archive/**"],
      "baseline": ".spec-graph-baseline.json",
      "severities": { "self-reference": "off" },
      "strict": true }

  A flag always wins over the file, and list flags add to it rather than
  replacing it.

PROJECT RULES
  A convention spec-graph never anticipated is a selector plus a sentence, and
  belongs in the same file. Every rule declared here runs beside the built-ins
  and is reported, baselined, escalated by --strict and silenced by --rule in
  exactly the same way.

    { "rules": {
        "no-draft-dependency": {
          "query": "document[phase=active] -depends-on-> document[phase=draft]",
          "message": "{0} depends on {1}, which is still a draft",
          "hint": "wait for {1} to be accepted, or drop it from {0.path}",
          "severity": "error" } } }

  query     One selector, or a list of them read as a union.
  message   The headline. {0} is the first node on the path, {1} the next;
            {1.phase} and {0.fm.owner} read any selector attribute.
  hint      The next action. Optional, and templated the same way.
  severity  error, warn, info or off. Defaults to warn - a rule a team has
            just written has not yet earned the right to fail their build.

  The id is the name with project: in front, which is why it can never collide
  with a built-in. A selector that does not parse, or a {2} the query can never
  reach, is reported when the file is read rather than found missing later.

  To see what one matches without copying its selector out of the file:

    spec-graph query project:no-draft-dependency --verbose

ADOPTING THIS ON AN OLD REPOSITORY
  Record what is already wrong, then report only what happens next:

    spec-graph check --record-baseline .spec-graph-baseline.json
    git add .spec-graph-baseline.json

  The file is keyed by specification and citation, not by line number, so it
  survives edits, moves and renames. Findings that stop occurring are reported
  so the file can be tightened; nothing new gets in.

EXAMPLES
  spec-graph "docs/**/*.md"
  spec-graph check --rule self-reference=off --format json
  spec-graph query 'item[openness=open] -delegates-to-> document[phase=retired]'
  spec-graph check --ignore-ref "trap *"    # [[trap 55]] tags a concept, not a file
  spec-graph graph --documents-only --graph-format mermaid > graph.mmd
  spec-graph check --history "**/JOURNAL_*.md"   # a log is not a specification
  spec-graph check --baseline .spec-graph-baseline.json
  spec-graph rules --explain                # including this repository's own
  spec-graph rules ghost-handover --explain      # and why it exists
  spec-graph check --rule project:no-draft-dependency=off
  spec-graph query project:no-draft-dependency   # what does that rule match?
  spec-graph check --format markdown >> "$GITHUB_STEP_SUMMARY"
`;

const SEVERITIES: readonly Severity[] = ['error', 'warn', 'info', 'off'];

/** Parses argv into options. Throws {@link UsageError} on anything malformed. */
export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const args = [...argv];
  let command: Command = 'check';

  if (args.length > 0 && !((args[0] as string).startsWith('-'))) {
    const first = args[0] as string;
    if (first === 'check' || first === 'query' || first === 'graph' || first === 'rules') {
      command = first;
      args.shift();
    }
  }

  const patterns: string[] = [];
  const ignore: string[] = [];
  const ignoreReferences: string[] = [];
  const families: string[] = [];
  const ignoreFamilies: string[] = [];
  const historyPatterns: string[] = [];
  let noConfig = false;
  const severities: Partial<Record<AnyRuleId, Severity>> = {};
  let root = cwd;
  let rootExplicit = false;
  let format: 'human' | 'json' | 'sarif' | 'markdown' = 'human';
  let graphFormat: GraphFormat = 'dot';
  let color: boolean | null = null;
  let ascii: boolean | null = null;
  let verbose = false;
  let documentsOnly = false;
  let max = 0;
  let maxWarnings = -1;
  let strict = false;
  let baseline: string | null = null;
  let ratchet = false;
  let recordBaseline: string | null = null;
  let selector: string | null = null;
  let help = false;
  let version = false;

  const next = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;

    if (arg === '--') {
      patterns.push(...args.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      if (command === 'query' && selector === null) selector = arg;
      else patterns.push(arg);
      continue;
    }

    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--color':
        color = true;
        break;
      case '--no-color':
        color = false;
        break;
      case '--ascii':
        ascii = true;
        break;
      case '--documents-only':
        documentsOnly = true;
        break;
      case '--strict':
        strict = true;
        break;
      case '--ratchet':
        ratchet = true;
        break;
      case '--explain':
        verbose = true;
        break;
      case '--root':
        root = next(arg, i);
        rootExplicit = true;
        i += 1;
        break;
      case '--ignore':
        ignore.push(next(arg, i));
        i += 1;
        break;
      case '--ignore-ref':
        ignoreReferences.push(next(arg, i));
        i += 1;
        break;
      case '--family':
        families.push(next(arg, i));
        i += 1;
        break;
      case '--ignore-family':
        ignoreFamilies.push(next(arg, i));
        i += 1;
        break;
      case '--history':
        historyPatterns.push(next(arg, i));
        i += 1;
        break;
      case '--baseline':
        baseline = next(arg, i);
        i += 1;
        break;
      case '--record-baseline':
        recordBaseline = next(arg, i);
        i += 1;
        break;
      case '--no-config':
        noConfig = true;
        break;
      case '--format': {
        const value = next(arg, i);
        if (value !== 'human' && value !== 'json' && value !== 'sarif' && value !== 'markdown') {
          throw new UsageError(`--format must be human, json, sarif or markdown, got "${value}"`);
        }
        format = value;
        i += 1;
        break;
      }
      case '--graph-format': {
        const value = next(arg, i);
        if (value !== 'dot' && value !== 'mermaid' && value !== 'json') {
          throw new UsageError(`--graph-format must be dot, mermaid or json, got "${value}"`);
        }
        graphFormat = value;
        i += 1;
        break;
      }
      case '--rule': {
        const value = next(arg, i);
        const equals = value.indexOf('=');
        if (equals === -1) throw new UsageError(`--rule expects <id>=<severity>, got "${value}"`);
        const id = value.slice(0, equals) as AnyRuleId;
        const level = value.slice(equals + 1) as Severity;
        // A project rule is taken on its namespace here and checked for real
        // once the configuration defining it has been read: arguments are
        // parsed before any file is opened, and a flag has to be usable on that
        // first pass whatever the repository turns out to declare.
        if (!RULE_IDS.includes(id as RuleId) && !isProjectRule(id)) {
          throw new UsageError(`unknown rule "${id}"\n  known rules: ${RULE_IDS.join(', ')}`);
        }
        if (!SEVERITIES.includes(level)) {
          throw new UsageError(`unknown severity "${level}", expected one of: ${SEVERITIES.join(', ')}`);
        }
        severities[id] = level;
        i += 1;
        break;
      }
      case '--max': {
        max = parseCount(arg, next(arg, i));
        i += 1;
        break;
      }
      case '--max-warnings': {
        maxWarnings = parseCount(arg, next(arg, i));
        i += 1;
        break;
      }
      default:
        throw new UsageError(`unknown option "${arg}"\n  run "spec-graph --help" to see the available options`);
    }
  }

  // SARIF is a report about findings, and only `check` produces those. Falling
  // back to JSON would hand a pipeline something its uploader rejects with a
  // message about a schema rather than about the command that was run.
  if ((format === 'sarif' || format === 'markdown') && command !== 'check' && !help && !version) {
    throw new UsageError(`--format ${format} reports findings, so it belongs to check, not to ${command}`);
  }

  if (command === 'query' && selector === null && !help && !version) {
    throw new UsageError('query needs a selector, for example:\n  spec-graph query \'item[openness=open]\'');
  }

  return {
    command,
    patterns,
    root,
    rootExplicit,
    ignore,
    ignoreReferences,
    families,
    ignoreFamilies,
    historyPatterns,
    baseline,
    ratchet,
    recordBaseline,
    noConfig,
    format,
    graphFormat,
    severities,
    color,
    ascii,
    verbose,
    documentsOnly,
    max,
    maxWarnings,
    strict,
    selector,
    help,
    version,
  };
}

function count(n: number, word: string, many?: string): string {
  return `${n} ${n === 1 ? word : (many ?? `${word}s`)}`;
}

/**
 * Reads a baseline file.
 *
 * A missing file is not an error: `--baseline` against a repository that has
 * not recorded one yet should report everything, which is exactly what an empty
 * baseline does.
 */
async function readBaseline(path: string, source: string): Promise<ReturnType<typeof parseBaseline>> {
  let raw: string;
  try {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(path, 'utf8');
  } catch {
    return { baseline: EMPTY_BASELINE, problems: [] };
  }
  return parseBaseline(raw, source);
}

function parseCount(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new UsageError(`${flag} expects a non-negative whole number, got "${value}"`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Runs the CLI and returns the process exit code. Never throws. */
export async function main(io: CliIO = {}): Promise<number> {
  const argv = io.argv ?? process.argv.slice(2);
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const env = io.env ?? process.env;

  let options: CliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`spec-graph: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }

  if (options.help) {
    out(HELP);
    return EXIT_OK;
  }
  if (options.version) {
    out(`${await readVersion()}\n`);
    return EXIT_OK;
  }

  const color = options.color ?? shouldUseColor({ isTTY: io.isTTY, env });
  const ascii = options.ascii ?? shouldUseAscii({ env });

  // Configuration is what is true of the repository; a flag is somebody
  // overriding it for one run. So a flag always wins, and lists add rather than
  // replace - a `--ignore-ref` on the command line is one more exclusion, not a
  // decision to throw away the ones the repository already declared.
  //
  // Read before `rules` prints anything, so that command lists the conventions
  // this repository will actually check rather than the ones spec-graph ships.
  const loaded = options.noConfig
    ? { config: {} as SpecGraphConfig, source: null, problems: [], root: options.root }
    : options.rootExplicit
      ? { ...loadConfig(options.root), root: options.root }
      : discoverConfig(options.root);
  for (const problem of loaded.problems) err(`spec-graph: ${problem}\n`);
  const file = loaded.config;
  const projectRules = file.rules ?? [];
  const root = loaded.root;
  // How far the root moved up. Everything a repository declares about itself is
  // relative to the root; everything typed on the command line is relative to
  // where it was typed, and this is what keeps those two readings apart.
  const here = below(root, options.root);

  // A `--rule` naming a project rule that does not exist is a flag that
  // silently does nothing, and nothing in the output would distinguish that
  // from a rule that ran and found none.
  for (const id of Object.keys(options.severities)) {
    if (!isProjectRule(id as AnyRuleId) || projectRules.some((rule) => rule.id === id)) continue;
    err(`spec-graph: unknown rule "${id}"\n  ${knownProjectRules(projectRules)}\n`);
    return EXIT_ERROR;
  }

  if (options.command === 'rules') {
    // The one positional argument `rules` can take is a rule id: this command
    // reads no files, so a pattern here would be a word with nowhere to go.
    const wanted = options.patterns[0];
    if (wanted !== undefined && !RULE_IDS.includes(wanted as RuleId) && !projectRules.some((rule) => rule.id === wanted)) {
      err(
        `spec-graph: unknown rule "${wanted}"\n  known rules: ${RULE_IDS.join(', ')}\n  ${knownProjectRules(projectRules)}\n`,
      );
      return EXIT_ERROR;
    }
    out(renderRules(options.verbose, projectRules, wanted ?? null, loaded.source));
    return EXIT_OK;
  }

  const patterns =
    options.patterns.length > 0 ? options.patterns.map((pattern) => anchor(here, pattern)) : (file.patterns ?? DEFAULT_PATTERNS);
  const severityOverrides = { ...(file.severities ?? {}), ...options.severities };
  const { severities, escalated } = resolveStrict(
    severityOverrides,
    options.strict || (file.strict ?? false),
    projectRules,
  );

  const analyseOptions: AnalyseOptions = {
    root,
    patterns,
    // A bare name prunes a directory of that name at any depth, the way a
    // .gitignore line does, so it means the same thing wherever it was typed.
    // A path or a glob is matched against the repository-relative path, and
    // leaving that one alone would make it silently match nothing.
    ignore: [...(file.ignore ?? []), ...options.ignore.map((pattern) => anchorPath(here, pattern))],
    ignoreReferences: [...(file.ignoreReferences ?? []), ...options.ignoreReferences],
    families: [...(file.families ?? []), ...options.families],
    ignoreFamilies: [...(file.ignoreFamilies ?? []), ...options.ignoreFamilies],
    historyPatterns: [...(file.historyPatterns ?? []), ...options.historyPatterns.map((pattern) => anchorPath(here, pattern))],
    severities,
    projectRules,
    ...(file.maxRelated !== undefined ? { maxRelated: file.maxRelated } : {}),
  };

  // Named the way the reader would have to type it, because a discovered
  // configuration is often not the one in front of them.
  if (options.verbose && loaded.source !== null) {
    const depth = here === '' ? 0 : here.split('/').length;
    out(`configuration: ${'../'.repeat(depth)}${loaded.source}\n`);
  }

  let result;
  try {
    result = await analyse(analyseOptions);
  } catch (error) {
    err(`spec-graph: ${(error as Error).message}\n`);
    return EXIT_ERROR;
  }

  if (result.files.length === 0) {
    err(
      `spec-graph: no specifications matched ${
        patterns.map((p) => `"${p}"`).join(', ')
      }\n  looked under ${root}\n`,
    );
    return EXIT_ERROR;
  }

  switch (options.command) {
    case 'graph':
      out(formatGraph(result.graph, options.graphFormat, { documentsOnly: options.documentsOnly }));
      return EXIT_OK;

    case 'query': {
      const selector = options.selector as string;
      let queries: readonly QuerySpec[];

      // A registered rule is asked for by name, because by the time this runs
      // it is already compiled and the alternative is copying its selector out
      // of the configuration file by hand. The namespace cannot collide with
      // the grammar: no selector begins with a word and a colon. See ADR-0016.
      if (isProjectRule(selector as AnyRuleId)) {
        const rule = projectRules.find((candidate) => candidate.id === selector);
        if (rule === undefined) {
          err(`spec-graph: unknown rule "${selector}"\n  ${knownProjectRules(projectRules)}\n`);
          return EXIT_ERROR;
        }
        queries = rule.queries;
        if (options.verbose) for (const source of rule.sources) out(`${rule.id}: ${source}\n`);
      } else {
        try {
          queries = [parseQuery(selector)];
        } catch (error) {
          if (error instanceof QueryError) {
            err(renderQueryError(selector, error));
            return EXIT_ERROR;
          }
          throw error;
        }
      }

      const matches = union(result.graph, queries);
      out(renderMatches(matches, options.format === 'json' ? 'json' : 'human', result.graph.nodes.size));
      return matches.length > 0 ? EXIT_OK : EXIT_FAILED;
    }

    default: {
      // Recording is not checking. It writes down what is wrong today so that
      // tomorrow can be compared against it, and says nothing about whether
      // today is acceptable - so it reports what it wrote and exits clean.
      if (options.recordBaseline !== null) {
        const text = formatBaseline(result.graph, result.diagnostics);
        try {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(underRoot(root, anchor(here, options.recordBaseline)), text, 'utf8');
        } catch (error) {
          err(`spec-graph: cannot write ${options.recordBaseline}: ${(error as Error).message}\n`);
          return EXIT_ERROR;
        }
        const entries = (JSON.parse(text) as Baseline).findings.length;
        out(
          `recorded ${count(result.diagnostics.length, 'finding')} as ${count(entries, 'entry', 'entries')} in ${options.recordBaseline}\n`,
        );
        return EXIT_OK;
      }

      const source = options.baseline === null ? (file.baseline ?? null) : anchor(here, options.baseline);
      const ratchet = options.ratchet || file.ratchet === true;
      let reported = result;
      let note:
        | {
            source: string;
            suppressed: number;
            stale: number;
            ratchet: boolean;
            entries: readonly StaleEntry[];
          }
        | undefined;
      if (source !== null) {
        const held = await readBaseline(underRoot(root, source), source);
        for (const problem of held.problems) err(`spec-graph: ${problem}\n`);
        const outcome = applyBaseline(result.graph, result.diagnostics, held.baseline);
        reported = withDiagnostics(result, outcome.kept);
        note = {
          source,
          suppressed: outcome.suppressed,
          stale: outcome.stale.length,
          ratchet,
          entries: outcome.stale,
        };
        // Listed rather than counted when the run turns on them: a number is
        // enough to know the file has slack, and not enough to strike it. On
        // stdout only for a human - the structured formats carry the same rows
        // inside the document, where a stray line is the difference between
        // parsing and not.
        if (options.format === 'human' && (options.verbose || (ratchet && outcome.stale.length > 0))) {
          for (const entry of outcome.stale) {
            const subject = entry.subject === '' ? '' : ` "${entry.subject}"`;
            const why = entry.reason === 'gone' ? ` - ${entry.document} is not in this corpus` : '';
            out(`  ${entry.reason}: ${entry.rule} ${entry.document}${subject}${why}\n`);
          }
        }
      }
      const looseBaseline = note !== undefined && note.ratchet && note.stale > 0;

      const baselineNote = note === undefined ? {} : { baseline: note };
      const reporterOptions = { verbose: options.verbose, max: options.max, escalated, ...baselineNote };
      out(
        options.format === 'sarif'
          ? formatSarif(reported, reported.graph, { version: await readVersion(), escalated, projectRules })
          : options.format === 'json'
            ? formatJson(reported, { escalated, ...baselineNote })
            : options.format === 'markdown'
              ? formatMarkdown(reported, reporterOptions)
              : `${formatReport(reported, { color, ascii, ...reporterOptions })}\n`,
      );
      if (!reported.ok || looseBaseline) return EXIT_FAILED;
      if (options.maxWarnings >= 0 && reported.summary.warnings > options.maxWarnings) return EXIT_FAILED;
      return EXIT_OK;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the working directory sits below the root, or `''` when it is the root.
 *
 * Discovery only ever walks upward, so the root is always a prefix of the
 * directory the command was typed in, and this is a slice rather than path
 * arithmetic.
 */
function below(root: string, from: string): string {
  const start = toPosix(from).replace(/[/]+$/, '');
  return start.startsWith(`${root}/`) ? start.slice(root.length + 1) : '';
}

/**
 * Re-anchors a path typed in `prefix` so it reads from the root.
 *
 * An absolute path is left alone: it was not relative to anywhere, so moving
 * the root cannot change what it means.
 */
function anchor(prefix: string, value: string): string {
  if (prefix === '' || ABSOLUTE.test(value)) return value;
  return value.startsWith('!') ? `!${prefix}/${value.slice(1)}` : `${prefix}/${value}`;
}

const ABSOLUTE = /^(?:[/\\]|[A-Za-z]:)/;

/** The same, for an ignore, where a bare name is a directory at any depth. */
function anchorPath(prefix: string, pattern: string): string {
  return isGlob(pattern) || pattern.includes('/') ? anchor(prefix, pattern) : pattern;
}

function knownProjectRules(projectRules: readonly ProjectRule[]): string {
  const known = projectRules.map((rule) => rule.id);
  return known.length > 0 ? `project rules here: ${known.join(', ')}` : 'this repository defines no project rules';
}

/**
 * Runs a list of selectors as one result set.
 *
 * A project rule is a union of its selectors, and a path that two of them both
 * find is one path - the same dedupe `projectFindings` does, so that asking
 * this command what a rule matches answers with the set `check` reports on.
 */
function union(graph: AnalysisResult['graph'], queries: readonly QuerySpec[]): Match[] {
  if (queries.length === 1) return execute(graph, queries[0] as QuerySpec);
  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const spec of queries) {
    for (const match of execute(graph, spec)) {
      const key = match.nodes.map((node) => node.id).join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(match);
    }
  }
  return matches;
}

interface RuleRow {
  readonly id: string;
  readonly severity: Severity;
  readonly description: string;
  /** The selector, where the rule is one. */
  readonly query: string | undefined;
  /** Where the reasoning is: an ADR, or the file that declared the rule. */
  readonly decided: string;
}

function renderRules(
  explain: boolean,
  projectRules: readonly ProjectRule[] = [],
  only: string | null = null,
  configSource: string | null = null,
): string {
  // A project rule is described by the selector it is, because that is what it
  // is - its message is a template, and a template is not a description.
  const rows: RuleRow[] = [
    ...RULE_IDS.map((id): RuleRow => ({
      id,
      severity: DEFAULT_SEVERITIES[id],
      description: RULE_DESCRIPTIONS[id],
      query: RULE_QUERIES[id],
      decided: RULE_DECISIONS[id],
    })),
    ...projectRules.map((rule): RuleRow => ({
      id: rule.id,
      severity: rule.severity,
      description: rule.sources[0] as string,
      query: rule.sources.slice(1).join(' | ') || undefined,
      decided: configSource === null ? `rules.${rule.name}` : `${configSource}: rules.${rule.name}`,
    })),
  ];

  const shown = only === null ? rows : rows.filter((row) => row.id === only);
  const width = Math.max(...shown.map((row) => row.id.length));
  const lines: string[] = [];
  for (const row of shown) {
    lines.push(`${row.id.padEnd(width)}  ${row.severity.padEnd(5)}  ${row.description}`);
    if (!explain) continue;
    if (row.query) lines.push(`${' '.repeat(width)}         ${row.query}`);
    // Where the decision is written down, rather than a second copy of it. A
    // reader who has just been told their document is inconsistent is entitled
    // to know who decided that and why, and the ADR is the answer.
    lines.push(`${' '.repeat(width)}         ${row.decided}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderMatches(matches: readonly Match[], format: 'human' | 'json', total: number): string {
  if (format === 'json') {
    return `${JSON.stringify(
      {
        version: 1,
        count: matches.length,
        matches: matches.map((match) => ({
          nodes: match.nodes.map((node) => nodeSummary(node)),
          edges: match.edges.map((edge) => ({
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
            file: edge.declaredAt.file,
            line: edge.declaredAt.span.start.line,
          })),
        })),
      },
      null,
      2,
    )}\n`;
  }

  if (matches.length === 0) return `no matches (searched ${total} nodes)\n`;

  const lines: string[] = [];
  for (const match of matches) {
    const head = match.nodes[0] as SpecNode;
    const tail = match.nodes[match.nodes.length - 1] as SpecNode;
    lines.push(renderMatch(match));
    lines.push(`  ${formatRef(head.at)}${match.nodes.length > 1 ? `  ${formatRef(tail.at)}` : ''}`);
  }
  lines.push(`${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`);
  return `${lines.join('\n')}\n`;
}

function nodeSummary(node: SpecNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    file: node.at.file,
    line: node.at.span.start.line,
    ...(node.kind === 'document' ? { phase: node.phase } : { state: node.disposition, openness: node.openness }),
  };
}

/** Points at the exact character of a selector that failed to parse. */
function renderQueryError(selector: string, error: QueryError): string {
  const caret = `${' '.repeat(Math.max(0, error.offset))}^`;
  return `spec-graph: ${error.message}\n  ${selector}\n  ${caret}\n`;
}

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const url = new URL('../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(await readFile(url, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      return String((parsed as { version: unknown }).version);
    }
  } catch {
    // Fall through to the placeholder rather than failing `--version`.
  }
  return '0.0.0';
}
