/**
 * Rules a repository writes for itself.
 *
 * [ADR-0005](../docs/adr/0005-rules-are-queries.md) claimed the selector
 * language was expressive enough that a team could express a convention
 * spec-graph never anticipated. For three releases that claim was only true at a
 * command prompt: `spec-graph query` could find the thing, and nothing could
 * make finding it fail a build. Three ADRs recorded the same gap and the same
 * reason - a query needs a severity and a sentence before it is a rule.
 *
 * This is the sentence. A project rule is a selector, a message, a hint and a
 * severity, written in `.spec-graph.json` and run beside the built-ins:
 *
 * ```json
 * "rules": {
 *   "no-draft-dependency": {
 *     "query": "document[phase=active] -depends-on-> document[phase=draft]",
 *     "message": "{0} depends on {1}, which is still a draft",
 *     "hint": "wait for {1} to be accepted, or drop the dependency"
 *   }
 * }
 * ```
 *
 * Everything here is a pure function of the parsed configuration. Reading the
 * file stays in `config.ts`, for the same reason extraction never touches a
 * disk.
 */

import { attributesOf, parseQuery, QueryError, SELECTOR_KEYS, type Match, type QuerySpec } from './select.js';
import type { SpecGraph } from './graph.js';
import type { ProjectRuleId, Severity } from './types.js';
import { PROJECT_RULE_PREFIX } from './types.js';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** A project rule, compiled and known to be runnable. */
export interface ProjectRule {
  /** Namespaced, so it can never collide with a built-in. */
  readonly id: ProjectRuleId;
  /** The name as the repository wrote it, for error messages. */
  readonly name: string;
  /**
   * The selectors, in the order they were written.
   *
   * More than one because a convention is often a union - "no live document may
   * depend on a draft *or* on a record" - and a union of queries is clearer than
   * a disjunction inside the grammar. See ADR-0005.
   */
  readonly queries: readonly QuerySpec[];
  /**
   * The selectors as written, kept beside the compiled form.
   *
   * A report has to describe the rule, and the only honest description of a
   * project rule is the query behind it. Echoing the text back is exact and
   * free; rendering a `QuerySpec` would be a second grammar to keep correct.
   */
  readonly sources: readonly string[];
  readonly message: string;
  readonly hint: string;
  /**
   * What the repository declared, before `--rule` and `--strict` have their say.
   *
   * Defaults to `warn` rather than to `error`. A rule a team has just written
   * has not yet earned the right to stop their build, and the first run of a new
   * convention is exactly when it is most likely to be wrong.
   */
  readonly severity: Severity;
}

export interface CompiledProjectRules {
  readonly rules: readonly ProjectRule[];
  readonly problems: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a name may contain.
 *
 * No colon, because the namespace separator has to stay unambiguous. No
 * whitespace, because the id is printed in a column of a report. And no tab in
 * particular: a baseline key is three fields joined by one, and a rule id that
 * could contain a tab would be a rule whose accepted debt could be forged by
 * typing carefully. See ADR-0012.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MAX_NAME_LENGTH = 64;

/**
 * `{0}`, `{1.phase}`, `{2.fm.owner}`.
 *
 * Positional because a path is positional: step zero is where the finding
 * starts and the last step is where it ends. Naming them would mean inventing a
 * second vocabulary for something the selector already numbers.
 */
const PLACEHOLDER = /\{(\d+)(?:\.([A-Za-z][A-Za-z0-9_.:-]*))?\}/g;

/**
 * Turns the `rules` section of a configuration into runnable rules.
 *
 * Every failure is collected rather than thrown. A repository whose eighth
 * custom rule has a typo in it should still get the findings from the other
 * seven, and should be told exactly which one stopped working - a configuration
 * that silently does less than it says is the failure mode this whole file
 * exists to avoid.
 */
export function compileProjectRules(raw: unknown, source: string): CompiledProjectRules {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { rules: [], problems: [`${source}: "rules" must be an object of name to rule`] };
  }

  const rules: ProjectRule[] = [];
  for (const [name, body] of Object.entries(raw)) {
    const rule = compileOne(name, body, source, problems);
    if (rule !== null) rules.push(rule);
  }
  // Sorted by id, so two runs of one configuration produce findings in the same
  // order however the JSON was keyed.
  return { rules: rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), problems };
}

