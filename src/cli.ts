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

import { analyse, DEFAULT_PATTERNS, type AnalyseOptions } from './runner.js';
import { formatGraph, formatJson, formatReport, shouldUseAscii, shouldUseColor, type GraphFormat } from './report.js';
import { DEFAULT_SEVERITIES, resolveStrict, RULE_DESCRIPTIONS, RULE_IDS, RULE_QUERIES } from './rules.js';
import { formatRef } from './source.js';
import { execute, parseQuery, QueryError, renderMatch, type Match } from './select.js';
import type { RuleId, Severity, SpecNode } from './types.js';

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
  readonly format: 'human' | 'json';
  readonly graphFormat: GraphFormat;
  readonly severities: Partial<Record<RuleId, Severity>>;
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
  rules     List the built-in diagnostics.

OPTIONS
  --root <dir>            Directory the patterns resolve against (default: cwd)
  --ignore <glob>         Skip paths. Repeatable.
  --ignore-ref <glob>     Do not report these reference targets when they fail
                          to resolve, for repositories where [[...]] tags a
                          concept rather than naming a file. Repeatable.
                          Suppresses findings only, never edges.
  --format human|json     Report format (default: human)
  --graph-format <fmt>    dot, mermaid or json (default: dot)
  --documents-only        Leave items out of the exported graph
  --rule <id>=<severity>  Override one rule: error, warn, info or off. Repeatable.
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
  Relations:   -kind->  <-kind-   =kind=>  <=kind=   (= forms are transitive)

EXIT CODES
  0  clean
  1  findings at error severity (or over --max-warnings)
  2  the tool could not run

EXAMPLES
  spec-graph "docs/**/*.md"
  spec-graph check --rule self-reference=off --format json
  spec-graph query 'item[openness=open] -delegates-to-> document[phase=retired]'
  spec-graph check --ignore-ref "trap *"    # [[trap 55]] tags a concept, not a file
  spec-graph graph --documents-only --graph-format mermaid > graph.mmd
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
  const severities: Partial<Record<RuleId, Severity>> = {};
  let root = cwd;
  let format: 'human' | 'json' = 'human';
  let graphFormat: GraphFormat = 'dot';
  let color: boolean | null = null;
  let ascii: boolean | null = null;
  let verbose = false;
  let documentsOnly = false;
  let max = 0;
  let maxWarnings = -1;
  let strict = false;
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
      case '--format': {
        const value = next(arg, i);
        if (value !== 'human' && value !== 'json') {
          throw new UsageError(`--format must be human or json, got "${value}"`);
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
        const id = value.slice(0, equals) as RuleId;
        const level = value.slice(equals + 1) as Severity;
        if (!RULE_IDS.includes(id)) {
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

  if (command === 'query' && selector === null && !help && !version) {
    throw new UsageError('query needs a selector, for example:\n  spec-graph query \'item[openness=open]\'');
  }

  return {
    command,
    patterns,
    root,
    ignore,
    ignoreReferences,
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

  if (options.command === 'rules') {
    out(renderRules(options.verbose));
    return EXIT_OK;
  }

  // Strict is resolved before the run, so the rules themselves see the raised
  // severities and `result.ok` needs no special casing at the exit-code layer.
  const { severities, escalated } = resolveStrict(options.severities, options.strict);

  const analyseOptions: AnalyseOptions = {
    root: options.root,
    patterns: options.patterns.length > 0 ? options.patterns : DEFAULT_PATTERNS,
    ignore: options.ignore,
    ignoreReferences: options.ignoreReferences,
    severities,
  };

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
        out(renderMatches(matches, options.format, result.graph.nodes.size));
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
      out(
        options.format === 'json'
          ? formatJson(result, { escalated })
          : `${formatReport(result, { color, ascii, verbose: options.verbose, max: options.max, escalated })}\n`,
      );
      if (!result.ok) return EXIT_FAILED;
      if (options.maxWarnings >= 0 && result.summary.warnings > options.maxWarnings) return EXIT_FAILED;
      return EXIT_OK;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderRules(explain: boolean): string {
  const width = Math.max(...RULE_IDS.map((id) => id.length));
  const lines: string[] = [];
  for (const id of RULE_IDS) {
    lines.push(`${id.padEnd(width)}  ${DEFAULT_SEVERITIES[id].padEnd(5)}  ${RULE_DESCRIPTIONS[id]}`);
    const query = RULE_QUERIES[id];
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
