/**
 * What a mutation sweep does not read: every place a mutator would have
 * applied that stands under a TypeScript `as`, and every value in a file the
 * configuration leaves out.
 *
 * Stryker 10.0.0 mutates nothing under an `as` expression. `shouldSkip` in
 * its instrumenter (`dist/src/transformers/babel-transformer.js`) asks
 * `isTypeNode`, whose list (`dist/src/util/syntax-helpers.js`) holds
 * `TSAsExpression`, and a node on that list is passed over with everything
 * beneath it: the `i - 1` of `lines[i - 1] as string`, every entry of a table
 * written `{ ... } as const`. No report says so. A mutant that was never made
 * is in no column, so the score reads the same with the index mutated or not.
 * `satisfies`, `!` and a name are not on the list. `TSEnumDeclaration` is, so
 * an enum's initialisers are counted here as well.
 *
 * This reads each source with the parser Stryker reads it with, and counts
 * under every outermost `as` the nodes one of Stryker's mutators applies to.
 * A site is a place, not a mutant: a mutator makes one to three of each. The
 * sweeps of 0.14.1's source had 23 such places under 19 casts and not one
 * mutant inside them, and each was rewritten (ADR-0007, 2026-10-12). `LEFT`
 * is how many the tree is known to keep, and a count above it fails: the
 * sweep's score job runs this on the merged report, and
 * `tests/mutation-unmeasured.test.ts` on the tree.
 *
 * A file `mutate` leaves out is the other way to go unread. `src/types.ts`
 * was left out as holding types alone while it declared six values, 65
 * mutants no sweep made (ADR-0007, 2026-10-14). `valuesOf` names what a
 * source declares that a program runs, and the test holds every file left
 * out to declaring none.
 *
 *   node scripts/mutation-unmeasured.mjs [report]    a sweep's report, each source as the sweep read it
 *   node scripts/mutation-unmeasured.mjs --sources   the files the configuration mutates, as the tree has them
 *
 * The report is reports/mutation/mutation.json unless one is named: the
 * merged report, which the workflow's score job has just written.
 *
 * It needs `@babel/parser`, which this package does not depend on: Stryker
 * brings it, and the copy read here is the one Stryker's instrumenter
 * resolves, so a file is parsed as the sweep parsed it. Where that copy is
 * not installed nothing is measured, and the run fails saying which package
 * it could not find.
 *
 * The counting is spec-core's, which adapted it from @descent-vtt/spec-guard
 * (its ADR-0003, amended 2026-10-12): the tools hold their own sources with
 * the same count.
 */

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mutates } from './mutation-shards.mjs';

/**
 * The sites the tree keeps under an `as`, each with a comment at its code
 * saying what stands under the cast and why no rewrite keeps the types. It
 * moves down with the code and up only with such a comment.
 */
export const LEFT = 0;

export class UnmeasuredError extends Error {
  name = 'UnmeasuredError';
}

// From this script to the parser `parseAsync` of Stryker's `@babel/core`
// calls. npm hoists another major of `@babel/parser` to the top of
// `node_modules` for vitest's coverage provider, so the name alone is not
// asked for.
const PARSER_PATH = ['@stryker-mutator/core/package.json', '@stryker-mutator/instrumenter/package.json', '@babel/core', '@babel/parser'];

/** Stryker's parser, as a function from a TypeScript source to its syntax tree. */
export async function loadParser(from = import.meta.url) {
  let at = from;
  for (const name of PARSER_PATH) {
    try {
      at = createRequire(at).resolve(name);
    } catch {
      throw new UnmeasuredError(
        `Cannot find ${name.replace('/package.json', '')}, on the way to the parser Stryker reads a source with (${PARSER_PATH.map((step) => step.replace('/package.json', '')).join(', then ')}). Nothing was measured: run npm ci, and if Stryker no longer parses with Babel this script reads sources another way than the sweep does.`,
      );
    }
  }
  const { parse } = await import(pathToFileURL(at).href);
  return (source) => parse(source, { sourceType: 'module', plugins: ['typescript'] });
}

// Each list below is a mutator of @stryker-mutator/instrumenter 10.0.0
// (`dist/src/mutators`), by the name a report gives its mutants.

