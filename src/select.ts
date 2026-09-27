/**
 * The selector language.
 *
 * Rules and users ask the graph the same kinds of question, so they use the same
 * machinery. Every built-in diagnostic is a path query plus a message; anything
 * a rule can find, `spec-graph query` can find too, which means a team can
 * express a convention spec-graph never anticipated without writing a plugin.
 *
 * ```text
 * item[openness=open] -delegates-to-> document[phase=retired]
 * document[phase=active] -assumes,depends-on-> document[phase=retired]
 * document =supersedes=> document[phase=active]
 * item[state=obviated] <-assumes- *
 * *[path^=docs/adr] -blocked-by-> item[openness=open]
 * ```
 *
 * A query evaluates to **paths**, not endpoints. A rule that has the whole path
 * can say "ADR-0004 line 31 delegates this to ADR-0002, which was retired in
 * March" instead of naming two documents and leaving the reader to reconstruct
 * the relationship.
 */

import { receptivityOf } from './lifecycle.js';
import type { SpecGraph } from './graph.js';
import { EDGE_KINDS, type Edge, type EdgeKind, type NodeKind, type SpecNode } from './types.js';
import { compileRegex, RegexError, type RegexMatcher } from './vendor/spec-core/pattern/index.js';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type Operator = '=' | '!=' | '^=' | '$=' | '*=' | '~=' | 'exists';

export interface Predicate {
  readonly key: string;
  readonly operator: Operator;
  readonly value: string;
}

export interface NodeMatcher {
  /** `null` matches both documents and items. */
  readonly kind: NodeKind | null;
  readonly predicates: readonly Predicate[];
}

export interface StepSpec {
  readonly direction: 'out' | 'in';
  /** `null` matches any edge kind. */
  readonly kinds: readonly EdgeKind[] | null;
  /** Follow the relation transitively, taking the shortest path to each node. */
  readonly transitive: boolean;
  readonly node: NodeMatcher;
}

export interface QuerySpec {
  readonly start: NodeMatcher;
  readonly steps: readonly StepSpec[];
}

/**
 * One path through the graph.
 *
 * `nodes` holds the start and the node each step matched; `edges` is the whole
 * path in order. A transitive step contributes one node and every edge it
 * walked, so the nodes it passed through are named only by those edges.
 */
export interface Match {
  readonly nodes: readonly SpecNode[];
  readonly edges: readonly Edge[];
}

export class QueryError extends Error {
  /** Offset into the query string where the problem starts. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'QueryError';
    this.offset = offset;
  }
}

/** Guards against a pathological query fanning out over a huge corpus. */
export const DEFAULT_MATCH_LIMIT = 10_000;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const NODE_KINDS: Readonly<Record<string, NodeKind | null>> = {
  document: 'document',
  documents: 'document',
  doc: 'document',
  docs: 'document',
  item: 'item',
  items: 'item',
  node: null,
  nodes: null,
  any: null,
  '*': null,
};

/** Compiles a selector string into a {@link QuerySpec}. */
export function parseQuery(source: string): QuerySpec {
  const parser = new Parser(source);
  const start = parser.parseNodeMatcher();
  const steps: StepSpec[] = [];
  parser.skipSpace();
  while (!parser.atEnd()) {
    steps.push(parser.parseStep());
    parser.skipSpace();
  }
  return { start, steps };
}

class Parser {
  private readonly source: string;
  private position = 0;

  constructor(source: string) {
    this.source = source;
  }

  atEnd(): boolean {
    return this.position >= this.source.length;
  }

  skipSpace(): void {
    // The bound decides nothing: past the end the character is `undefined`,
    // which `test` reads as the word "undefined" and rejects. It is kept so the
    // loop does not lean on that.
    while (this.position < this.source.length && /\s/.test(this.source[this.position] as string)) this.position += 1;
  }

