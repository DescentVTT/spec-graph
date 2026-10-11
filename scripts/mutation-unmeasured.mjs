/**
 * What a mutation sweep does not see: the code under a TypeScript `as`.
 *
 * Stryker 10.0.0 mutates nothing there. `shouldSkip` in its instrumenter
 * (transformers/babel-transformer.js) passes over a node `isTypeNode`
 * accepts, and that list (util/syntax-helpers.js) holds 'TSAsExpression': the
 * whole subtree goes unread, so the `i - 1` of `lines[i - 1] as string` and
 * every entry of a table written `{ ... } as const` make no mutant, and no
 * test is held to them. The sweeps of 0.14.1's source had 23 such places
 * under 19 casts and not one mutant inside them (ADR-0007, 2026-10-12).
 * `satisfies` and `!` are not on that list, and neither is a name: a value
 * hoisted to a constant and cast there is read like any other.
 *
 * So this counts, under every outermost `as`, the nodes one of Stryker's
 * mutators applies to, and fails when there are more than LEFT. A site is a
 * place a mutator applies, not a mutant: each makes one to three. The
 * mutators are read from Stryker's own (mutators/*.js), and three are counted
 * wider than Stryker applies them, since the number wanted is none: a regular
 * expression it finds nothing to change in, the body of a constructor it
 * leaves alone, and a call statement or a `throw new`, which it drops only
 * where no other mutant stands under the statement.
 *
 *   node scripts/mutation-unmeasured.mjs [report]    a sweep's report, as the sweep read each file
 *   node scripts/mutation-unmeasured.mjs --sources   the files the configuration mutates, as they are on disk
 *
 * The report is reports/mutation/mutation.json unless one is named: the merged
 * report, which the workflow's score job has just written.
 */

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mutates } from './mutation-shards.mjs';

// The parser Stryker's instrumenter loads, found from the instrumenter and
// not from here: npm installs it beneath that package, and the copy at the
// top of node_modules is another major, brought by vitest's coverage
// provider. It is no dependency of this package, and deliberately so, as the
// two the merge imports are not: what is counted is what Stryker would read.
// Where Stryker is not installed this import fails and the script with it,
// which is the answer wanted: a count nobody took is not a count of none.
const instrumenter = createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/instrumenter'));
const { parse } = await import(pathToFileURL(instrumenter.resolve('@babel/parser')).href);

// Sites left under an `as`, where no rewrite keeps the types the compiler
// sees. Each has a comment beside it in the source saying what stands under
// it and why. There are none.
export const LEFT = 0;

// The methods MethodExpression renames or removes, in both directions.
const METHODS = new Set([
  'charAt', 'endsWith', 'startsWith', 'every', 'some', 'filter', 'reverse', 'slice', 'sort', 'substr', 'substring',
  'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'min', 'max',
  'setDate', 'setTime', 'setFullYear', 'setMonth', 'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds',
  'setUTCDate', 'setUTCFullYear', 'setUTCMonth', 'setUTCHours', 'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds',
]);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const EQUALITY = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==']);
const ASSIGNMENT = new Set(['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '&&=', '||=', '??=']);
const LOGICAL_ASSIGNMENT = new Set(['&&=', '||=', '??=']);
const UNARY = new Set(['!', '+', '-', '~']);
const TEXT = new Set(['StringLiteral', 'TemplateLiteral']);

const named = (node, name) => node.type === 'Identifier' && node.name === name;

// StringLiteral's `isValidParent`: a key, a module's name and the argument of
// `require`, `Symbol` and `import` are left as they are.
function stringSite(parent, key) {
  switch (parent.type) {
    case 'ObjectProperty':
    case 'ClassProperty':
      return key !== 'key';
    case 'ObjectMethod':
    case 'ImportExpression':
    case 'ExpressionStatement':
    case 'JSXAttribute':
      return false;
    case 'CallExpression':
      return !(named(parent.callee, 'require') || named(parent.callee, 'Symbol') || parent.callee.type === 'Import');
    default:
      return true;
  }
}

/** Whether one of Stryker's mutators applies at this node. */
function site(node, parent, key) {
  switch (node.type) {
    case 'StringLiteral':
      return stringSite(parent, key);
    case 'TemplateLiteral':
    case 'BooleanLiteral':
    case 'ArrayExpression':
    case 'RegExpLiteral':
    case 'LogicalExpression':
    case 'UpdateExpression':
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
      return true;
    case 'SwitchCase':
      return node.consequent.length > 0;
    case 'ObjectExpression':
      return node.properties.length > 0;
    case 'BlockStatement':
      return node.body.length > 0;
    case 'ArrowFunctionExpression':
      return node.body.type !== 'BlockStatement' && !named(node.body, 'undefined');
    case 'BinaryExpression': {
      if (EQUALITY.has(node.operator)) return true;
      // ArithmeticOperator leaves a concatenation alone, which it knows by a
      // string on either side.
      const left = node.left.type === 'BinaryExpression' ? node.left.right : node.left;
      return ARITHMETIC.has(node.operator) && !TEXT.has(node.right.type) && !TEXT.has(left.type);
    }
    case 'UnaryExpression':
      return UNARY.has(node.operator);
    case 'AssignmentExpression':
      return ASSIGNMENT.has(node.operator) && (LOGICAL_ASSIGNMENT.has(node.operator) || !TEXT.has(node.right.type));
    case 'OptionalMemberExpression':
      return node.optional === true;
    case 'NewExpression':
      return named(node.callee, 'Array');
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const { callee } = node;
      const method = (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.property.type === 'Identifier' && METHODS.has(callee.property.name);
      return method || node.optional === true || (node.type === 'CallExpression' && named(callee, 'Array'));
    }
    case 'ExpressionStatement':
      return node.expression.type === 'CallExpression' && node.expression.callee.type !== 'Super';
    case 'ThrowStatement':
      return node.argument.type === 'NewExpression';
    default:
      return false;
  }
}

// The expressions TypeScript writes around a value. Every other `TS` node is
// a type, and a type holds nothing a program runs.
const AROUND_A_VALUE = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSParameterProperty']);
const isType = (node) => node.type.startsWith('TS') && !AROUND_A_VALUE.has(node.type);

const NOT_A_CHILD = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);

function children(node) {
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_A_CHILD.has(key) || value === null || typeof value !== 'object') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof child.type === 'string') found.push([key, child]);
    }
  }
  return found;
}

