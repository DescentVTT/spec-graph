#!/usr/bin/env node
/**
 * Thin launcher. All logic lives in dist/cli.js so the published binary stays a
 * short shim that is trivially auditable.
 */
import { pathToFileURL } from 'node:url';

// main answers the errors it awaits with exit 2. What nothing awaits - a
// stream's error, a timer's, a promise nobody holds - Node ends with exit 1,
// which a script reads as findings: the same answer for those.
process.on('uncaughtException', (error) => {
  process.stderr.write(`spec-graph: unexpected error: ${error?.stack ?? error}\n`);
  process.exit(2);
});

const entry = new URL('../dist/cli.js', import.meta.url);

let cli;
try {
  cli = await import(entry.href);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      `spec-graph: build output missing at ${pathToFileURL(entry.pathname).pathname}\n` +
        'Run "npm run build" first (or install the published package).\n',
    );
    process.exit(2);
  }
  throw error;
}

process.exitCode = await cli.main();
