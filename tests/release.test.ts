/**
 * The gate on a release tag (scripts/release.mjs).
 *
 * A tag is what publishes (ADR-0021), and npm never lets a version number be
 * used again, so every mistake this catches is one that cannot be taken back:
 * a tag that names a version the package does not have, notes that describe a
 * different release, a candidate arriving as the default install. The check
 * runs before anything is built, and these tests are what say it is right.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { changelogSection, releaseOf } from '../scripts/release.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  'Notable changes, newest first.',
  '',
  '## Unreleased',
  '',
  '- Something not yet released.',
  '',
  '## [0.2.0] - 2026-10-01',
  '',
  'A feature.',
  '',
  '### Fixed',
  '',
  '- A defect.',
  '',
  '## 0.2.0-rc.1',
  '',
  '- The candidate.',
  '',
  '## 0.1.1',
  '',
  '## 0.1.0',
  '',
  'The first release.',
  '',
].join('\n');

describe('a tag that names a release', () => {
  it('is accepted with the notes and the dist-tag the workflow publishes under', () => {
    expect(releaseOf('v0.1.0', '0.1.0', CHANGELOG)).toEqual({ version: '0.1.0', distTag: 'latest', notes: 'The first release.' });
  });

  it('sends a prerelease to next, so no upgrade picks it up by accident', () => {
    // `npm install @descent-vtt/spec-graph` with no version takes `latest`.
    expect(releaseOf('v0.2.0-rc.1', '0.2.0-rc.1', CHANGELOG)).toEqual({
      version: '0.2.0-rc.1',
      distTag: 'next',
      notes: '- The candidate.',
    });
  });
});

describe('a tag that names no release', () => {
  it('is refused when it disagrees with the version, and says which way to fix it', () => {
    // Either could be the mistake, so the message names both and picks neither.
    expect(releaseOf('v0.1.1', '0.1.0', CHANGELOG)).toBe(
      "the tag v0.1.1 does not name the package's version 0.1.0: tag v0.1.0, or change the version",
    );
  });

  it('is refused without the v, rather than read as the version it resembles', () => {
    expect(releaseOf('0.1.0', '0.1.0', CHANGELOG)).toContain('does not name');
  });

  it('is refused when the changelog has nothing to say about the version', () => {
    expect(releaseOf('v0.3.0', '0.3.0', CHANGELOG)).toBe(
      'CHANGELOG.md has no "## 0.3.0" section with text in it; describe the release before tagging it',
    );
  });

  it('is refused when the section exists and is empty, which reads as done and is not', () => {
    expect(releaseOf('v0.1.1', '0.1.1', CHANGELOG)).toContain('no "## 0.1.1" section');
  });
});

describe('the notes a version heading covers', () => {
  it('run to the next heading of its level, keeping the ones below it', () => {
    // The sections in this file are a lead paragraph and then `###` headings;
    // a stricter reading would publish the first paragraph and drop the rest.
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('A feature.\n\n### Fixed\n\n- A defect.');
  });

  it('stop at a top-level heading too, and survive CRLF', () => {
    expect(changelogSection('## 1.0.0\r\n\r\n- a\r\n# Appendix\r\ny\r\n', '1.0.0')).toBe('- a');
  });

  it('come from the version asked for, not from one that starts the same way', () => {
    expect(changelogSection('## 0.1.0-rc.1\n\nx\n', '0.1.0')).toBeNull();
    expect(changelogSection('## 0.1.00\n\nx\n', '0.1.0')).toBeNull();
  });

  it('come from a version heading, not from a subsection that happens to be numbered', () => {
    expect(changelogSection('### 0.1.0\n\nx\n', '0.1.0')).toBeNull();
  });

  it('are read under a bracketed heading with a date as readily as a bare one', () => {
    // This file writes `## 0.8.0`; Keep a Changelog writes `## [0.8.0] - date`.
    // Both name the same release, and a release should not turn on which.
    expect(changelogSection('## [0.2.0] - 2026-10-01\n\nx\n', '0.2.0')).toBe('x');
    expect(changelogSection('## 0.2.0\n\nx\n', '0.2.0')).toBe('x');
  });
});

describe('this repository', () => {
  it('describes the version package.json names', () => {
    // The workflow refuses a tag without notes, an hour after the pull request
    // that should have caught it. This fails on that pull request instead.
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(releaseOf(`v${version}`, version, readFileSync('CHANGELOG.md', 'utf8'))).toMatchObject({ version });
  });
});