  parseNodeMatcher(): NodeMatcher {
    this.skipSpace();
    let kind: NodeKind | null = null;
    const word = /^[A-Za-z]+|^\*/.exec(this.source.slice(this.position));
    if (word) {
      const text = (word[0] as string).toLowerCase();
      if (!(text in NODE_KINDS)) {
        throw new QueryError(
          `unknown node type "${word[0]}", expected one of: document, item, * (any)`,
          this.position,
        );
      }
      kind = NODE_KINDS[text] as NodeKind | null;
      this.position += (word[0] as string).length;
    } else if (this.source[this.position] !== '[') {
      throw new QueryError('expected a node type (document, item or *) or a [predicate]', this.position);
    }

    const predicates: Predicate[] = [];
    while (this.source[this.position] === '[') predicates.push(this.parsePredicate());
    return { kind, predicates };
  }

  private parsePredicate(): Predicate {
    this.position += 1;
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(this.source.slice(this.position));
    if (!keyMatch) throw new QueryError('expected an attribute name after "["', this.position);
    const key = (keyMatch[0] as string).toLowerCase();
    this.position += (keyMatch[0] as string).length;

    if (this.source[this.position] === ']') {
      this.position += 1;
      return { key, operator: 'exists', value: '' };
    }

    const operatorMatch = /^(!=|\^=|\$=|\*=|~=|=)/.exec(this.source.slice(this.position));
    if (!operatorMatch) {
      throw new QueryError(
        `expected an operator (=, !=, ^=, $=, *=, ~=) or "]" after "${key}"`,
        this.position,
      );
    }
    const operator = operatorMatch[0] as Operator;
    this.position += operator.length;

    const valueStart = this.position;
    const value = this.parseValue();
    if (this.source[this.position] !== ']') throw new QueryError('expected "]" to close the predicate', this.position);
    this.position += 1;
    // A pattern is checked here rather than where it runs, because here is the
    // only place that knows where in the selector it was written. It used to be
    // compiled on first use and an unparseable one silently matched nothing,
    // which is the same silence a misspelled relation would have produced if
    // this grammar tolerated one. See ADR-0017.
    if (operator === '~=') {
      try {
        pattern(value);
      } catch (error) {
        if (!(error instanceof RegexError)) throw error;
        throw new QueryError(error.message, valueStart + error.offset + (quoted(this.source[valueStart]) ? 1 : 0));
      }
    }
    return { key, operator, value };
  }

  private parseValue(): string {
    const quote = this.source[this.position];
    if (quote === '"' || quote === "'") {
      this.position += 1;
      let out = '';
      while (this.position < this.source.length && this.source[this.position] !== quote) {
        if (this.source[this.position] === '\\') this.position += 1;
        // `?? ''` meets only a backslash at the very end, and the value it
        // builds then is thrown away with the unterminated quote below.
        out += this.source[this.position] ?? '';
        this.position += 1;
      }
      if (this.source[this.position] !== quote) throw new QueryError('unterminated quoted value', this.position);
      this.position += 1;
      return out;
    }
    // The anchor decides nothing, since a starred class matches the empty
    // string where the search starts; it says where the value begins.
    const match = /^[^\]\s]*/.exec(this.source.slice(this.position));
    const value = (match?.[0] ?? '') as string;
    this.position += value.length;
    return value;
  }

