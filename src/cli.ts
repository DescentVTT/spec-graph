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

import { applyBaseline, EMPTY_BASELINE, formatBaseline, parseBaseline, type Baseline } from './baseline.js';
import { loadConfig, type SpecGraphConfig } from './config.js';
import { underRoot } from './glob.js';
import { analyse, DEFAULT_PATTERNS, withDiagnostics, type AnalyseOptions } from './runner.js';
import {
  formatGraph,
  formatJson,
  formatReport,
  formatSarif,
  shouldUseAscii,
  shouldUseColor,
  type GraphFormat,
} from './report.js';
import type { ProjectRule } from './project-rules.js';
import { DEFAULT_SEVERITIES, resolveStrict, RULE_DESCRIPTIONS, RULE_IDS, RULE_QUERIES } from './rules.js';
import { formatRef } from './source.js';
import { execute, parseQuery, QueryError, renderMatch, type Match } from './select.js';
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
  readonly format: 'human' | 'json' | 'sarif';
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
  spec-graph query <selector> [patterns...] [options]
  spec-graph graph [patterns...] [--graph-format dot|mermaid|json]
  spec-graph rules [--explain]

COMMANDS
  check     Validate the specification graph. The default.
  query     Run a selector and print the matching paths.
  graph     Export the graph for Graphviz, Mermaid, or another tool.
  rules     List the diagnostics that will run, built in and project.