function sitesUnder(node, parent, key) {
  if (isType(node)) return 0;
  let count = site(node, parent, key) ? 1 : 0;
  for (const [childKey, child] of children(node)) count += sitesUnder(child, node, childKey);
  return count;
}

// Stryker stops at the first `as` it meets, so one inside another is the
// outer one's.
function outermost(node, found) {
  if (node.type === 'TSAsExpression') {
    found.push(node);
    return;
  }
  for (const [, child] of children(node)) outermost(child, found);
}

const SHOWN = 96;
const shown = (text) => (text.length > SHOWN ? `${text.slice(0, 60)} ... ${text.slice(-30)}` : text);

/**
 * Every outermost `as` of one source: where it starts, the sites under it,
 * and its text on one line. A source that does not parse throws: a file
 * nobody could read is not a file with nothing under a cast.
 */
export function castsOf(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const found = [];
  outermost(ast.program, found);
  return found.map((node) => ({
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
    sites: sitesUnder(node.expression, node, 'expression'),
    text: shown(source.slice(node.start, node.end).replace(/\s+/g, ' ')),
  }));
}

// A report's positions count columns from one, as the casts above do.
function within(cast, { start, end }) {
  const after = start.line > cast.line || (start.line === cast.line && start.column >= cast.column);
  const before = end.line < cast.end.line || (end.line === cast.end.line && end.column <= cast.end.column);
  return after && before;
}

/**
 * The count over a set of files, each `{ source, mutants? }` under its name.
 * `inside` is the mutants a report has within a cast that has a site: none,
 * for as long as Stryker reads a cast the way this script says it does.
 */
export function measure(files) {
  const rows = [];
  let casts = 0;
  let inside = 0;
  for (const name of Object.keys(files).sort()) {
    const { source, mutants = [] } = files[name];
    let found;
    try {
      found = castsOf(source);
    } catch (error) {
      throw new Error(`${name} does not parse, so what stands under an \`as\` in it was not counted: ${error.message}`);
    }
    casts += found.length;
    for (const cast of found) {
      if (cast.sites === 0) continue;
      const held = mutants.filter((mutant) => within(cast, mutant.location)).length;
      inside += held;
      rows.push({ file: name, line: cast.line, sites: cast.sites, text: cast.text, mutants: held });
    }
  }
  return { files: Object.keys(files).length, casts, sites: rows.reduce((sum, row) => sum + row.sites, 0), inside, rows };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What the count comes to against the number recorded as left: the lines to print, and whether it passes. */
export function verdict(measured, left = LEFT) {
  const { files, casts, sites, inside, rows } = measured;
  const lines = [
    rows.length === 0
      ? `${plural(files, 'file')}, ${plural(casts, '`as` expression')}, and nothing a mutator reads under any of them.`
      : `${plural(files, 'file')}, ${plural(casts, '`as` expression')}: ${plural(sites, 'site')} under ${rows.length} of them, where the sweep makes no mutant. ${left} ${left === 1 ? 'is' : 'are'} recorded as left.`,
    ...rows.map((row) => `  ${row.file}:${row.line}  ${plural(row.sites, 'site')}  ${row.text}`),
  ];
  if (inside > 0) {
    lines.push(`The report has ${plural(inside, 'mutant')} inside those expressions: this Stryker reads under an \`as\`, and scripts/mutation-unmeasured.mjs no longer describes it.`);
  }
  if (sites > left) {
    return {
      passed: false,
      lines,
      message: `${plural(sites, 'site')} under an \`as\`, and ${left} recorded as left. No test is held to what stands there: hoist the value and cast the name, write \`!\` or \`satisfies\`, or record the site in scripts/mutation-unmeasured.mjs with the reason beside the code.`,
    };
  }
  return { passed: true, lines, message: null };
}

/** The files `mutate` selects under `src`, read from disk. */
export function mutatedSources(patterns, root = '.') {
  const files = {};
  for (const entry of readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (mutates(patterns, name)) files[name] = { source: readFileSync(path.join(root, name), 'utf8') };
  }
  return files;
}

async function main(argv) {
  const [argument = 'reports/mutation/mutation.json', ...rest] = argv;
  if (rest.length > 0 || (argument.startsWith('-') && argument !== '--sources')) {
    console.error('usage: node scripts/mutation-unmeasured.mjs [a sweep\'s report] | --sources');
    return 2;
  }
  let files;
  if (argument === '--sources') {
    const { default: config } = await import(pathToFileURL(path.resolve('stryker.config.mjs')).href);
    files = mutatedSources(config.mutate);
  } else {
    files = JSON.parse(readFileSync(argument, 'utf8')).files;
  }
  const result = verdict(measure(files));
  console.log(result.lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.lines[0]}\n\n`);
  }
  if (result.passed) return 0;
  console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${result.message}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
