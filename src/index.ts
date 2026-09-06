/**
 * Programmatic API.
 *
 * The CLI is a shell over `analyse`; anything the CLI can do, a build script, a
 * custom reporter or an editor extension can do too.
 *
 * ```ts
 * import { analyse, formatReport } from '@descent-vtt/spec-graph';
 *
 * const result = await analyse({ root: process.cwd(), patterns: ['docs/**\/*.md'] });
 * if (!result.ok) console.error(formatReport(result, { color: true }));
 * ```
 *
 * For a corpus that is already in memory - a monorepo tool, a language server,
 * a test - skip the filesystem entirely:
 *
 * ```ts
 * import { analyseSources, query } from '@descent-vtt/spec-graph';
 *
 * const { graph } = analyseSources([{ path: 'adr/0001.md', text: '...' }]);
 * const ghosts = query(graph, 'item[openness=open] -delegates-to-> document[phase=retired]');
 * ```
 */

export { main, parseArgs, HELP, UsageError, EXIT_OK, EXIT_FAILED, EXIT_ERROR } from './cli.js';
export type { CliIO, CliOptions, Command } from './cli.js';

export { analyse, analyseSources, DEFAULT_CONCURRENCY, DEFAULT_PATTERNS } from './runner.js';
export type { AnalyseOptions, AnalyseSourcesOptions, AnalysisResult, Source } from './runner.js';

export { buildGraph, LOAD_BEARING_EDGES, OBLIGATION_EDGES } from './graph.js';
export type { SpecGraph } from './graph.js';

export {
  attributesOf,
  execute,
  matches,
  parseQuery,
  query,
  renderMatch,
  QueryError,
  DEFAULT_MATCH_LIMIT,
} from './select.js';
export type {
  ExecuteOptions,
  Match,
  NodeMatcher,
  Operator,
  Predicate,
  QuerySpec,
  StepSpec,
} from './select.js';

export {
  runRules,
  sortDiagnostics,
  DEFAULT_SEVERITIES,
  RULE_DESCRIPTIONS,
  RULE_IDS,
  RULE_QUERIES,
} from './rules.js';
export type { RuleOptions } from './rules.js';

export {
  createPainter,
  formatGraph,
  formatJson,
  formatReport,
  shouldUseAscii,
  shouldUseColor,
} from './report.js';
export type { ColorEnvironment, GraphExportOptions, GraphFormat, Painter, ReporterOptions } from './report.js';

export { extractDocument, classifyReference, sectionPathAt } from './extract.js';
export type { Classification, ExtractedDocument, ExtractInput, ReferenceCandidate } from './extract.js';

export { resolveCorpus, documentOf } from './resolve.js';
export type { ResolvedCorpus, ResolveOptions } from './resolve.js';

export { scanMarkdown, slugify } from './markdown.js';
export type {
  FrontMatter,
  Heading,
  HtmlComment,
  Link,
  LinkForm,
  ListItem,
  Range,
  ScannedDocument,
  ScannedLine,
} from './markdown.js';

export { parseDirectives, attr, attrList, directiveFor } from './directives.js';
export type { Attribute, Directive, DirectiveName } from './directives.js';

export { parseFrontMatter, toRecord, valuesOf } from './yaml.js';
export type { YamlEntry } from './yaml.js';

export {
  isRetired,
  isStatusHeading,
  normaliseStatus,
  phaseFromPath,
  phaseOf,
  receptivityOf,
  supersessionTargetsIn,
  STATUS_KEYS,
} from './lifecycle.js';

export { resolveItemState, KNOWN_STATE_WORDS } from './state.js';
export type { ResolvedState, StateInput } from './state.js';

export {
  familyFromPath,
  identify,
  isDocumentTarget,
  isExternal,
  looksLikePath,
  normaliseRef,
  parseBareRef,
  parsePrefixedRef,
  splitAnchor,
  ID_KEYS,
} from './identity.js';
export type { DocumentIdentity, IdentityInput } from './identity.js';

export {
  createGlobMatcher,
  globBase,
  globToRegExp,
  isGlob,
  walkFiles,
  DEFAULT_IGNORED_DIRECTORIES,
  MAX_FILE_SIZE,
} from './glob.js';
export type { GlobMatcher, WalkedFile, WalkOptions } from './glob.js';

export { compareRefs, createLineIndex, formatRef, refOf, spanOf } from './source.js';
export type { LineIndex } from './source.js';

export {
  basenamePosix,
  dirnamePosix,
  extnamePosix,
  joinPosix,
  normalisePosix,
  resolveFrom,
  toPosix,
} from './paths.js';

export { DISPOSITIONS, EDGE_KINDS, EDGE_TRAITS, OPENNESS_OF } from './types.js';
export type {
  AnalysisSummary,
  DanglingReason,
  DanglingRef,
  Diagnostic,
  Disposition,
  DocumentNode,
  Edge,
  EdgeKind,
  EdgeOrigin,
  EdgeTraits,
  ItemNode,
  NodeKind,
  Openness,
  ParseProblem,
  Phase,
  Position,
  Receptivity,
  RelatedLocation,
  RuleId,
  Severity,
  SourceRef,
  Span,
  SpecNode,
  StateSignal,
} from './types.js';