// ArithmeticOperator
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
// EqualityOperator
const EQUALITY = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==']);
// ConditionalExpression, for an expression that is no test of a statement
const BOOLEAN = new Set([...EQUALITY, '&&', '||']);
// LogicalOperator
const LOGICAL = new Set(['&&', '||', '??']);
// AssignmentOperator
const ASSIGNMENT = new Set(['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '&&=', '||=', '??=']);
const LOGICAL_ASSIGNMENT = new Set(['&&=', '||=', '??=']);
// UnaryOperator
const UNARY = new Set(['+', '-', '~']);
// MethodExpression: a method taken away, or swapped for its opposite.
const METHODS = new Set([
  ...['charAt', 'filter', 'reverse', 'slice', 'sort', 'substr', 'substring', 'trim'],
  ...['endsWith', 'startsWith', 'every', 'some', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase'],
  ...['trimEnd', 'trimStart', 'min', 'max', 'setDate', 'setTime', 'setFullYear', 'setMonth', 'setHours', 'setMinutes'],
  ...['setSeconds', 'setMilliseconds', 'setUTCDate', 'setUTCFullYear', 'setUTCMonth', 'setUTCHours', 'setUTCMinutes'],
  ...['setUTCSeconds', 'setUTCMilliseconds'],
]);

const isText = (node) => node.type === 'StringLiteral' || node.type === 'TemplateLiteral';
const isCalled = (node, name) => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name;

// StringLiteral leaves a string alone where an empty one would be no mutant
// of the program's behaviour but of its shape: a key, a module's name.
function stringIsRead(parent, key) {
  if (parent === undefined) return true;
  if (/^(?:Import|Export)|^TSExternalModuleReference$|^JSXAttribute$|^ExpressionStatement$|^TSLiteralType$|^ObjectMethod$/.test(parent.type)) return false;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && key === 'key') return false;
  return !(isCalled(parent, 'require') || isCalled(parent, 'Symbol') || (parent.type === 'CallExpression' && parent.callee.type === 'Import'));
}

/**
 * Whether one of Stryker's mutators applies to this node.
 *
 * `quiet` is whether nothing beneath it is a site: the CallExpression mutator
 * takes a statement away only where it would be the statement's one mutant.
 * A regular expression counts though the Regex mutator makes nothing of a
 * pattern with no class, quantifier, anchor or group to change, and a
 * constructor's block counts though BlockStatement leaves some alone: both
 * err towards saying that something is unread.
 */
function isSite(node, parent, key, quiet) {
  // ConditionalExpression: the test of a loop or an `if`, whatever it is.
  if (key === 'test' && /^(?:If|For|While|DoWhile)Statement$/.test(parent?.type ?? '')) return true;
  switch (node.type) {
    case 'StringLiteral':
      return stringIsRead(parent, key);
    case 'TemplateLiteral':
    case 'BooleanLiteral':
    case 'ArrayExpression':
    case 'UpdateExpression':
      return true;
    case 'RegExpLiteral':
      return node.pattern.length > 0;
    case 'ObjectExpression':
      return node.properties.length > 0;
    case 'BlockStatement':
      return node.body.length > 0;
    case 'ArrowFunctionExpression':
      return node.body.type !== 'BlockStatement' && !(node.body.type === 'Identifier' && node.body.name === 'undefined');
    case 'BinaryExpression': {
      if (BOOLEAN.has(node.operator)) return true;
      const left = node.left.type === 'BinaryExpression' ? node.left.right : node.left;
      return ARITHMETIC.has(node.operator) && !isText(node.right) && !isText(left);
    }
    case 'LogicalExpression':
      return LOGICAL.has(node.operator);
    case 'UnaryExpression':
      return node.prefix && (node.operator === '!' || UNARY.has(node.operator));
    case 'AssignmentExpression':
      return ASSIGNMENT.has(node.operator) && (LOGICAL_ASSIGNMENT.has(node.operator) || !isText(node.right));
    case 'ForStatement':
      return node.test === null || node.test === undefined;
    case 'SwitchCase':
      return node.consequent.length > 0;
    case 'OptionalMemberExpression':
      return node.optional === true;
    case 'OptionalCallExpression':
    case 'CallExpression':
    case 'NewExpression': {
      if (node.type === 'OptionalCallExpression' && node.optional === true) return true;
      const { callee } = node;
      if (node.type !== 'OptionalCallExpression' && callee.type === 'Identifier' && callee.name === 'Array') return true;
      if (node.type === 'NewExpression') return false;
      return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.property.type === 'Identifier' && METHODS.has(callee.property.name);
    }
    case 'ExpressionStatement':
      return quiet && node.expression.type === 'CallExpression' && node.expression.callee.type !== 'Super';
    case 'ThrowStatement':
      return quiet && node.argument.type === 'NewExpression';
    default:
      return false;
  }
}

const NOT_A_CHILD = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_A_CHILD.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === 'object' && typeof item.type === 'string') out.push([key, item]);
    }
  }
  return out;
}

