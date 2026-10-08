/**
 * The command line.
 *
 * Five verbs, because there are five questions worth asking of a specification
 * graph: is it consistent (`check`), what does it contain (`query`), what does
 * it look like (`graph`), what will you check for me (`rules`), and what did a
 * change do to it (`diff`).
 *
 * Exit codes are the contract with CI: `0` clean, `1` findings, `2` the tool
 * itself could not run. A usage mistake never masquerades as a passing build,
 * and an error nothing here expected never as findings.
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
import {
  DiffInputError,
  diffExports,
  formatDiffJson,
  formatDiffMarkdown,
  formatDiffText,
  parseGraphExport,
  type GraphExport,
} from './diff.js';
import { isGlob, rebasePattern, underRoot } from './glob.js';
import { isFamilyName } from './identity.js';
import { analyse, DEFAULT_PATTERNS, withDiagnostics, type AnalyseOptions, type AnalysisResult } from './runner.js';
import {
  formatGithub,
  formatGitlab,
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
  decisionUrl,
  RULE_DESCRIPTIONS,
  RULE_IDS,
  RULE_QUERIES,
} from './rules.js';
import { isAbsolutePath, joinPosix, toPosix } from './paths.js';
import { formatRef } from './source.js';
import { execute, parseQuery, QueryError, renderMatch, type Match, type QuerySpec } from './select.js';
import { isProjectRule, type AnyRuleId, type RuleId, type Severity, type SpecNode } from './types.js';
import { displayWidth } from './vendor/spec-core/text/index.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Command = 'check' | 'query' | 'graph' | 'rules' | 'diff';

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
  readonly format: 'human' | 'json' | 'sarif' | 'markdown' | 'gitlab' | 'github';
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
  spec-graph diff <before.json> <after.json> [--format human|json|markdown]

COMMANDS
  check     Validate the specification graph. The default.
  query     Run a selector - or a registered project rule, by its id - and
            print the matching paths.
  graph     Export the graph for Graphviz, Mermaid, or another tool.
  rules     List the diagnostics that will run, built in and project. Name one
            to see only that one; --explain adds its selector and the ADR that
            decided it.
  diff      Compare two graph exports: documents added, removed, moved or
            accepted; relations added or removed; and obligations resolved or
            reopened where they can be told apart. Make both exports with the
            same spec-graph. Exits 0 whether anything changed or not.

OPTIONS
  --root <dir>            Directory the patterns resolve against. Without it,
                          .spec-graph.json is looked for in the working
                          directory and then upward as far as the repository,
                          and the directory holding it becomes the root - so a
                          run from a subdirectory reports what a run from the
                          top reports. Paths typed on the command line stay
                          relative to where they were typed. It has to be a
                          directory that is there.
  --ignore <glob>         Skip paths. Repeatable.
  --ignore-ref <glob>     Do not report these reference targets when they fail
                          to resolve, for repositories where [[...]] tags a
                          concept rather than naming a file. Repeatable.
                          Suppresses findings only, never edges.
  --family <name>         Families a bare identifier in prose may name. When
                          given, everything else stays prose. Repeatable: one
                          name each time, the prefix its identifiers are
                          written with, ADR for ADR-0007. A document here has
                          to belong to one of them, or the check stops: a list
                          that names none allows nothing.
  --ignore-family <name>  Families that are never citations - RFC when the repo
                          cites RFC 2119 and keeps its own RFCs. Repeatable,
                          one name each time.
  --history <glob>        Files that log what was decided rather than deciding
                          it - journals, changelogs, minutes. Their links are
                          still checked; their obligations are not. Repeatable.
  --baseline <file>       Accept the findings recorded in this file and report
                          only what is new since. The file has to be there: a
                          path that reads nothing accepts nothing and says so
                          nowhere. A "baseline" in the configuration may name a
                          file not recorded yet; a path typed here may not.
  --record-baseline <f>   Write today's findings to this file as accepted debt,
                          and exit 0 without judging them.
  --ratchet               Also fail when a baseline entry no longer occurs, so
                          a paid-off exemption cannot outlive the defect.
  --no-config             Ignore .spec-graph.json and the package.json key.
  --format <fmt>          human, json, sarif, github, gitlab or markdown. json
                          is for check, query or diff. sarif is the interchange
                          format GitHub code scanning and editors already read,
                          github the workflow commands a GitHub Actions log
                          turns into annotations, and gitlab the Code Quality
                          report a GitLab merge request reads, all three for
                          check; markdown is a table for a pull-request comment
                          or $GITHUB_STEP_SUMMARY, for check or diff (default:
                          human)
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
  --ascii                 Use ASCII glyphs only. SPEC_GRAPH_ASCII asks for the
                          same, unless it is empty, 0 or false
  --verbose               Include parse problems, per-file detail, and every
                          reference --ignore-ref or --ignore-family silenced
  --explain               With rules: add each rule's selector and the ADR
                          that decided it
  -h, --help              Show this help
  -v, --version           Show the version

  An option belongs to the commands that read it, and any other command
  refuses it by name:

    --root, --verbose                   check, query, graph, rules
    --ignore, --history                 check, query, graph
    --format                            check, query, diff
    --graph-format, --documents-only    graph
    --explain                           rules
    every other option                  check

  --no-config, --no-color and --ascii are taken by every command: each is
  true already of a command with nothing to read it for.

  A value that begins with -- reads as an option, so the option before it is
  refused as missing its value. A name that does begin so is written ./--name
  for a file, [-]-name in a pattern and \\--name for a reference target.

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

  An input that is set and names nothing is a 2, named on stderr, and never
  read as if it had not been given: an empty value, a family name no family
  has, a list of families no document here belongs to, a --root that is no
  directory, a second word after rules, an option of another command.

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
      "strict": true,
      "maxRelated": 3 }

  A flag always wins over the file, and list flags add to it rather than
  replacing it. maxRelated has no flag: it caps how many related locations one
  finding lists, 8 unless set, and 0 lists none.

  A problem in that file stops the run with exit 2, named on stderr: invalid
  JSON, an unknown key, a rule that does not compile, a file that is there and
  cannot be read. A configuration that did not load checks a different
  repository than the one configured, and would report that one as consistent.
  --no-config runs on defaults instead.

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
  spec-graph check --format github             # annotations from an Actions log
  spec-graph check --format gitlab > gl-code-quality-report.json
  spec-graph diff base.json head.json --format markdown >> "$GITHUB_STEP_SUMMARY"
`;

const SEVERITIES: readonly Severity[] = ['error', 'warn', 'info', 'off'];

/**
 * The commands that read an option, or nothing for one every command takes.
 *
 * Any other command refuses the option, rather than run as if it were not
 * there: `query --strict` taking the flag and doing nothing with it would
 * tell someone their query was strict, `graph --record-baseline` wrote no
 * file and said so nowhere, and `spec-graph --graph-format mermaid`, the
 * command forgotten, wrote the check's report into what was meant to hold a
 * graph. The three options about citations are a check's alone: they pass
 * over findings and never an edge, so a graph or a query is the same with
 * them as without.
 *
 * `--no-color`, `--ascii` and `--no-config` are taken by every command.
 * Each is true already of what the commands that do not read it write - none
 * of them colours or draws a glyph, and `diff` reads no configuration - and
 * a script passes them to every command it runs. `--color` is not one of
 * them: it would promise colour that only a check prints.
 *
 * A function and not a table, so that none of it runs when the module loads:
 * a mutant of a table built at import pays for the whole suite (ADR-0007).
 */
