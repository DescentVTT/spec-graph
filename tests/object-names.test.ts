import { describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, main } from '../src/cli.js';
import { extractSpecifications } from '../src/extract.js';
import { familyFromPath } from '../src/identity.js';
import { compileProjectRules } from '../src/project-rules.js';
import { analyseSources, type Source } from '../src/runner.js';
import { attributesOf, parseQuery, query, QueryError } from '../src/select.js';
import { KNOWN_STATE_WORDS } from '../src/state.js';
import { parseFrontMatter, toRecord } from '../src/yaml.js';

/**
 * Names every JavaScript object answers to - `constructor`, `toString`,
 * `__proto__` - written where a person writes a word: a selector, a
 * document's front matter, a directive, a table header, a directory.
 *
 * Each is an unknown word there, and is read as any other unknown word is.
 * A table kept as an object answered to them: `constructor` was a node type,
 * a state, a relation column and a family directory, and a front-matter key
 * of every document. Each test below reads the name beside a word no table
 * holds, and expects the two to be read alike.
 */

const NAMES: readonly string[] = ['constructor', 'toString', '__proto__'];

/** A word of the same shape that nothing answers to. */
const PLAIN = 'nonesuch';

const analyse = (files: Record<string, string>, options: Parameters<typeof analyseSources>[1] = {}) =>
  analyseSources(
    Object.entries(files).map(([path, text]): Source => ({ path, text })),
    options,
  );