// What of TypeScript's own syntax holds something a program runs: the
// wrappers around an expression, and an enum down to its initialisers. Every
// other `TS` node is a type.
const HOLDS_CODE = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSEnumDeclaration', 'TSEnumBody']);

function countSites(node, parent, key) {
  if (node.type === 'TSEnumMember') return node.initializer ? countSites(node.initializer, node, 'initializer') : 0;
  if (node.type.startsWith('TS') && !HOLDS_CODE.has(node.type)) return 0;
  let beneath = 0;
  for (const [childKey, child] of children(node)) beneath += countSites(child, node, childKey);
  return beneath + (isSite(node, parent, key, beneath === 0) ? 1 : 0);
}

// The outermost only: Stryker stops at the first it meets, and one inside it
// is under it.
function unread(node, found) {
  if (node.type === 'TSAsExpression' || node.type === 'TSEnumDeclaration') {
    found.push(node);
    return;
  }
  for (const [, child] of children(node)) unread(child, found);
}

/**
 * The `as` expressions and enums of one source, outermost only, and of
 * those the ones with a site under them: where each is, how many sites, and
 * its text on one line.
 */
export function unmeasured(source, parse) {
  const found = [];
  unread(parse(source).program, found);
  const hidden = [];
  for (const node of found) {
    const sites = node.type === 'TSAsExpression' ? countSites(node.expression, node, 'expression') : countSites(node, undefined, undefined);
    if (sites === 0) continue;
    const text = source.slice(node.start, node.end).replace(/\s+/g, ' ');
    hidden.push({
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      endLine: node.loc.end.line,
      endColumn: node.loc.end.column + 1,
      sites,
      text: text.length > 100 ? `${text.slice(0, 64)} ... ${text.slice(-28)}` : text,
    });
  }
  return { expressions: found.length, hidden };
}

// A declaration that leaves nothing in the JavaScript: a type, or a name
// declared for the compiler alone.
const isAmbient = (node) => node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration' || node.declare === true;

/**
 * What a source declares, at its top, that a program runs: where each
 * statement starts, and its first line. An import, a re-export, a type and
 * an ambient declaration are none of them. Everything else is, whether or
 * not a mutator has anything to change in it today: a file is left out of a
 * sweep for holding no value, not for holding none a mutant was made of.
 */
export function valuesOf(source, parse) {
  const values = [];
  for (const node of parse(source).program.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'EmptyStatement') continue;
    if (isAmbient(node)) continue;
    if (node.type === 'ExportNamedDeclaration') {
      // `export { a } from`, and `export { a }` of a name declared or
      // imported elsewhere in the file, which is read where it is declared.
      // The parser marks the export of a type, and of a name declared for
      // the compiler alone, as one of a type.
      if (node.exportKind === 'type' || node.declaration === null || node.declaration === undefined) continue;
    }
    const text = source.slice(node.start, node.end).split('\n')[0].trim();
    values.push({ line: node.loc.start.line, text: text.length > 100 ? `${text.slice(0, 97)}...` : text });
  }
  return values;
}

function sourcesUnder(root) {
  const files = [];
  for (const entry of readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  }
  return files.sort();
}

/** The sources the configuration mutates, as the tree has them, by path. */
export function treeSources(patterns, root = '.') {
  return Object.fromEntries(
    sourcesUnder(root)
      .filter((file) => mutates(patterns, file))
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
  );
}

/**
 * The sources the configuration leaves out, by path, each with the values it
 * declares. The copy of spec-core is not among them: its mutants are
 * spec-core's sweep to kill (spec-core ADR-0001).
 */
