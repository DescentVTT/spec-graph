import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The launcher, spawned as a person runs it: the exit code is the process's,
 * which no test that calls `main()` can see. Left out of mutation runs, since a
 * mutant is never compiled into dist/.
 */
describe('the launcher', () => {
  beforeAll(() => {
    if (!existsSync('dist/cli.js')) execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
  }, 120_000);

  it('exits with the code main returns', () => {
    const version = spawnSync(process.execPath, ['bin/spec-graph.js', '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);

    const usage = spawnSync(process.execPath, ['bin/spec-graph.js', '--not-a-flag'], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('spec-graph:');
  });

  // main answers what it awaits, in process (cli.test.ts). An error thrown
  // from a callback - a stream's, a timer's - reaches no promise, and only the
  // launcher can answer it. Node's own answer is exit 1, which CI reads as
  // findings.
  it('ends an error nothing awaits with exit 2 and its stack on stderr', () => {
    // Loaded before the launcher: when the run has nothing left to do, it
    // throws where no promise holds the error.
    const stray = 'process.once("beforeExit", () => setImmediate(() => { throw new Error("thrown where nothing awaits"); }));';
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stray)}`, 'bin/spec-graph.js', '--version'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^spec-graph: unexpected error: Error: thrown where nothing awaits\n {4}at /);
    // The run had answered by then, and its answer is not printed twice.
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  describe('a reader that closed the output', () => {
    // The process's own streams never throw this where main awaits it
    // (cli.test.ts holds that case): the write fails, and the stream reports
    // it as an event, which only the launcher can answer.
    const CLOSED = 'spec-graph: stdout was closed before all of the output was written\n';

    /**
     * The launcher with one of its outputs closed by its reader before the run
     * writes to it, as stdout is behind `| head` once head has left. What the
     * other output was sent is the answer.
     */
    function closing(stream: 'stdout' | 'stderr', args: readonly string[]): Promise<{ code: number; read: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['bin/spec-graph.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child[stream].destroy();
        const open = stream === 'stdout' ? child.stderr : child.stdout;
        let read = '';
        open.setEncoding('utf8');
        open.on('data', (chunk: string) => (read += chunk));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code: code ?? -1, read }));
      });
    }

    it.each([
      ['--help', ['--help']],
      ['check', ['check']],
      ['graph, as JSON', ['graph', '--graph-format', 'json']],
    ])('ends %s with exit 2 and one line on stderr, with no stack', async (_name, args) => {
      expect(await closing('stdout', args)).toEqual({ code: 2, read: CLOSED });
    });

    it('says nothing when stderr is the one that closed, on stdout either, and still exits 2', async () => {
      // Left to Node, the error of that write is exit 1.
      expect(await closing('stderr', ['--not-a-flag'])).toEqual({ code: 2, read: '' });
    });

    // A shell's pipe, where Node's own child is a socket pair: the reader has
    // left by the time the run writes. Without a shell there is no pipeline to
    // make, and cmd's has no way to hand back the exit code of its left side.
    it.skipIf(process.platform === 'win32')('says so behind a shell pipe whose reader has left', () => {
      const pipeline = '{ sleep 1; "$0" bin/spec-graph.js --help; echo "exit $?" >&2; } | true';
      const result = spawnSync('sh', ['-c', pipeline, process.execPath], { encoding: 'utf8' });

      expect(result.stderr).toBe(`${CLOSED}exit 2\n`);
    });
  });
});
