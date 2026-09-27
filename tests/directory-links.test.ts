import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyse, analyseSources, type Source } from '../src/runner.js';

/**
 * A link to a directory, written without the trailing slash.
 *
 * "A link to source code, an image, or a directory is ordinary in a design
 * document" (ADR-0006). `[the guides](../guides/)` was never reported;
 * `[the guides](../guides)` names the same directory and was a reference
 * outside the corpus, "resolves to a file that is not a specification", with
 * a hint to include patterns that could never reach it.
 */

// Named for the process: Stryker runs a test file in several workers at once,
// in one sandbox, and a fixed path is one they write and delete under each other.
const ROOT = `tests/fixtures/.tmp/directory-links-${process.pid}`;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(`${ROOT}/docs/adr`, { recursive: true });
  await mkdir(`${ROOT}/guides`, { recursive: true });
  await writeFile(`${ROOT}/guides/setup.txt`, 'x\n');
  await writeFile(`${ROOT}/CHANGES`, 'x\n');
  await writeFile(
    `${ROOT}/docs/adr/0001-a.md`,
    [
      '---',
      'status: accepted',
      '---',
      '',
      '# A',
      '',
      'See [the guides](../../guides), [the changes](../../CHANGES) and [the gone](../../gone).',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

type Options = Parameters<typeof analyseSources>[1];

/** The rule and message of every finding about a reference, in order. */
function referenceFindings(body: string, options: Options = {}): string[] {
  const sources: Source[] = [{ path: 'docs/adr/0001-a.md', text: `---\nstatus: accepted\n---\n\n# A\n\n${body}\n` }];
  return analyseSources(sources, options)
    .diagnostics.filter((diagnostic) => diagnostic.rule.includes('reference'))
    .map((diagnostic) => `${diagnostic.rule} ${diagnostic.message}`);
}

const guidesOnly = { isDirectory: (path: string) => path === 'guides', fileExists: (path: string) => path === 'guides' };

describe('a link to a directory without a trailing slash', () => {
  it.each(['../../guides', './../../guides', '../../guides#setup'])('is not a reference when the directory is there: %s', (target) => {
    expect(referenceFindings(`The steps live in [the guides](${target}).`, guidesOnly)).toEqual([]);
  });

  it('is asked about as the path it resolves to, from the document holding it', () => {
    const asked: string[] = [];
    const isDirectory = (path: string): boolean => {
      asked.push(path);
      return false;
    };
    referenceFindings('The steps live in [the guides](../guides).', { isDirectory });
    expect(asked).toEqual(['docs/guides']);
  });

  it('is a broken reference when no directory is there', () => {
    expect(referenceFindings('The steps live in [the guides](../../guides).', { isDirectory: () => false })).toEqual([
      'broken-reference "../../guides" does not resolve to any document',
    ]);
  });

  it('is a broken reference as before when the caller says nothing about directories', () => {
    expect(referenceFindings('The steps live in [the guides](../../guides).')).toEqual([
      'broken-reference "../../guides" does not resolve to any document',
    ]);
  });

  it('is a reference outside the corpus when the path is a file with no extension', () => {
    expect(
      referenceFindings('Listed in [the changes](../../CHANGES).', {
        isDirectory: () => false,
        fileExists: (path) => path === 'CHANGES',
      }),
    ).toEqual(['reference-outside-corpus "../../CHANGES" resolves to a file that is not a specification']);
  });

  it('is an identifier while it holds no slash, whatever the disk holds', () => {
    // `guides` could be a document's id as well as a sibling directory, and an
    // identifier that resolves to nothing is the finding: `./guides` says path.
    expect(referenceFindings('The steps live in [the guides](guides).', { isDirectory: () => true })).toEqual([
      'broken-reference "guides" does not resolve to any document',
    ]);
  });

  it('still resolves to a directory-style document before the disk is asked', () => {
    const asked: string[] = [];
    const { graph, diagnostics } = analyseSources(
      [
        { path: 'docs/adr/0001-a.md', text: '# ADR-0001: A\n\nSee [sharding](0007-sharding).\n' },
        { path: 'docs/adr/0007-sharding/README.md', text: '# ADR-0007: Sharding\n' },
      ],
      {
        isDirectory: (path) => {
          asked.push(path);
          return true;
        },
      },
    );
    expect(graph.edges.filter((edge) => edge.kind === 'references').map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      'ADR-0001 -> ADR-0007',
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.rule.includes('reference'))).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('the run on disk', () => {
  it('reads a directory as a directory, a file as a file, and nothing as a broken reference', async () => {
    const { diagnostics } = await analyse({ root: ROOT });
    expect(
      diagnostics.filter((diagnostic) => diagnostic.rule.includes('reference')).map((diagnostic) => `${diagnostic.rule} ${diagnostic.message}`),
    ).toEqual([
      'broken-reference "../../gone" does not resolve to any document',
      'reference-outside-corpus "../../CHANGES" resolves to a file that is not a specification',
    ]);
  });
});