export function leftOut(patterns, parse, root = '.') {
  return Object.fromEntries(
    sourcesUnder(root)
      .filter((file) => !mutates(patterns, file) && !file.startsWith('src/vendor/'))
      .map((file) => [file, valuesOf(readFileSync(path.join(root, file), 'utf8'), parse)]),
  );
}

/** Every source's count, and the total. A source Stryker's parser cannot read is refused by name. */
export function measure(sources, parse) {
  const files = [];
  let expressions = 0;
  let sites = 0;
  for (const [file, source] of Object.entries(sources)) {
    let read;
    try {
      read = unmeasured(source, parse);
    } catch (error) {
      throw new UnmeasuredError(`${file} could not be parsed, so what stands under an \`as\` in it was not counted: ${error.message}`);
    }
    expressions += read.expressions;
    for (const entry of read.hidden) sites += entry.sites;
    files.push({ file, ...read });
  }
  return { files, expressions, sites };
}

// A report's positions are Stryker's: lines from 1 and columns from 1.
const within = (mutant, entry) => {
  const { start, end } = mutant.location;
  const after = start.line > entry.line || (start.line === entry.line && start.column >= entry.column);
  const before = end.line < entry.endLine || (end.line === entry.endLine && end.column <= entry.endColumn);
  return after && before;
};

/** What a run prints, and whether the count is within what is recorded as left. */
export function verdict(measured, left = LEFT, report = undefined) {
  const hidden = measured.files.flatMap(({ file, hidden: entries }) => entries.map((entry) => ({ file, ...entry })));
  const lines = [
    `${measured.files.length} sources, ${measured.expressions} \`as\` expressions and enums, outermost only; ${hidden.length} of them stand over ${measured.sites} ${measured.sites === 1 ? 'place' : 'places'} a mutator applies.`,
  ];
  if (report !== undefined) {
    const made = hidden.reduce((sum, entry) => sum + report.files[entry.file].mutants.filter((mutant) => within(mutant, entry)).length, 0);
    lines.push(`The report has ${made} ${made === 1 ? 'mutant' : 'mutants'} of those places${made > 0 ? ': Stryker reads under an `as` now, and this count is of something else than it was written for' : ''}.`);
  }
  for (const entry of hidden.sort((a, b) => b.sites - a.sites || a.file.localeCompare(b.file) || a.line - b.line)) {
    lines.push(`  ${String(entry.sites).padStart(3)}  ${entry.file}:${entry.line}  ${entry.text}`);
  }
  const passed = measured.sites <= left;
  const message = passed
    ? `${measured.sites} under an \`as\`, and ${left} recorded as left.`
    : `${measured.sites} under an \`as\`, and ${left} recorded as left: the sweep does not mutate the ${measured.sites - left} more. Write \`x!\` for a lookup that cannot miss, put the cast on a name, or say the type on the declaration or with \`satisfies\` (ADR-0007, 2026-10-12).`;
  return { passed, lines, message };
}

/**
 * `io` is what a run reads and writes besides the console, so that a test
 * can hand it a report and take the summary without a file or a process of
 * its own: a process is seconds on a loaded machine, and a test has thirty.
 */
export async function main(argv, io = {}) {
  const { read = (file) => readFileSync(file, 'utf8'), append = appendFileSync } = io;
  const [argument = 'reports/mutation/mutation.json', ...rest] = argv;
  if (rest.length > 0 || (argument.startsWith('-') && argument !== '--sources')) {
    console.error("usage: node scripts/mutation-unmeasured.mjs [a sweep's merged report] | --sources");
    return 2;
  }
  let result;
  try {
    const parse = await loadParser();
    if (argument === '--sources') {
      const { default: config } = await import(pathToFileURL(path.resolve('stryker.config.mjs')).href);
      result = verdict(measure(treeSources(config.mutate), parse));
    } else {
      const report = JSON.parse(read(argument));
      const sources = Object.fromEntries(Object.entries(report.files).map(([file, entry]) => [file, entry.source]));
      result = verdict(measure(sources, parse), LEFT, report);
    }
  } catch (error) {
    if (!(error instanceof UnmeasuredError)) throw error;
    console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${error.message}`);
    return 1;
  }
  console.log(result.lines.join('\n'));
  if (result.passed) console.log(result.message);
  else console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${result.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    append(process.env.GITHUB_STEP_SUMMARY, `What the sweep does not read: ${result.message}\n\n`);
  }
  return result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