function compileOne(
  name: string,
  body: unknown,
  source: string,
  problems: string[],
): ProjectRule | null {
  const where = `${source}: rules.${name}`;
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    problems.push(
      `${where}: a rule name must be letters, digits, "." "_" or "-", at most ${MAX_NAME_LENGTH} characters`,
    );
    return null;
  }
  if (!isRecord(body)) {
    problems.push(`${where} must be an object with "query" and "message"`);
    return null;
  }

  for (const key of Object.keys(body)) {
    if (!RULE_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
  }

  const written = body['query'];
  const listed: unknown[] = typeof written === 'string' ? [written] : Array.isArray(written) ? written : [];
  if (listed.length === 0 || listed.some((entry) => typeof entry !== 'string')) {
    problems.push(`${where}: "query" must be a selector, or an array of them`);
    return null;
  }
  const sources = listed as string[];

  const queries: QuerySpec[] = [];
  for (const selector of sources) {
    try {
      queries.push(parseQuery(selector));
    } catch (error) {
      const detail = error instanceof QueryError ? `${error.message} (at character ${error.offset + 1})` : String(error);
      problems.push(`${where}: ${detail}`);
      return null;
    }
  }

  const message = body['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    problems.push(`${where}: "message" must be the one-line headline of the finding`);
    return null;
  }

  // A finding has to name a next action, so the fallback names the only thing
  // this file can be certain of: where the rule was written down.
  const hint = body['hint'] ?? `check this against rules.${name} in ${source}`;
  if (typeof hint !== 'string' || hint.trim().length === 0) {
    problems.push(`${where}: "hint" must be a concrete next action`);
    return null;
  }

  const declared = body['severity'] ?? 'warn';
  if (declared !== 'error' && declared !== 'warn' && declared !== 'info' && declared !== 'off') {
    problems.push(`${where}: "severity" must be error, warn, info or off`);
    return null;
  }

  // The shortest path a rule can produce, because a placeholder has to be
  // resolvable by *every* query behind the rule and not merely by the longest.
  const arity = Math.min(...queries.map((query) => query.steps.length + 1));
  let usable = true;
  for (const text of [message, hint]) {
    for (const problem of placeholderProblems(text, arity, where)) {
      problems.push(problem);
      usable = false;
    }
  }
  if (!usable) return null;

  return {
    id: `${PROJECT_RULE_PREFIX}${name}`,
    name,
    queries,
    sources,
    message: message.trim(),
    hint: hint.trim(),
    severity: declared,
  };
}

const RULE_KEYS: ReadonlySet<string> = new Set(['query', 'message', 'hint', 'severity']);

/**
 * Why a template would not render.
 *
 * Checked here rather than tolerated at render time, because both failures are
 * silent where it matters: an out-of-range index leaves `{3}` sitting in a
 * sentence a human has to act on, and a misspelled attribute renders as nothing
 * at all, which reads as a finding about an unnamed document.
 */
function placeholderProblems(template: string, arity: number, where: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]);
    if (index >= arity) {
      out.push(
        `${where}: "${match[0]}" names step ${index}, and the query has ${arity} ${arity === 1 ? 'step' : 'steps'} (0 to ${arity - 1})`,
      );
      continue;
    }
    const key = match[2];
    if (key === undefined) continue;
    const folded = key.toLowerCase();
    if (folded.startsWith('fm.') || SELECTOR_KEYS.includes(folded)) continue;
    out.push(`${where}: "${match[0]}" asks for an attribute nothing has - known: ${SELECTOR_KEYS.join(', ')}, fm.*`);
  }
  return out;
}

/**
 * Fills a validated template in from one path through the graph.
 *
 * Sharing one global regex between this and {@link placeholderProblems} is safe
 * and not an oversight: `matchAll` works on a clone, and `replace` resets
 * `lastIndex` on entry and on exit. The hazard `CLAUDE.md` warns about is a
 * `/g` regex whose cursor survives a call, and neither of these keeps one.
 *
 * An index that survived validation can still miss at run time, because a
 * transitive step can end short. That leaves the placeholder as written, which
 * is ugly and honest, rather than an empty space in a sentence.
 */
export function renderTemplate(template: string, match: Match, graph: SpecGraph): string {
  return template.replace(PLACEHOLDER, (whole, index: string, key: string | undefined) => {
    const node = match.nodes[Number(index)];
    if (node === undefined) return whole;
    return attributesOf(node, (key ?? 'id').toLowerCase(), graph)[0] ?? whole;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