const refusal = (selector: string): QueryError => {
  try {
    parseQuery(selector);
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error(`"${selector}" parsed`);
};

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(...argv: string[]): Promise<Run> {
  let out = '';
  let err = '';
  const code = await main({
    argv,
    cwd: process.cwd(),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { NO_COLOR: '1', SPEC_GRAPH_ASCII: '1' },
    isTTY: false,
  });
  return { code, out, err };
}

const DEMO = 'tests/fixtures/demo';

/* -------------------------------------------------------------------------- */

describe('a node type in a selector', () => {
  it('is refused by name when it is one every object answers to, as any unknown type is', () => {
    for (const word of ['constructor', 'toString', PLAIN]) {
      const error = refusal(`${word}[status=draft]`);
      expect(error.message, word).toBe(`unknown node type "${word}", expected one of: document, item, * (any)`);
      expect(error.offset, word).toBe(0);
    }
  });

  it('is no word at all when it begins with an underscore, whichever name it is', () => {
    for (const word of ['__proto__', `__${PLAIN}__`]) {
      expect(refusal(word).message, word).toBe('expected a node type (document, item or *) or a [predicate]');
    }
  });

  it('ends a query with a usage error and exit 2, where it ended with no matches and exit 1', async () => {
    const refused = await run('query', 'constructor', '--root', DEMO, '--no-config');
    expect(refused.code).toBe(EXIT_ERROR);
    expect(refused.err).toContain('unknown node type "constructor", expected one of: document, item, * (any)');
    expect(refused.out).toBe('');
  });
});

/* -------------------------------------------------------------------------- */

describe('a front-matter key in a selector', () => {
  const PLAIN_DOCUMENTS = {
    'docs/adr/0001-owned.md': '---\nstatus: accepted\nowner: platform\n---\n\n# Owned\n',
    'docs/adr/0002-bare.md': '# Bare\n',
  };
  const found = (files: Record<string, string>, selector: string): string[] =>
    query(analyse(files).graph, selector).map((match) => match.nodes[0]?.id ?? '');

  it('answers nothing for a key no document wrote, whatever every object answers to', () => {
    for (const key of [...NAMES, 'valueOf', 'hasOwnProperty', PLAIN]) {
      expect(found(PLAIN_DOCUMENTS, `document[fm.${key}]`), key).toEqual([]);
      expect(found(PLAIN_DOCUMENTS, `document[fm.${key}=platform]`), key).toEqual([]);
      // An absent value is not the value, so every document differs from it.
      expect(found(PLAIN_DOCUMENTS, `document[fm.${key}!=platform]`), key).toEqual(['ADR-0001', 'ADR-0002']);
    }
  });

  it('gives no value for such a key, where it gave what the object inherits', () => {
    const { graph } = analyse(PLAIN_DOCUMENTS);
    const owned = graph.document('ADR-0001');
    expect(owned).toBeDefined();
    for (const key of [...NAMES, PLAIN]) {
      expect(attributesOf(owned as NonNullable<typeof owned>, `fm.${key.toLowerCase()}`), key).toEqual([]);
    }
    expect(attributesOf(owned as NonNullable<typeof owned>, 'fm.owner')).toEqual(['platform']);
  });

  it('reads the key in the documents that wrote it, and in no other', () => {
    for (const key of [...NAMES, PLAIN]) {
      const files = {
        ...PLAIN_DOCUMENTS,
        'docs/adr/0003-named.md': `---\nstatus: accepted\n${key}: platform\n---\n\n# Named\n`,
        'docs/adr/0004-listed.md': `---\nstatus: accepted\n${key}: [storage, platform]\n---\n\n# Listed\n`,
      };
      expect(found(files, `document[fm.${key}]`), key).toEqual(['ADR-0003', 'ADR-0004']);
      expect(found(files, `document[fm.${key}=platform]`), key).toEqual(['ADR-0003', 'ADR-0004']);
      expect(found(files, `document[fm.${key}=storage]`), key).toEqual(['ADR-0004']);
    }
  });

  it('does not take a list written under __proto__ for the keys 0 and length', () => {
    const files = { 'docs/adr/0001-listed.md': '---\nstatus: accepted\n__proto__: [storage, platform]\n---\n\n# Listed\n' };
    expect(found(files, 'document[fm.0]')).toEqual([]);
    expect(found(files, 'document[fm.length]')).toEqual([]);
    expect(found(files, 'document[fm.status=accepted]')).toEqual(['ADR-0001']);
  });

  it('ends a query with no matches and exit 1, where it ended on a stack trace', async () => {
    for (const key of NAMES) {
      const answered = await run('query', `document[fm.${key}]`, '--root', DEMO, '--no-config');
      expect(answered.code, key).toBe(EXIT_FAILED);
      expect(answered.out, key).toMatch(/^no matches \(searched \d+ nodes\)\n$/);
      expect(answered.err, key).toBe('');
    }
  });

  it('is left as written in a project rule message when no document wrote it, where the check ended on a stack trace', () => {
    for (const key of [...NAMES, PLAIN]) {
      const { rules, problems } = compileProjectRules(
        { owned: { query: 'document[status=accepted]', message: `{0} is owned by {0.fm.${key}}` } },
        '.spec-graph.json',
      );
      expect(problems, key).toEqual([]);
      const { diagnostics } = analyse(PLAIN_DOCUMENTS, { projectRules: rules });
      expect(diagnostics.map((diagnostic) => diagnostic.message), key).toEqual([`ADR-0001 is owned by {0.fm.${key}}`]);
    }
  });
});

describe('the record of a document front matter', () => {
  it('holds a key named as every object is as a key of its own, and nothing else changes', () => {
    const record = toRecord(parseFrontMatter('__proto__: [storage, platform]\nconstructor: a\ntoString: b\nowner: c\n'));
    expect(Object.keys(record)).toEqual(['__proto__', 'constructor', 'tostring', 'owner']);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toEqual(['storage', 'platform']);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect('0' in record).toBe(false);
  });

  it('keeps a scalar written under __proto__, which assigning it dropped', () => {
    const record = toRecord(parseFrontMatter('__proto__: platform\n'));
    expect(Object.entries(record)).toEqual([['__proto__', 'platform']]);
  });

  it('keeps the last of a key written twice, as it did', () => {
    expect(toRecord(parseFrontMatter('owner: a\nowner: b\n'))).toEqual({ owner: 'b' });
  });
});

/* -------------------------------------------------------------------------- */

describe('the state a @spec-item directive declares', () => {
  const item = (word: string) => {
    const { graph } = analyse({
      'docs/adr/0001-a.md': `# A\n\n## Open Questions\n\n<!-- @spec-item id="q" state="${word}" -->\n- [x] Rework the scheduler\n`,
    });
    const [only] = graph.items;
    if (only === undefined) throw new Error('no item');
    return only;
  };

  it('is ignored when its word is one every object answers to, as any unknown word is, where the run ended', () => {
    for (const word of [...NAMES, 'CONSTRUCTOR', PLAIN]) {
      const read = item(word);
      // The ticked box decides, as it does with no directive at all.
      expect(read.disposition, word).toBe('satisfied');
      expect(read.openness, word).toBe('closed');
      expect(read.evidence.source, word).toBe('checkbox');
    }
  });

  it('still decides when its word is a state, in whatever case it is written', () => {
    for (const word of ['moot', 'Moot', 'MOOT']) {
      const read = item(word);
      expect(read.disposition, word).toBe('obviated');
      expect(read.evidence.source, word).toBe('directive');
    }
  });

  it('is one of the words the table always listed, in the order it listed them', () => {
    expect(KNOWN_STATE_WORDS.slice(0, 3)).toEqual(['open', 'unresolved', 'todo']);
    expect(KNOWN_STATE_WORDS).toHaveLength(17);
    for (const word of NAMES) expect(KNOWN_STATE_WORDS).not.toContain(word);
  });
});

/* -------------------------------------------------------------------------- */

describe('a column of a register table', () => {
  const register = (header: string): string =>
    [
      '# Decisions',
      '',
      `| ID | Status | ${header} | Title |`,
      '| :- | :----- | :- | :---- |',
      '| ADR-0001 | accepted | ADR-0002 | One |',
      '| ADR-0002 | accepted | | Two |',
    ].join('\n');
  const references = (header: string): string[] =>
    extractSpecifications({ path: 'docs/decisions.md', text: register(header) }).flatMap((spec) =>
      spec.references.map((reference) => `${reference.from} ${reference.kind} ${reference.target} (${reference.origin})`),
    );

  it('declares no relation when its header is a name every object answers to, as any other header', () => {
    const plain = references('Nonesuch');
    expect(plain).toEqual(['ADR-0001 references ADR-0002 (text)']);
    for (const header of ['Constructor', 'constructor', 'toString', '__proto__']) {
      expect(references(header), header).toEqual(plain);
    }
  });

  it('still declares the relation its header names', () => {
    expect(references('Depends on')).toEqual(['ADR-0001 depends-on ADR-0002 (front-matter)']);
  });

  it('draws one edge for the cell, of a kind the graph has, where it drew one of no kind', () => {
    for (const header of ['Constructor', 'toString', '__proto__']) {
      const { graph } = analyse({ 'docs/decisions.md': register(header) });
      const drawn = graph.edges.filter((edge) => edge.kind !== 'contains').map((edge) => `${edge.from} ${edge.kind} ${edge.to}`);
      expect(drawn, header).toEqual(['ADR-0001 references ADR-0002']);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the directory a document is kept in', () => {
  it('names no family when it is a name every object answers to, as any other directory', () => {
    for (const name of [...NAMES, 'CONSTRUCTOR', PLAIN]) {
      expect(familyFromPath(`docs/${name}/0007-sharding.md`), name).toBeNull();
      // A family directory above it still names the family.
      expect(familyFromPath(`docs/adr/${name}/0007-sharding.md`), name).toBe('ADR');
    }
  });

  it('holds a document that is read, where the run that met it ended', () => {
    for (const name of [...NAMES, PLAIN]) {
      const { graph, diagnostics } = analyse({
        [`docs/${name}/0007-sharding.md`]: '---\nstatus: accepted\n---\n\n# Sharding\n\nSee [the cache](0008-cache.md).\n',
        [`docs/${name}/0008-cache.md`]: '---\nstatus: accepted\n---\n\n# Cache\n',
      });
      expect(graph.documents.map((document) => document.id), name).toEqual(['0007-sharding', '0008-cache']);
      expect(graph.out('0007-sharding', ['references']).map((edge) => edge.to), name).toEqual(['0008-cache']);
      expect(diagnostics, name).toEqual([]);
    }
  });

  it('is checked from the command line with exit 0, where the check ended with exit 2 and no report', async () => {
    const { mkdir, rm, writeFile } = await import('node:fs/promises');
    const base = `tests/fixtures/.tmp/object-names-${process.pid}`;
    await rm(base, { recursive: true, force: true });
    try {
      for (const [index, name] of NAMES.entries()) {
        const root = `${base}/${index}`;
        await mkdir(`${root}/docs/${name}`, { recursive: true });
        // A number alone is read within the citing document's family, which
        // is where the directory's name was taken for one.
        await writeFile(`${root}/docs/${name}/0007-seventh.md`, '---\nstatus: accepted\n---\n\n# 0007 Seventh\n\nSee 0001 and #7.\n');
        await writeFile(
          `${root}/docs/${name}/0008-eighth.md`,
          '---\nstatus: accepted\n---\n\n# 0008 Eighth\n\nDepends on 0007 and [seven](0007-seventh.md).\n',
        );
        const checked = await run('check', '--root', root, '--no-config');
        expect(checked.err, name).toBe('');
        expect(checked.out, name).toContain('2 documents');
        expect(checked.code, name).toBe(EXIT_OK);
        const listed = await run('query', 'document', '--root', root, '--no-config');
        expect(listed.out.split('\n').filter((line) => /^\S/.test(line)), name).toEqual(['0007-seventh', '0008-eighth', '2 matches']);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