OPTIONS
  --root <dir>            Directory the patterns resolve against (default: cwd)
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
  --format <fmt>          human, json, or sarif - the interchange format
                          GitHub code scanning and editors already read
                          (default: human)
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
  --verbose               Include parse problems and per-file detail
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
               ~= is a JavaScript regular expression, run once per node; ^= $=
               and *= cover most cases and cannot backtrack
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
  spec-graph check --rule project:no-draft-dependency=off
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
  let format: 'human' | 'json' | 'sarif' = 'human';
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
        if (value !== 'human' && value !== 'json' && value !== 'sarif') {
          throw new UsageError(`--format must be human, json or sarif, got "${value}"`);
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
  if (format === 'sarif' && command !== 'check' && !help && !version) {
    throw new UsageError(`--format sarif reports findings, so it belongs to check, not to ${command}`);
  }

  if (command === 'query' && selector === null && !help && !version) {
    throw new UsageError('query needs a selector, for example:\n  spec-graph query \'item[openness=open]\'');
  }

  return {
    command,
    patterns,
    root,
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
  const loaded = options.noConfig ? { config: {} as SpecGraphConfig, source: null, problems: [] } : loadConfig(options.root);
  for (const problem of loaded.problems) err(`spec-graph: ${problem}\n`);
  const file = loaded.config;
  const projectRules = file.rules ?? [];

  // A `--rule` naming a project rule that does not exist is a flag that
  // silently does nothing, and nothing in the output would distinguish that
  // from a rule that ran and found none.
  for (const id of Object.keys(options.severities)) {
    if (!isProjectRule(id as AnyRuleId) || projectRules.some((rule) => rule.id === id)) continue;
    const known = projectRules.map((rule) => rule.id);
    const where = known.length > 0 ? `project rules here: ${known.join(', ')}` : 'this repository defines no project rules';
    err(`spec-graph: unknown rule "${id}"\n  ${where}\n`);
    return EXIT_ERROR;
  }

  if (options.command === 'rules') {
    out(renderRules(options.verbose, projectRules));
    return EXIT_OK;
  }

  const patterns =
    options.patterns.length > 0 ? options.patterns : (file.patterns ?? DEFAULT_PATTERNS);
  const severityOverrides = { ...(file.severities ?? {}), ...options.severities };
  const { severities, escalated } = resolveStrict(
    severityOverrides,
    options.strict || (file.strict ?? false),
    projectRules,
  );

  const analyseOptions: AnalyseOptions = {
    root: options.root,
    patterns,
    ignore: [...(file.ignore ?? []), ...options.ignore],
    ignoreReferences: [...(file.ignoreReferences ?? []), ...options.ignoreReferences],
    families: [...(file.families ?? []), ...options.families],
    ignoreFamilies: [...(file.ignoreFamilies ?? []), ...options.ignoreFamilies],
    historyPatterns: [...(file.historyPatterns ?? []), ...options.historyPatterns],
    severities,
    projectRules,
    ...(file.maxRelated !== undefined ? { maxRelated: file.maxRelated } : {}),
  };

  if (options.verbose && loaded.source !== null) out(`configuration: ${loaded.source}\n`);

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
        options.patterns.length > 0 ? options.patterns.map((p) => `"${p}"`).join(', ') : 'the default patterns'
      }\n  looked under ${options.root}\n`,
    );
    return EXIT_ERROR;
  }

  switch (options.command) {
    case 'graph':
      out(formatGraph(result.graph, options.graphFormat, { documentsOnly: options.documentsOnly }));
      return EXIT_OK;

    case 'query': {
      try {
        const matches = execute(result.graph, parseQuery(options.selector as string));
        out(renderMatches(matches, options.format === 'json' ? 'json' : 'human', result.graph.nodes.size));
        return matches.length > 0 ? EXIT_OK : EXIT_FAILED;
      } catch (error) {
        if (error instanceof QueryError) {
          err(renderQueryError(options.selector as string, error));
          return EXIT_ERROR;
        }
        throw error;
      }
    }

    default: {
      // Recording is not checking. It writes down what is wrong today so that
      // tomorrow can be compared against it, and says nothing about whether
      // today is acceptable - so it reports what it wrote and exits clean.
      if (options.recordBaseline !== null) {
        const text = formatBaseline(result.graph, result.diagnostics);
        try {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(underRoot(options.root, options.recordBaseline), text, 'utf8');
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

      const source = options.baseline ?? file.baseline ?? null;
      const ratchet = options.ratchet || file.ratchet === true;
      let reported = result;
      let note: { source: string; suppressed: number; stale: number; ratchet: boolean } | undefined;
      if (source !== null) {
        const held = await readBaseline(underRoot(options.root, source), source);
        for (const problem of held.problems) err(`spec-graph: ${problem}\n`);
        const outcome = applyBaseline(result.graph, result.diagnostics, held.baseline);
        reported = withDiagnostics(result, outcome.kept);
        note = { source, suppressed: outcome.suppressed, stale: outcome.stale.length, ratchet };
        // Listed rather than counted when the run turns on them: a number is
        // enough to know the file has slack, and not enough to strike it. Never
        // in JSON, where the entries are already in the report and a stray line
        // on stdout is the difference between parsing and not.
        if (options.format === 'human' && (options.verbose || (ratchet && outcome.stale.length > 0))) {
          for (const entry of outcome.stale) {
            out(`  paid: ${entry.rule} ${entry.document}${entry.subject === '' ? '' : ` "${entry.subject}"`}\n`);
          }
        }
      }
      const looseBaseline = note !== undefined && note.ratchet && note.stale > 0;

      const baselineNote = note === undefined ? {} : { baseline: note };
      out(
        options.format === 'sarif'
          ? formatSarif(reported, reported.graph, { version: await readVersion(), escalated, projectRules })
          : options.format === 'json'
            ? formatJson(reported, { escalated, ...baselineNote })
            : `${formatReport(reported, { color, ascii, verbose: options.verbose, max: options.max, escalated, ...baselineNote })}\n`,
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

function renderRules(explain: boolean, projectRules: readonly ProjectRule[] = []): string {
  // A project rule is described by the selector it is, because that is what it
  // is - its message is a template, and a template is not a description.
  const rows: [string, Severity, string, string | undefined][] = [
    ...RULE_IDS.map((id): [string, Severity, string, string | undefined] => [
      id,
      DEFAULT_SEVERITIES[id],
      RULE_DESCRIPTIONS[id],
      RULE_QUERIES[id],
    ]),
    ...projectRules.map((rule): [string, Severity, string, string | undefined] => [
      rule.id,
      rule.severity,
      rule.sources[0] as string,
      rule.sources.slice(1).join(' | ') || undefined,
    ]),
  ];

  const width = Math.max(...rows.map(([id]) => id.length));
  const lines: string[] = [];
  for (const [id, severity, description, query] of rows) {
    lines.push(`${id.padEnd(width)}  ${severity.padEnd(5)}  ${description}`);
    if (explain && query) lines.push(`${' '.repeat(width)}         ${query}`);
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