function readersOf(option: string): readonly Command[] | undefined {
  switch (option) {
    case '--root':
    case '--verbose':
      return ['check', 'query', 'graph', 'rules'];
    case '--ignore':
    case '--history':
      return ['check', 'query', 'graph'];
    case '--format':
      return ['check', 'query', 'diff'];
    case '--graph-format':
    case '--documents-only':
      return ['graph'];
    case '--explain':
      return ['rules'];
    case '--ignore-ref':
    case '--family':
    case '--ignore-family':
    case '--baseline':
    case '--record-baseline':
    case '--ratchet':
    case '--rule':
    case '--strict':
    case '--max':
    case '--max-warnings':
    case '--color':
      return ['check'];
  }
  return undefined;
}

/** `a`, `a or b`, `a, b or c`: one name or more in a sentence, with the word that joins the last. */
function listed(names: readonly string[], joint: string): string {
  return names.length < 2 ? (names[0] as string) : `${names.slice(0, -1).join(', ')} ${joint} ${names[names.length - 1] as string}`;
}

/** Parses argv into options. Throws {@link UsageError} on anything malformed. */
export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const args = [...argv];
  let command: Command = 'check';

  const first = args[0];
  if (first === 'check' || first === 'query' || first === 'graph' || first === 'rules' || first === 'diff') {
    command = first;
    args.shift();
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
  let format: CliOptions['format'] = 'human';
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

  // In the order they were given, so the first that does not belong is the
  // one named. A set keeps that order, and starts from no literal: a list
  // seeded with a word no option is called would refuse nothing more, which
  // is a mutant no test can tell from the code.
  const given = new Set<string>();
  const next = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    // The option after one whose value was forgotten. Taken as the value,
    // `--ignore --strict` ignored a directory called `--strict` and the check
    // was not strict, and `--record-baseline --verbose` wrote a file of that
    // name. A name that does begin with two dashes has another spelling
    // wherever one can be meant: `./--x` for a file, `[-]-x` in a pattern,
    // `\--x` for a reference target.
    if (value.startsWith('--') || value === '-h' || value === '-v') {
      throw new UsageError(`${flag} needs a value, and ${value} reads as an option`);
    }
    return value;
  };
  // A blank value is what an unset variable leaves in `--root "$DIR"`. A path
  // made of it names the directory beside it or a file called " ", and the run
  // then answered for a place nobody named.
  const filled = (flag: string, index: number, what: string): string => {
    const value = next(flag, index);
    if (value.trim() === '') throw new UsageError(`${flag} expects ${what}, got "${value}"`);
    return value;
  };
  // A family is taken once per option. A blank, `ADR,RFC` or the option typed
  // after it is a name no family has: alone on the allowlist it left every
  // citation as prose, and the check passed over the ones that dangle.
  const family = (flag: string, index: number): string => {
    const value = next(flag, index);
    if (!isFamilyName(value)) throw new UsageError(`${flag} expects one family's name, such as ADR, got "${value}"`);
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

    given.add(arg);
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
        root = filled(arg, i, 'a directory');
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
        families.push(family(arg, i));
        i += 1;
        break;
      case '--ignore-family':
        ignoreFamilies.push(family(arg, i));
        i += 1;
        break;
      case '--history':
        historyPatterns.push(next(arg, i));
        i += 1;
        break;
      case '--baseline':
        baseline = filled(arg, i, 'a file');
        i += 1;
        break;
      case '--record-baseline':
        recordBaseline = filled(arg, i, 'a file');
        i += 1;
        break;
      case '--no-config':
        noConfig = true;
        break;
      case '--format': {
        const value = next(arg, i);
        if (
          value !== 'human' &&
          value !== 'json' &&
          value !== 'sarif' &&
          value !== 'markdown' &&
          value !== 'gitlab' &&
          value !== 'github'
        ) {
          throw new UsageError(`--format must be human, json, sarif, markdown, gitlab or github, got "${value}"`);
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

  // SARIF, GitHub's workflow commands and GitLab's Code Quality are reports
  // about findings, and only `check` produces those. Falling back to JSON would
  // hand a pipeline something its uploader rejects with a message about a
  // schema rather than about the command that was run. Markdown is for a pull
  // request, which reads a check or a diff.
  if ((format === 'sarif' || format === 'gitlab' || format === 'github') && command !== 'check' && !help && !version) {
    throw new UsageError(`--format ${format} reports findings, so it belongs to check, not to ${command}`);
  }
  if (format === 'markdown' && command !== 'check' && command !== 'diff' && !help && !version) {
    throw new UsageError(`--format markdown is a report for a pull request, so it belongs to check or diff, not to ${command}`);
  }

  // JSON is refused where the other reports are, and for the reason above:
  // `graph --format json` wrote DOT and `rules --format json` a list, each
  // with exit 0, to whatever was waiting for JSON.
  if (format === 'json' && (command === 'graph' || command === 'rules') && !help && !version) {
    const instead = command === 'graph' ? 'graph writes JSON with --graph-format json' : 'rules lists the rules as text';
    throw new UsageError(`--format json belongs to check, query or diff, not to ${command}: ${instead}`);
  }

  if (!help && !version) {
    for (const option of given) {
      const readers = readersOf(option);
      if (readers !== undefined && !readers.includes(command)) {
        throw new UsageError(`${option} belongs to ${listed(readers, 'or')}, not to ${command}`);
      }
    }
  }

  // The second word given to `rules` was dropped, so `rules a b` listed `a`
  // and said nothing of `b`.
  if (command === 'rules' && patterns.length > 1 && !help && !version) {
    throw new UsageError(`rules takes one rule id, got ${patterns.length}: ${patterns.join(', ')}`);
  }

  if (command === 'diff' && patterns.length !== 2 && !help && !version) {
    throw new UsageError(
      'diff compares two graph exports, for example:\n  spec-graph diff base.json head.json\n  (make each with spec-graph graph --graph-format json)',
    );
  }

  // An empty name resolved to the directory the run was started in, and the
  // refusal was the read's: `cannot read : EISDIR`.
  const blank = patterns.findIndex((path) => path.trim() === '');
  if (command === 'diff' && blank !== -1 && !help && !version) {
    throw new UsageError(`diff expects a graph export on each side, got "${patterns[blank] as string}" for the ${blank === 0 ? 'first' : 'second'}`);
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

interface HeldBaseline {
  readonly baseline: Baseline;
  readonly problems: readonly string[];
  /** What stopped the file being read, when something did. */
  readonly unread: { readonly missing: boolean; readonly message: string } | null;
}

/**
 * Reads a baseline file.
 *
 * Absent and unreadable are different answers, and the caller needs both. A
 * repository that has not recorded a baseline yet declares the path before the
 * file exists, and an empty baseline accepts nothing, which is what that run
 * should report (ADR-0012). Anything else - a directory, a permission, a path
 * that went somewhere unintended - is the tool failing to do what it was told.
 */
async function readBaseline(path: string, source: string): Promise<HeldBaseline> {
  let raw: string;
  try {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const failure = error as Error & { code?: string };
    return {
      baseline: EMPTY_BASELINE,
      problems: [],
      unread: { missing: failure.code === 'ENOENT', message: failure.message },
    };
  }
  return { ...parseBaseline(raw, source), unread: null };
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

/**
 * Runs the CLI and returns the process exit code. Never throws.
 *
 * An error nothing below expected is neither a finding nor a usage mistake:
 * the answer cannot be trusted, which is the family contract's 2 (spec-core's
 * ADR-0005). Rejected instead, it reached the launcher as Node's uncaught
 * error, exit 1, which CI reads as findings. The stack is what makes a report
 * of it something to act on, and it goes to stderr alone: a script that reads
 * a document from stdout is handed no part of one.
 *
 * A write its reader had closed the pipe for is not such an error: the answer
 * was not delivered, which is still 2, and nothing in spec-graph is at fault,
 * so it is said in a line and no stack sends a person looking for a defect.
 * The process's own streams report it as an event, which the launcher answers
 * in the same words; here it is a caller's stream that throws it. It is read
 * by its code: stdout and stderr are the only pipes spec-graph writes to.
 */
export async function main(io: CliIO = {}): Promise<number> {
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  try {
    return await run(io, err);
  } catch (error) {
    if (!(error instanceof Error)) err(`spec-graph: unexpected error: ${String(error)}\n`);
    else if ((error as { code?: unknown }).code === 'EPIPE') err('spec-graph: stdout was closed before all of the output was written\n');
    else err(`spec-graph: unexpected error: ${error.stack ?? error.message}\n`);
    return EXIT_ERROR;
  }
}

/** One run of the command line, which rejects on an error it did not expect. */
async function run(io: CliIO, err: (text: string) => void): Promise<number> {
  const argv = io.argv ?? process.argv.slice(2);
  const cwd = io.cwd ?? process.cwd();
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const env = io.env ?? process.env;

  let options: CliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    // parseArgs throws nothing but a UsageError for any argv, so no test can
    // tell this check from `true`: the rethrow is for a bug in the parser.
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

  // A diff reads two files and nothing else: no configuration and no corpus, so
  // it can compare exports from a checkout it is not running in.
  if (options.command === 'diff') return runDiff(options.patterns as readonly [string, string], cwd, options.format, out, err);

  // A root that was named is a directory, for every command that reads one.
  // `rules --root` with a path that is not there listed the built-in rules and
  // exited 0, as if the repository declared none, and the others said only
  // that no specification matched under it.
  if (options.rootExplicit) {
    const { stat } = await import('node:fs/promises');
    // A path that cannot be reached reads as one that is not there: either
    // way there is nothing under it to read.
    const found = await stat(options.root).catch(() => null);
    if (found === null || !found.isDirectory()) {
      err(`spec-graph: --root "${options.root}" is not ${found === null ? 'there' : 'a directory'}\n`);
      return EXIT_ERROR;
    }
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
  // A configuration that did not load means a run against a different
  // repository than the one configured - other patterns, other rules, other
  // severities - and the verdict printed is about that one. Reporting the
  // problem and carrying on gave a green build with `ok: true` from a file with
  // a typo in it, which is the one answer a checker must never reach by
  // accident, and the same mistake in a `--rule` has always exited 2. The
  // findings are one flag away, and the flag is named. Amends ADR-0010.
  if (loaded.problems.length > 0) {
    err(
      `spec-graph: ${count(loaded.problems.length, 'problem')} in the configuration, so nothing was checked\n  fix it, or run again with --no-config to check on defaults\n`,
    );
    return EXIT_ERROR;
  }
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
    out(renderRules(options.verbose, await readVersion(), projectRules, wanted ?? null, loaded.source));
    return EXIT_OK;
  }

  // Named the way the reader would have to type it, because a discovered
  // configuration is often not the one in front of them.
  //
  // On stderr, with everything else this run says about itself. stdout is the
  // report, and in three of the four formats it is a document: a line above it
  // made `--verbose --format json` unparseable and handed `--format sarif` to a
  // code-scanning uploader that rejects it over a schema.
  if (options.verbose && loaded.source !== null) err(`configuration: ${fromHere(here, loaded.source)}\n`);

  // A bare `--ignore` name prunes a directory of that name at any depth, the
  // way a .gitignore line does, so it means the same thing wherever it was
  // typed. Every other pattern is matched against the repository-relative
  // path, a bare `--history` name included, and leaving one alone would make
  // it silently match something else or nothing. A pattern that cannot be
  // rebased onto the root stops the run as one the dialect refuses does,
  // named as it was typed.
  let typed;
  try {
    typed = {
      patterns: options.patterns.map((pattern) => anchor(here, pattern)),
      ignore: options.ignore.map((pattern) => anchorPath(here, pattern)),
      history: options.historyPatterns.map((pattern) => anchor(here, pattern)),
    };
  } catch (error) {
    err(`spec-graph: ${(error as Error).message}\n`);
    return EXIT_ERROR;
  }
  const patterns = typed.patterns.length > 0 ? typed.patterns : (file.patterns ?? DEFAULT_PATTERNS);
  const severityOverrides = { ...(file.severities ?? {}), ...options.severities };
  const { severities, escalated } = resolveStrict(
    severityOverrides,
    options.strict || (file.strict ?? false),
    projectRules,
  );

  // The list the check is held against, once it has read the documents.
  const families = [...(file.families ?? []), ...options.families];
  const analyseOptions: AnalyseOptions = {
    root,
    patterns,
    // A stray entry in one of the empty fallbacks here changes a run only if
    // it matches a path or a target some corpus has, so the mutants that plant
    // one survive every corpus but one built for them - except in the two
    // lists of families, where what they plant is no family's name and is
    // refused.
    ignore: [...(file.ignore ?? []), ...typed.ignore],
    ignoreReferences: [...(file.ignoreReferences ?? []), ...options.ignoreReferences],
    families,
    ignoreFamilies: [...(file.ignoreFamilies ?? []), ...options.ignoreFamilies],
    historyPatterns: [...(file.historyPatterns ?? []), ...typed.history],
    severities,
    projectRules,
    maxRelated: file.maxRelated,
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
        patterns.map((p) => `"${p}"`).join(', ')
      }\n  looked under ${root}\n`,
    );
    return EXIT_ERROR;
  }

  switch (options.command) {
    case 'graph':
      out(
        formatGraph(result.graph, options.graphFormat, {
          documentsOnly: options.documentsOnly,
          generator: { name: 'spec-graph', version: await readVersion() },
        }),
      );
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
        // Beside the report rather than inside it, for the reason the
        // configuration line above is: `--format json` is a document.
        if (options.verbose) for (const source of rule.sources) err(`${rule.id}: ${source}\n`);
      } else {
        try {
          queries = [parseQuery(selector)];
        } catch (error) {
          // Every selector that fails to parse fails as a QueryError, so no
          // test can tell this check from `true`.
          if (error instanceof QueryError) {
            err(renderQueryError(selector, error));
            return EXIT_ERROR;
          }
          throw error;
        }
      }

      const matches = union(result.graph, queries);
      // renderMatches asks only whether this is 'json', so the other word is a
      // name for the reader and emptying it changes nothing.
      out(renderMatches(matches, options.format === 'json' ? 'json' : 'human', result.graph.nodes.size));
      return matches.length > 0 ? EXIT_OK : EXIT_FAILED;
    }

    default: {
      // An allowlist is held against the corpus it was written for. One that
      // names no family a document here belongs to allows nothing the corpus
      // has: every citation is then prose, and the run that failed on a
      // dangling one reported a consistent graph - for `--family ADRS` as it
      // did for `--family ""`. Nothing was measured, which is not clean
      // (spec-core's ADR-0005), so the run stops before it says anything. A
      // list that names such a family beside one the corpus has is a family
      // the repository means to start, or a typo in half of it: said, and
      // nothing fails.
      const allowed = [...new Set(families.map((family) => family.trim().toUpperCase()))];
      const absent = allowed.filter((family) => !result.corpus.families.includes(family));
      if (absent.length > 0) {
        const lists: string[] = [];
        if (options.families.length > 0) lists.push('--family');
        if (file.families !== undefined && file.families.length > 0) lists.push(`"families" in ${loaded.source}`);
        const here = `the documents here belong to ${result.corpus.families.length > 0 ? listed(result.corpus.families, 'and') : 'no family'}`;
        if (absent.length === allowed.length) {
          err(
            `spec-graph: no document here belongs to a family named by ${lists.join(' and ')} (${allowed.join(', ')}); ${here}\n  name a family the documents belong to, or leave the list out\n`,
          );
          return EXIT_ERROR;
        }
        err(`spec-graph: no document here belongs to ${listed(absent, 'or')}, named by ${lists.join(' and ')}; ${here}\n`);
      }

      // Recording is not checking. It writes down what is wrong today so that
      // tomorrow can be compared against it, and says nothing about whether
      // today is acceptable - so it reports what it wrote and exits clean.
      if (options.recordBaseline !== null) {
        const text = formatBaseline(result.graph, result.diagnostics);
        try {
          const { writeFile } = await import('node:fs/promises');
          // Node writes a string as UTF-8 when the encoding is empty too, so
          // emptying this literal writes the same bytes.
          await writeFile(underRoot(root, anchorFile(here, options.recordBaseline)), text, 'utf8');
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

      const source = options.baseline === null ? (file.baseline ?? null) : anchorFile(here, options.baseline);
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
      let recordAs: string | undefined;
      if (source !== null) {
        const held = await readBaseline(underRoot(root, source), source);
        // A path typed on the command line says the file is there for this run.
        // Read as an empty baseline instead, a typo in it reports every accepted
        // finding as new, and passes --ratchet with nothing left to be stale.
        // A path in the configuration is the case ADR-0012 argued for, and only
        // where the file is absent: unreadable is unreadable wherever the path
        // was written.
        if (held.unread !== null && (options.baseline !== null || !held.unread.missing)) {
          err(`spec-graph: cannot read the baseline ${source}: ${held.unread.message}\n`);
          return EXIT_ERROR;
        }
        // Quiet by default, because a configured path legitimately precedes the
        // first --record-baseline. Under --verbose, where parse problems already
        // go, a path that reads nothing says so rather than accepting nothing.
        if (held.unread !== null && options.verbose) {
          err(`spec-graph: baseline ${source} is not there, so nothing is accepted\n`);
        }
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
        // The command that re-records it is typed where this run was: a path
        // typed on this command line is relative to there already, and the
        // configuration's is from the root.
        recordAs = options.baseline ?? fromHere(here, source);
        // Listed rather than counted when the run turns on them: a number is
        // enough to know the file has slack, and not enough to strike it. On
        // stdout only for a human - the structured formats carry the same rows
        // inside the document, where a stray line is the difference between
        // parsing and not.
        if (options.format === 'human' && (options.verbose || ratchet)) {
          for (const entry of outcome.stale) {
            const subject = entry.subject === '' ? '' : ` "${entry.subject}"`;
            const why = entry.reason === 'gone' ? ` - ${entry.document} is not in this corpus` : '';
            out(`  ${entry.reason}: ${entry.rule} ${entry.document}${subject}${why}\n`);
          }
        }
      }
      const looseBaseline = note !== undefined && note.ratchet && note.stale > 0;

      const reporterOptions = { verbose: options.verbose, max: options.max, escalated, baseline: note, recordAs };
      out(
        options.format === 'sarif'
          ? formatSarif(reported, reported.graph, { version: await readVersion(), escalated, projectRules })
          : options.format === 'gitlab'
            ? formatGitlab(reported, { escalated })
            : options.format === 'github'
              ? formatGithub(reported, { escalated })
              : options.format === 'json'
                ? formatJson(reported, { escalated, baseline: note })
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
  // The prefix test only guards a root that is neither `start` nor above it,
  // which nothing returns; for `start` itself, slicing past its end is `''`
  // too, so emptying the prefix changes nothing a run can reach.
  return start.startsWith(`${root}/`) ? start.slice(root.length + 1) : '';
}

/**
 * A path from the root, as it is typed in `here`: one `../` for each directory
 * `here` is below the root. An absolute path reads the same from anywhere.
 */
function fromHere(here: string, path: string): string {
  return here === '' || isAbsolutePath(path) ? path : `${'../'.repeat(here.split('/').length)}${path}`;
}

/**
 * Re-anchors a pattern typed in `prefix` so it reads from the root, brace
 * alternative by brace alternative, or throws naming it as typed.
 *
 * `../docs` typed one directory down is the root's `docs`. That is arithmetic
 * on two relative paths, and this is the one place both are known; left in the
 * pattern, it reads as a glob climbing out of the root, which is refused.
 *
 * An absolute path is left alone: it was not relative to anywhere, so moving
 * the root cannot change what it means. spec-core roots a leading `/` and
 * knows no drive letter, so `C:/docs` is told apart here.
 */
function anchor(prefix: string, pattern: string): string {
  return isAbsolutePath(pattern) ? pattern : rebasePattern(pattern, prefix);
}

/**
 * The same, for an `--ignore`, where a bare name is a directory at any depth.
 * Only the walk reads a name that way; a `--history` pattern is matched as a
 * whole path, and goes to {@link anchor}.
 */
function anchorPath(prefix: string, pattern: string): string {
  return isGlob(pattern) || pattern.includes('/') ? anchor(prefix, pattern) : pattern;
}

/**
 * Re-anchors a file typed in `prefix`, a baseline, so it reads from the root.
 *
 * A file name is not a pattern: a brace or a `!` in it is a character, which
 * {@link anchor} would read as syntax, and a baseline outside the repository
 * is as good as one inside, so a `..` past the root is a path like any other.
 * At the root the file is named as it was typed.
 */
function anchorFile(prefix: string, file: string): string {
  return prefix === '' || isAbsolutePath(file) ? file : joinPosix(prefix, toPosix(file));
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
  // `execute` already returns each path of nodes once, keyed the way this is,
  // so one selector needs no second pass and sending it through one anyway
  // returns the same matches.
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
  version: string,
  projectRules: readonly ProjectRule[],
  only: string | null,
  configSource: string | null,
): string {
  // A project rule is described by the selector it is, because that is what it
  // is - its message is a template, and a template is not a description.
  const rows: RuleRow[] = [
    ...RULE_IDS.map((id): RuleRow => ({
      id,
      severity: DEFAULT_SEVERITIES[id],
      description: RULE_DESCRIPTIONS[id],
      query: RULE_QUERIES[id],
      decided: decisionUrl(RULE_DECISIONS[id], version),
    })),
    ...projectRules.map((rule): RuleRow => ({
      id: rule.id,
      severity: rule.severity,
      description: rule.sources[0] as string,
      query: rule.sources.slice(1).join(' | ') || undefined,
      // A project rule only exists because a file declared it, so the source
      // is never null here and the first branch is for the type alone.
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

/**
 * Points at the exact character of a selector that failed to parse, in the
 * columns a terminal draws: a Han character before it takes two, so an offset
 * counted in UTF-16 units put the caret short of it. The offset is a position
 * the parser reached, never negative, so it needs no floor.
 */
function renderQueryError(selector: string, error: QueryError): string {
  const caret = `${' '.repeat(displayWidth(selector.slice(0, error.offset)))}^`;
  return `spec-graph: ${error.message}\n  ${selector}\n  ${caret}\n`;
}

/**
 * Compares two exports.
 *
 * Exit 0 whether anything changed or not: a diff describes, and `check` gates. A
 * diff that failed on a removed relation would fail every legitimate
 * supersession (ADR-0020).
 */
async function runDiff(
  paths: readonly [string, string],
  cwd: string,
  format: CliOptions['format'],
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const sides: GraphExport[] = [];
  for (const path of paths) {
    let raw: string;
    try {
      // Without the encoding this is a Buffer, which JSON.parse decodes as
      // UTF-8 all the same - so emptying the literal parses the same export.
      raw = await readFile(resolve(cwd, path), 'utf8');
    } catch (error) {
      err(`spec-graph: cannot read ${path}: ${(error as Error).message}\n`);
      return EXIT_ERROR;
    }
    try {
      sides.push(parseGraphExport(raw, path));
    } catch (error) {
      // Every input parseGraphExport refuses, it refuses as a DiffInputError;
      // the rethrow is for a bug in it, which no file reaches.
      if (!(error instanceof DiffInputError)) throw error;
      err(`spec-graph: ${error.message}\n`);
      return EXIT_ERROR;
    }
  }
  const [before, after] = sides as [GraphExport, GraphExport];
  const diff = diffExports(before, after);
  out(format === 'json' ? formatDiffJson(diff) : format === 'markdown' ? formatDiffMarkdown(diff) : formatDiffText(diff));
  return EXIT_OK;
}

/**
 * The version in the package's own manifest.
 *
 * The guards and the placeholder are for a manifest that is missing or
 * malformed, and the one this reads always parses and always has a version, so
 * no test reaches them without replacing the file the package ships - and the
 * same parse without the encoding reads a Buffer, which JSON.parse decodes as
 * UTF-8 all the same.
 */
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