  parseStep(): StepSpec {
    const rest = this.source.slice(this.position);
    // The forward form is lazy because its terminator is two characters (`->`),
    // which cannot be confused with the hyphen inside `delegates-to`. The
    // backward terminator is a single `-`, so it must be greedy and backtrack:
    // matching lazily would read `<-delegates-to-` as the relation `delegates`.
    const forward = /^(-|=)([A-Za-z,*-]*?)(->|=>)/.exec(rest);
    const backward = /^(<-|<=)([A-Za-z,*-]*)(-|=)(?=\s|$|[A-Za-z*[])/.exec(rest);

    // Both are anchored where the step starts and open with different
    // characters, so at most one of them matches.
    if (forward) {
      const transitive = (forward[1] as string) === '=';
      const closing = forward[3] as string;
      if ((closing === '=>') !== transitive) {
        throw new QueryError('mismatched arrow: use -kind-> for one hop or =kind=> for transitive', this.position);
      }
      const kinds = this.parseKinds(forward[2] as string, this.position + 1);
      this.position += (forward[0] as string).length;
      return { direction: 'out', kinds, transitive, node: this.parseNodeMatcher() };
    }

    if (backward) {
      const transitive = (backward[1] as string) === '<=';
      const closing = backward[3] as string;
      if ((closing === '=') !== transitive) {
        throw new QueryError('mismatched arrow: use <-kind- for one hop or <=kind= for transitive', this.position);
      }
      const kinds = this.parseKinds(backward[2] as string, this.position + 2);
      this.position += (backward[0] as string).length;
      return { direction: 'in', kinds, transitive, node: this.parseNodeMatcher() };
    }

    throw new QueryError(
      'expected a relation step such as -delegates-to->, <-assumes- or =supersedes=>',
      this.position,
    );
  }

  /**
   * Reads the relation list between a step's arrows.
   *
   * Nothing is trimmed, because the step patterns admit no whitespace inside
   * an arrow. An empty list is not a special case either: it splits into one
   * empty name, which is skipped, and no names at all means any relation.
   */
  private parseKinds(raw: string, offset: number): readonly EdgeKind[] | null {
    if (raw === '*') return null;
    const kinds: EdgeKind[] = [];
    for (const part of raw.split(',')) {
      const name = part.toLowerCase();
      if (name.length === 0) continue;
      if (!(EDGE_KINDS as readonly string[]).includes(name)) {
        throw new QueryError(`unknown relation "${name}", expected one of: ${EDGE_KINDS.join(', ')}`, offset);
      }
      kinds.push(name as EdgeKind);
    }
    // `null` rather than an empty list, which the graph would read the same
    // way: the spec says "any relation" in the form its type documents.
    return kinds.length > 0 ? kinds : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Attributes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every attribute key a node can answer to, excluding the open `fm.` namespace.
 *
 * Selectors do not validate their keys - an unknown one simply matches nothing,
 * which is the forgiving reading a query typed at a prompt wants. A message
 * template is the opposite case: `{1.phse}` would render as an empty string in
 * a diagnostic somebody has to act on, silently and forever. So the list is
 * published here, next to the switch it mirrors, for the one caller that needs
 * to be strict. See ADR-0016.
 */
export const SELECTOR_KEYS: readonly string[] = Object.freeze([
  'alias',
  'body',
  'conflicted',
  'disposition',
  'document',
  'evidence',
  'file',
  'id',
  'kind',
  'line',
  'openness',
  'path',
  'phase',
  'receptivity',
  'section',
  'state',
  'status',
  'text',
  'title',
]);

/**
 * The values a predicate key sees on a node.
 *
 * Multi-valued keys (`alias`, `section`) match when *any* value matches, which
 * is what makes `[section=Open Questions]` read the way people expect.
 */
export function attributesOf(node: SpecNode, key: string, graph?: SpecGraph): string[] {
  switch (key) {
    case 'id':
      return [node.id];
    case 'kind':
      return [node.kind];
    case 'title':
      return [node.title];
    case 'file':
      return [node.at.file];
    case 'line':
      return [String(node.at.span.start.line)];
    case 'document':
      return [node.kind === 'item' ? node.document : node.id];
  }

  if (node.kind === 'document') {
    switch (key) {
      case 'path':
        return [node.path];
      case 'phase':
        return [node.phase];
      case 'status':
        return node.rawStatus === null ? [] : [node.rawStatus];
      case 'receptivity':
        return [receptivityOf(node.phase)];
      case 'alias':
        return [...node.aliases];
    }
    if (key.startsWith('fm.')) {
      const value = node.frontMatter[key.slice(3)];
      if (value === undefined) return [];
      return typeof value === 'string' ? [value] : [...value];
    }
    return [];
  }

  // An item inherits its document's lifecycle. Without this, the two rules that
  // matter most could not be written as queries at all, because the question
  // they ask - "is the document holding this obligation still open?" - is about
  // the owner, not the item.
  if (key === 'phase' || key === 'receptivity' || key === 'status' || key === 'path' || key === 'alias') {
    const owner = graph?.owningDocument(node.id);
    if (owner) return attributesOf(owner, key, graph);
    return key === 'path' ? [node.at.file] : [];
  }

  switch (key) {
    case 'state':
    case 'disposition':
      return [node.disposition];
    case 'openness':
      return [node.openness];
    case 'section':
      return [...node.section];
    case 'text':
      return [node.text];
    case 'body':
      return [node.body];
    case 'evidence':
      return [node.evidence.source];
    case 'conflicted':
      return [node.conflicts.length > 0 ? 'true' : 'false'];
    default:
      return [];
  }
}

function testPredicate(node: SpecNode, predicate: Predicate, graph?: SpecGraph): boolean {
  const values = attributesOf(node, predicate.key, graph);
  const needle = predicate.value.toLowerCase();

  if (predicate.operator === 'exists') return values.some((value) => value.length > 0);
  if (predicate.operator === '!=') return !values.some((value) => value.toLowerCase() === needle);

  return values.some((raw) => {
    const value = raw.toLowerCase();
    switch (predicate.operator) {
      case '=':
        return value === needle;
      case '^=':
        return value.startsWith(needle);
      case '$=':
        return value.endsWith(needle);
      case '*=':
        return value.includes(needle);
      case '~=':
        return pattern(predicate.value).test(raw);
      default:
        // Unreachable: `exists` and `!=` returned above, and the type knows
        // no other operator. Narrowing does not reach into this callback.
        return false;
    }
  });
}

const patterns = new Map<string, RegexMatcher>();

/**
 * Compiles a `~=` pattern, once per distinct pattern.
 *
 * Cached because a rule runs its predicate against every node in the corpus,
 * and because compiling is the expensive half now that matching is linear.
 * The cache changes the cost and nothing else: a pattern compiled twice
 * matches what it matched once.
 */
export function pattern(source: string): RegexMatcher {
  const cached = patterns.get(source);
  if (cached) return cached;
  const compiled = compileRegex(source);
  patterns.set(source, compiled);
  return compiled;
}

function quoted(char: string | undefined): boolean {
  return char === '"' || char === "'";
}

/** True when a node satisfies a matcher. */
export function matches(node: SpecNode, matcher: NodeMatcher, graph?: SpecGraph): boolean {
  if (matcher.kind !== null && node.kind !== matcher.kind) return false;
  return matcher.predicates.every((predicate) => testPredicate(node, predicate, graph));
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExecuteOptions {
  /**
   * Cap on the paths produced by each traversal step.
   *
   * It bounds *expansion*, not the initial selection: a query with no steps
   * returns every matching node. That asymmetry is deliberate. The limit exists
   * so a query across a dense graph cannot fan out unboundedly, and the rules
   * run through this engine - truncating the set of nodes a rule starts from
   * would silently drop findings, whereas truncating a runaway expansion only
   * ever drops paths that were already beyond reading.
   */
  readonly limit?: number | undefined;
  /**
   * Whether a step may stay inside one document.
   *
   * Off by default for reflexive edges: a document that links to itself is a
   * formatting quirk, not a relationship, and letting those through turns every
   * table of contents into a finding.
   */
  readonly allowReflexive?: boolean | undefined;
}

/** Runs a compiled query and returns every matching path. */
export function execute(graph: SpecGraph, spec: QuerySpec, options: ExecuteOptions = {}): Match[] {
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT;
  const allowReflexive = options.allowReflexive ?? false;

  let frontier: Match[] = [];
  for (const node of graph.nodes.values()) {
    if (matches(node, spec.start, graph)) frontier.push({ nodes: [node], edges: [] });
  }

  for (const step of spec.steps) {
    const next: Match[] = [];
    const seen = new Set<string>();

    for (const match of frontier) {
      const tail = match.nodes[match.nodes.length - 1] as SpecNode;
      for (const { node, path } of expand(graph, tail, step, allowReflexive)) {
        if (!matches(node, step.node, graph)) continue;
        const key = `${match.nodes.map((n) => n.id).join('>')}>${node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ nodes: [...match.nodes, node], edges: [...match.edges, ...path] });
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }

    frontier = next;
    // An empty frontier stays empty through every later step; this only stops
    // walking them.
    if (frontier.length === 0) break;
  }

  return frontier;
}

interface Expansion {
  readonly node: SpecNode;
  readonly path: readonly Edge[];
}

// `buildGraph` drops every edge that names an unknown node, so the `if (node)`
// guards below never skip anything in a graph it built. They stand for a
// `SpecGraph` built some other way.
function expand(graph: SpecGraph, from: SpecNode, step: StepSpec, allowReflexive: boolean): Expansion[] {
  const kinds = step.kinds ?? [];
  const out: Expansion[] = [];

  if (!step.transitive) {
    const edges = step.direction === 'out' ? graph.out(from.id, kinds) : graph.in(from.id, kinds);
    for (const edge of edges) {
      if (!allowReflexive && edge.reflexive) continue;
      const targetId = step.direction === 'out' ? edge.to : edge.from;
      const node = graph.node(targetId);
      if (node) out.push({ node, path: [edge] });
    }
    return out;
  }

  // Transitive steps take the shortest path to each reachable node, which keeps
  // the result deterministic and the reported evidence minimal.
  const reached =
    step.direction === 'out'
      ? graph.reach(from.id, kinds)
      : reachIncoming(graph, from.id, kinds);

  for (const [id, path] of reached) {
    if (!allowReflexive && path.every((edge) => edge.reflexive)) continue;
    const node = graph.node(id);
    if (node) out.push({ node, path });
  }
  return out;
}

function reachIncoming(graph: SpecGraph, id: string, kinds: readonly EdgeKind[]): Map<string, readonly Edge[]> {
  const paths = new Map<string, readonly Edge[]>();
  const pathTo = new Map<string, readonly Edge[]>([[id, []]]);
  const queue: string[] = [id];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const prefix = pathTo.get(current) as readonly Edge[];
    for (const edge of graph.in(current, kinds)) {
      if (pathTo.has(edge.from) && edge.from !== id) continue;
      const path = [...prefix, edge];
      if (edge.from === id) {
        if (!paths.has(id)) paths.set(id, path);
        continue;
      }
      pathTo.set(edge.from, path);
      paths.set(edge.from, path);
      queue.push(edge.from);
    }
  }
  return paths;
}

/** Parses and runs a selector in one call. */
export function query(graph: SpecGraph, selector: string, options?: ExecuteOptions): Match[] {
  return execute(graph, parseQuery(selector), options);
}

/**
 * Renders a match the way the selector reads, for `spec-graph query`.
 *
 * Every edge is written in the direction it was walked - `A -kind-> B`
 * forwards, `A <-kind- B` backwards - and names the node it arrives at, so a
 * transitive step shows each document it passed through. Reading the nodes off
 * `match.nodes` instead printed the end of a transitive path in its middle, and
 * a backward step as a relation pointing the other way.
 */
export function renderMatch(match: Match): string {
  let at = (match.nodes[0] as SpecNode).id;
  const parts: string[] = [at];
  for (const edge of match.edges) {
    const forwards = edge.from === at;
    at = forwards ? edge.to : edge.from;
    parts.push(forwards ? `-${edge.kind}->` : `<-${edge.kind}-`, at);
  }
  return parts.join(' ');
}
