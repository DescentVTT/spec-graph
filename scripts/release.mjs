/**
 * The check a release tag has to pass before anything is built, and the three
 * facts the release workflow needs out of it: the version, the npm dist-tag
 * and the notes.
 *
 * A tag is the only thing that publishes (ADR-0021), so it is the only place
 * left to catch a release that says one thing and ships another - a tag that
 * does not name the version in package.json, or a version the changelog has
 * nothing to say about. Both are cheap to check and expensive to find on npm,
 * where a version number can never be used again.
 *
 *   node scripts/release.mjs v0.9.0 [notes-file]
 *
 * Exits 1 on either, and 2 on bad arguments. Under GitHub Actions the outputs
 * go to $GITHUB_OUTPUT; elsewhere they are printed, which is what makes the
 * command worth running by hand before tagging.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseOf(tag, version, changelog) {
  if (tag !== `v${version}`) {
    return `the tag ${tag} does not name the package's version ${version}: tag v${version}, or change the version`;
  }
  const notes = changelogSection(changelog, version);
  if (notes === null) return `CHANGELOG.md has no "## ${version}" section with text in it; describe the release before tagging it`;
  // A prerelease goes out under `next` and never becomes the default install:
  // `npm install` with no version is what most upgrades are, and a candidate
  // reaching them is the one mistake a dist-tag exists to prevent.
  return { version, distTag: version.includes('-') ? 'next' : 'latest', notes };
}

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => headingVersion(line) === version);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body === '' ? null : body;
}

/**
 * The version a `## ` heading names, or null. Keep a Changelog brackets it and
 * follows it with a date, and this file does neither, so both are read.
 */
function headingVersion(line) {
  if (!line.startsWith('## ')) return null;
  const name = line.slice(3).trim().split(/\s/)[0];
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
}

function main(argv) {
  const [tag, notesFile] = argv;
  if (tag === undefined || argv.length > 2) {
    console.error('usage: node scripts/release.mjs <tag> [notes-file]');
    return 2;
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const release = releaseOf(tag, version, readFileSync('CHANGELOG.md', 'utf8'));
  if (typeof release === 'string') {
    console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : ''}${release}`);
    return 1;
  }
  if (notesFile !== undefined) writeFileSync(notesFile, `${release.notes}\n`);
  const outputs = `version=${release.version}\ndist-tag=${release.distTag}\n`;
  const target = process.env.GITHUB_OUTPUT;
  if (target === undefined) process.stdout.write(outputs);
  else appendFileSync(target, outputs);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
