import { describe, expect, it } from 'vitest';

import { applyBaseline, formatBaseline, parseBaseline } from '../src/baseline.js';
import { parseConfig } from '../src/config.js';
import { compileProjectRules } from '../src/project-rules.js';
import { resolveStrict } from '../src/rules.js';
import { analyseSources, type Source } from '../src/runner.js';
import type { AnyRuleId, Diagnostic } from '../src/types.js';

/**
 * Rules a repository writes for itself. See ADR-0016.
 *
 * Two halves, and the split is the design: compilation decides whether a rule
 * can run at all and says so at load time, and running it is then the same
 * `emit` every built-in goes through. The second half is mostly tested by
 * asserting that a project rule inherits machinery nobody taught about it.
 */

const compile = (rules: unknown) => compileProjectRules(rules, '.spec-graph.json');

const RULE = {
  query: 'document[phase=active] -depends-on-> document[phase=draft]',
  message: '{0} depends on {1}, which is still a draft',
};

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

describe('compiling a project rule', () => {
  it('namespaces the id and defaults the severity to warn', () => {
    const { rules, problems } = compile({ 'no-draft-dependency': RULE });
    expect(problems).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe('project:no-draft-dependency');
    expect(rules[0]?.name).toBe('no-draft-dependency');
    // A rule a team has just written has not earned the right to fail a build.
    expect(rules[0]?.severity).toBe('warn');
  });

  it('falls back to a hint that names where the rule was written', () => {
    const { rules } = compile({ 'no-drafts': RULE });
    expect(rules[0]?.hint).toBe('check this against rules.no-drafts in .spec-graph.json');
  });

  it('keeps the selectors as written, for the reports that describe the rule', () => {
    const { rules, problems } = compile({ pair: { query: ['document', 'item'], message: '{0} is wrong' } });
    expect(problems).toEqual([]);
    expect(rules[0]?.sources).toEqual(['document', 'item']);
  });

  it('sorts by id, so one configuration always produces one order', () => {
    const { rules } = compile({ zeta: RULE, alpha: RULE, mid: RULE });
    expect(rules.map((rule) => rule.id)).toEqual(['project:alpha', 'project:mid', 'project:zeta']);
  });

  it('reports a name that could not survive a report or a baseline key', () => {
    // A tab in a name would let accepted debt be forged by typing carefully,
    // because a baseline key is three fields joined by one.
    const { rules, problems } = compile({ 'has space': RULE, 'has\tTab': RULE, 'has:colon': RULE });
    expect(rules).toEqual([]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('a rule name must be');
  });

  it('reports a name longer than a report column', () => {
    const { problems } = compile({ ['a'.repeat(65)]: RULE });
    expect(problems).toHaveLength(1);
  });

  it('reports a selector that does not parse, and where', () => {
    const { rules, problems } = compile({ bad: { ...RULE, query: 'document =amends-> document' } });
    expect(rules).toEqual([]);
    expect(problems[0]).toContain('mismatched arrow');
    expect(problems[0]).toContain('at character 10');
  });

  it('reports a missing message rather than inventing one', () => {
    expect(compile({ bad: { query: 'document' } }).problems[0]).toContain('"message" must be');
    expect(compile({ bad: { query: 'document', message: '   ' } }).problems[0]).toContain('"message" must be');
  });

  it('reports a query that is neither a selector nor a list of them', () => {
    expect(compile({ bad: { message: 'x' } }).problems[0]).toContain('"query" must be');
    expect(compile({ bad: { query: [], message: 'x' } }).problems[0]).toContain('"query" must be');
    expect(compile({ bad: { query: [7], message: 'x' } }).problems[0]).toContain('"query" must be');
  });

  it('reports a severity that is not one', () => {
    expect(compile({ bad: { ...RULE, severity: 'loud' } }).problems[0]).toContain('"severity" must be');
  });

  it('reports a rule that is not an object', () => {
    expect(compile({ bad: 'document' }).problems[0]).toContain('must be an object');
  });

  it('reports a rules section that is not an object', () => {
    expect(compile(['document']).problems[0]).toContain('must be an object of name to rule');
  });

  it('reports an unknown key without discarding the rule', () => {
    // Consistent with every other unknown key in the file: said out loud, and
    // not fatal. The point is that `sevrity` cannot silently change nothing.
    const { rules, problems } = compile({ typo: { ...RULE, sevrity: 'error' } });
    expect(problems[0]).toContain('unknown key "sevrity"');
    expect(rules).toHaveLength(1);
  });

  it('lets one broken rule through without taking the others with it', () => {
    const { rules, problems } = compile({ good: RULE, broken: { query: '???', message: 'x' } });
    expect(rules.map((rule) => rule.name)).toEqual(['good']);
    expect(problems).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Message templates                                                          */
/* -------------------------------------------------------------------------- */

describe('a message template', () => {
  it('rejects a step the query cannot reach', () => {
    const { problems } = compile({ bad: { query: 'document', message: '{1} is wrong' } });
    expect(problems[0]).toContain('names step 1');
    expect(problems[0]).toContain('1 step (0 to 0)');
  });

  it('measures against the shortest query, not the longest', () => {
    // A placeholder has to resolve for every selector behind the rule. Taking
    // the longest would leave `{1}` sitting in a sentence a human has to act on
    // whenever the one-step selector was the one that matched.
    const { problems } = compile({
      bad: { query: ['document -amends-> document', 'document'], message: '{1} is wrong' },
    });
    expect(problems[0]).toContain('names step 1');
  });

  it('rejects an attribute nothing answers to', () => {
    const { problems } = compile({ bad: { query: 'document', message: '{0.phse}' } });
    expect(problems[0]).toContain('asks for an attribute nothing has');
  });

  it('accepts the open front-matter namespace', () => {
    const { problems } = compile({ ok: { query: 'document', message: '{0.fm.owner} owns {0}' } });
    expect(problems).toEqual([]);
  });

  it('checks the hint as closely as the message', () => {
    const { rules, problems } = compile({ bad: { query: 'document', message: 'x', hint: 'see {2}' } });
    expect(rules).toEqual([]);
    expect(problems[0]).toContain('names step 2');
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

describe('project rules in a configuration file', () => {
  const config = (body: unknown) => parseConfig(JSON.stringify(body), '.spec-graph.json');

  it('is read as a known key', () => {
    const { config: parsed, problems } = config({ rules: { a: RULE } });
    expect(problems).toEqual([]);
    expect(parsed.rules?.map((rule) => rule.id)).toEqual(['project:a']);
  });

  it('accepts a severity naming a rule it defines', () => {
    const { problems } = config({ rules: { a: RULE }, severities: { 'project:a': 'off' } });
    expect(problems).toEqual([]);
  });

  it('reports a severity naming a project rule nothing defines', () => {
    // The one failure a configuration file must never have: a line that reads
    // as if it does something and cannot.
    const { problems } = config({ rules: { a: RULE }, severities: { 'project:b': 'off' } });
    expect(problems).toEqual(['.spec-graph.json: "severities.project:b" names no rule in "rules"']);
  });

  it('reports a project severity when there is no rules section at all', () => {
    const { problems } = config({ severities: { 'project:b': 'off' } });
    expect(problems).toEqual(['.spec-graph.json: "severities.project:b" names no rule in "rules"']);
  });

  it('still rejects a built-in rule that does not exist', () => {
    const { problems } = config({ severities: { 'ghost-handoverr': 'off' } });
    expect(problems[0]).toContain('unknown rule');
  });
});

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

const DRAFT = `---
status: draft
---

# ADR-0001: Queueing
`;

const LIVE = `---
status: accepted
owner: platform
depends-on: ADR-0001
---

# ADR-0002: Delivery
`;

const CORPUS: Source[] = [
  { path: 'docs/adr/0001-old.md', text: DRAFT },
  { path: 'docs/adr/0002-live.md', text: LIVE },
];

/** Runs one project rule over the two-document corpus above. */
function findings(rule: Record<string, unknown>, sources: Source[] = CORPUS): readonly Diagnostic[] {
  const { rules, problems } = compile({ probe: rule });
  expect(problems).toEqual([]);
  return analyseSources(sources, { projectRules: rules }).diagnostics;
}

describe('running a project rule', () => {
  it('points at the line that declares the relation, not the document it names', () => {
    // `depends-on: ADR-0001` is written in ADR-0002, and that is the only place
    // a human can change the answer.
    const [found] = findings(RULE);
    expect(found?.rule).toBe('project:probe');
    expect(found?.at.file).toBe('docs/adr/0002-live.md');
    expect(found?.at.span.start.line).toBe(4);
    expect(found?.nodes).toEqual(['ADR-0002', 'ADR-0001']);
  });

  it('fills the message in from the path it matched', () => {
    const [found] = findings({ ...RULE, hint: 'drop it from {0.path}, or accept {1.fm.status}' });
    expect(found?.message).toBe('ADR-0002 depends on ADR-0001, which is still a draft');
    expect(found?.hint).toBe('drop it from docs/adr/0002-live.md, or accept draft');
  });

  it('points at the node itself when the rule has no relation to point at', () => {
    const [found] = findings({ query: 'document[phase=draft]', message: '{0} is a draft' });
    expect(found?.at.file).toBe('docs/adr/0001-old.md');
    expect(found?.nodes).toEqual(['ADR-0001']);
  });

  it('reports a path both of its selectors find exactly once', () => {
    // Two selectors are a union. A repository that broke one convention once
    // must not be told about it twice.
    const found = findings({
      query: ['document[phase=draft]', 'document[id^=ADR-0001]'],
      message: '{0} matched',
    });
    expect(found.map((entry) => entry.nodes[0])).toEqual(['ADR-0001']);
  });

  it('inherits the severity table, so a rule can be switched off', () => {
    const { rules } = compile({ probe: RULE });
    const result = analyseSources(CORPUS, { projectRules: rules, severities: { 'project:probe': 'off' } });
    expect(result.diagnostics).toEqual([]);
  });

  it('inherits the record exemption without being taught about it', () => {
    // ADR-0002 is a log of what was decided, so what it depends on is a
    // sentence about the past rather than an obligation. See ADR-0011.
    const found = findings(RULE, CORPUS).length;
    expect(found).toBe(1);
    const { rules } = compile({ probe: RULE });
    const asRecord = analyseSources(CORPUS, {
      projectRules: rules,
      isRecord: (path) => path.endsWith('0002-live.md'),
    });
    expect(asRecord.diagnostics).toEqual([]);
  });

  it('is escalated by --strict on the same terms as a built-in', () => {
    const { rules } = compile({ warned: RULE, noisy: { ...RULE, severity: 'info' } });
    const { severities, escalated } = resolveStrict({}, true, rules);
    expect(severities['project:warned']).toBe('error');
    expect(escalated.has('project:warned')).toBe(true);
    // Advisory by declaration, and strict leaves those alone. See ADR-0006.
    expect(severities['project:noisy']).toBeUndefined();
  });

  it('lets an explicit override beat --strict, exactly as a built-in does', () => {
    const { rules } = compile({ warned: RULE });
    const { severities, escalated } = resolveStrict({ 'project:warned': 'warn' }, true, rules);
    expect(severities['project:warned']).toBe('warn');
    expect(escalated.has('project:warned')).toBe(false);
  });

  it('escalates nothing when strict is off', () => {
    const { rules } = compile({ warned: RULE });
    expect(resolveStrict({}, false, rules).escalated.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Baselines                                                                  */
/* -------------------------------------------------------------------------- */

describe('a project rule in a baseline', () => {
  it('records and then accepts its own findings', () => {
    const { rules } = compile({ probe: RULE });
    const result = analyseSources(CORPUS, { projectRules: rules });
    const written = formatBaseline(result.graph, result.diagnostics);
    expect(written).toContain('"rule": "project:probe"');

    const { baseline, problems } = parseBaseline(written, 'bl.json');
    expect(problems).toEqual([]);
    const outcome = applyBaseline(result.graph, result.diagnostics, baseline);
    expect(outcome.kept).toEqual([]);
    expect(outcome.suppressed).toBe(1);
    expect(outcome.stale).toEqual([]);
  });

  it('accepts an entry for a rule the configuration no longer defines', () => {
    // A baseline is read before the configuration has any say. Rejecting the
    // entry would un-accept debt somebody signed off; reporting it as stale
    // says the same thing by a route that keeps the file readable.
    const raw = JSON.stringify({
      version: 1,
      findings: [{ rule: 'project:gone', document: 'ADR-0002', subject: 'ADR-0001', count: 1 }],
    });
    const { baseline, problems } = parseBaseline(raw, 'bl.json');
    expect(problems).toEqual([]);

    const result = analyseSources(CORPUS);
    const outcome = applyBaseline(result.graph, result.diagnostics, baseline);
    expect(outcome.stale.map((entry) => entry.rule as AnyRuleId)).toEqual(['project:gone']);
  });

  it('still rejects a rule in no namespace at all', () => {
    const raw = JSON.stringify({ version: 1, findings: [{ rule: 'invented', document: 'A', count: 1 }] });
    expect(parseBaseline(raw, 'bl.json').problems[0]).toContain('unknown rule');
  });
});

/* -------------------------------------------------------------------------- */
/* Scale                                                                      */
/* -------------------------------------------------------------------------- */

describe('a project rule on a corpus written to be hostile to one', () => {
  /** 300 documents, each depending on the ten before it: 2,955 edges. */
  const dense: Source[] = Array.from({ length: 300 }, (_, index) => {
    const number = index + 1;
    const id = (value: number) => `ADR-${String(value).padStart(4, '0')}`;
    const deps: string[] = [];
    for (let back = 1; back <= 10 && number - back > 0; back += 1) deps.push(id(number - back));
    const front = deps.length > 0 ? `depends-on: [${deps.join(', ')}]\n` : '';
    return {
      path: `docs/adr/${String(number).padStart(4, '0')}-doc.md`,
      text: `---\nstatus: accepted\n${front}---\n\n# ${id(number)}: Doc ${number}\n`,
    };
  });

  /**
   * A ceiling, not a benchmark.
   *
   * The two runs below take about 120 ms on an idle machine, and this number is
   * thirty times that on purpose. It is here to catch a blow-up - an accidental
   * quadratic, a traversal that stopped being bounded - and nothing finer,
   * because the suite runs under Stryker with eight workers competing for the
   * same cores and a tighter budget fails there for reasons that have nothing to
   * do with this code. The honest measurement lives in ADR-0016.
   */
  const BLOW_UP = 4000;

  it('does not blow up on a transitive query over a dense graph', () => {
    // The worst shape a project rule can take: every document reaches every
    // earlier one, so the traversal is bounded only by the match limit.
    const { rules } = compile({
      fanout: { query: 'document =depends-on=> document', message: '{0} reaches {1}', severity: 'info' },
    });
    const started = performance.now();
    const result = analyseSources(dense, { projectRules: rules });
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
    // The guarantee that actually holds, and the one worth asserting: the
    // ceiling is the engine's match limit, and it does not move with the corpus.
    expect(result.diagnostics.length).toBe(10_000);
  });

  it('does not blow up with five hundred selectors in one rule', () => {
    const { rules, problems } = compile({
      many: { query: Array.from({ length: 500 }, (_, i) => `document[id^=ADR-${i}]`), message: '{0}', severity: 'info' },
    });
    expect(problems).toEqual([]);
    const started = performance.now();
    const result = analyseSources(dense, { projectRules: rules });
    expect(performance.now() - started).toBeLessThan(BLOW_UP);
    // A union, deduplicated: 300 documents, however many selectors found them.
    expect(result.diagnostics.length).toBe(300);
  });

  it('refuses a name that arrives through JSON rather than through a literal', () => {
    // `{"__proto__": ...}` is an own property once JSON.parse has read it, and
    // it is the one name that reaches an object index without being a key.
    const { config, problems } = parseConfig('{"rules": {"__proto__": {"query": "document", "message": "x"}}}', 'c.json');
    expect(config.rules ?? []).toEqual([]);
    expect(problems[0]).toContain('a rule name must be');
    expect(Object.prototype).not.toHaveProperty('query');
  });

  it('leaves a placeholder as written when a transitive path ends short', () => {
    // `{1}` passes validation - the query has two steps - and a transitive
    // traversal can still return a path of one. Ugly and honest beats a blank
    // space where a document name should be.
    const { rules, problems } = compile({
      short: { query: 'document =depends-on=> document', message: '{1} was reached', severity: 'info' },
    });
    expect(problems).toEqual([]);
    expect(rules).toHaveLength(1);
  });
});
