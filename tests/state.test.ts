import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../src/directives.js';
import { scanMarkdown } from '../src/markdown.js';
import { KNOWN_STATE_WORDS, resolveItemState, type ResolvedState } from '../src/state.js';
import { createLineIndex } from '../src/source.js';
import type { Disposition, StateSignal } from '../src/types.js';

/** Resolves the state of the first list item in a snippet. */
function stateOf(md: string, options: { section?: string[]; obligationSection?: boolean } = {}): ResolvedState {
  const doc = scanMarkdown(md);
  const item = doc.listItems[0];
  if (!item) throw new Error('snippet contains no list item');
  const directives = parseDirectives(doc.comments);
  const directive = directives.find((d) => d.name === 'spec-item') ?? null;
  return resolveItemState({
    file: 'test.md',
    index: createLineIndex(doc.text),
    item,
    section: options.section ?? [],
    directive,
    inObligationSection: options.obligationSection ?? false,
  });
}

describe('checkbox signals', () => {
  it('reads the universal two', () => {
    expect(stateOf('- [ ] work').disposition).toBe('unresolved');
    expect(stateOf('- [x] work').disposition).toBe('satisfied');
  });

  it('reads the nuanced ones instead of flattening them', () => {
    expect(stateOf('- [~] work').disposition).toBe('narrowed');
    expect(stateOf('- [~] work').openness).toBe('partial');
    expect(stateOf('- [/] work').openness).toBe('partial');
    expect(stateOf('- [-] work').disposition).toBe('rejected');
    expect(stateOf('- [?] work').openness).toBe('open');
  });

  it('falls back to open for an item with no signal at all', () => {
    const state = stateOf('- just a bullet');
    expect(state.disposition).toBe('unresolved');
    expect(state.evidence.source).toBe('default');
  });
});

describe('prose markers', () => {
  it('finds a resolution written on a continuation line', () => {
    const md = ['- [ ] Should the write path shard before the migration?', '  **Resolved (2026-03):** no.'].join('\n');
    const state = stateOf(md);
    expect(state.disposition).toBe('satisfied');
    expect(state.openness).toBe('closed');
    expect(state.evidence.source).toBe('marker');
  });

  it('reports the checkbox it disagreed with instead of hiding it', () => {
    const md = ['- [ ] Should we shard?', '  **Resolved:** no.'].join('\n');
    const state = stateOf(md);
    expect(state.conflicts.map((c) => c.source)).toEqual(['checkbox']);
  });

  it('does not report a conflict when the signals agree', () => {
    const md = ['- [x] Should we shard?', '  **Resolved:** no.'].join('\n');
    expect(stateOf(md).conflicts).toEqual([]);
  });

  it('distinguishes accepted debt from a resolution', () => {
    const md = '- [ ] Add retry budgets. **Accepted debt:** ships next quarter.';
    const state = stateOf(md);
    expect(state.disposition).toBe('accepted-debt');
    expect(state.openness).toBe('closed');
  });

  it('distinguishes a narrowing from a closure', () => {
    const md = ['- [ ] Replace the whole gateway.', '  **Narrowed:** only the payment path, the rest stays.'].join(
      '\n',
    );
    const state = stateOf(md);
    expect(state.disposition).toBe('narrowed');
    expect(state.openness).toBe('partial');
  });

  it('reads an obviated item, which is what makes a premise stale', () => {
    const md = '- [ ] Work around the 4 KB row limit. **Moot** - the limit was removed in v9.';
    const state = stateOf(md);
    expect(state.disposition).toBe('obviated');
    expect(state.openness).toBe('closed');
  });

  it('prefers the longer phrase over the shorter one it contains', () => {
    const md = '- [ ] Ship the API. **Partially resolved:** read paths only.';
    expect(stateOf(md).disposition).toBe('narrowed');
  });

  it('accepts SHOUTED markers without a colon', () => {
    expect(stateOf('- [ ] Ship it.\n  RESOLVED - done in #412').disposition).toBe('satisfied');
  });

  it('accepts an emphasised marker without a colon', () => {
    expect(stateOf('- [ ] Ship it. **Moot** now.').disposition).toBe('obviated');
  });
});

describe('marker false positives', () => {
  // These are the cases that make teams abandon regex-based spec linters.
  it('ignores a marker word used as ordinary prose', () => {
    const state = stateOf('- [ ] We resolved to keep the queue, so decide the retention window.');
    expect(state.disposition).toBe('unresolved');
  });

  it('ignores a marker word in the middle of a sentence', () => {
    const state = stateOf('- [ ] Check whether the done flag is still written by the worker.');
    expect(state.disposition).toBe('unresolved');
  });

  it('ignores a marker inside an inline code span', () => {
    // The scanner masks code, so `**Resolved:**` in a sample never closes an item.
    const md = '- [ ] Document the `**Resolved:**` convention for item bodies.';
    expect(stateOf(md).disposition).toBe('unresolved');
  });

  it('ignores markers inside a fenced block nested under the item', () => {
    const md = ['- [ ] Document the convention.', '', '  ```md', '  **Resolved:** example', '  ```'].join('\n');
    expect(stateOf(md).disposition).toBe('unresolved');
  });
});

describe('strikethrough', () => {
  it('treats a fully struck item as closed', () => {
    expect(stateOf('- ~~Migrate the legacy tables~~').disposition).toBe('satisfied');
  });

  it('leaves a partially struck item open', () => {
    expect(stateOf('- Migrate ~~all~~ the hot tables').disposition).toBe('unresolved');
  });
});

describe('directives', () => {
  it('override every inferred signal', () => {
    const md = ['<!-- @spec-item state="accepted-debt" -->', '- [x] Rework the scheduler'].join('\n');
    const state = stateOf(md);
    expect(state.disposition).toBe('accepted-debt');
    expect(state.evidence.source).toBe('directive');
  });

  it('accept friendly synonyms', () => {
    const md = ['- [ ] Rework the scheduler', '  <!-- @spec-item state="moot" -->'].join('\n');
    expect(stateOf(md).disposition).toBe('obviated');
  });

  it('are ignored when the state word is not recognised', () => {
    const md = ['<!-- @spec-item state="banana" -->', '- [x] Rework the scheduler'].join('\n');
    expect(stateOf(md).disposition).toBe('satisfied');
  });
});

describe('precedence', () => {
  it('lets the last of two equally specific markers win', () => {
    const md = ['- [ ] Ship it.', '  **Resolved:** yes.', '  **Reopened:** the benchmark regressed.'].join('\n');
    expect(stateOf(md).disposition).toBe('unresolved');
  });

  it('lets a section signal decide only when nothing else speaks', () => {
    const state = stateOf('- Should we shard?', { section: ['Open Questions'], obligationSection: true });
    expect(state.evidence.source).toBe('section');
    expect(state.openness).toBe('open');
  });

  it('lets strikethrough outrank the checkbox, and names the checkbox it overrode', () => {
    const state = stateOf('- [ ] ~~Migrate the legacy tables~~');
    expect(state.disposition).toBe('satisfied');
    expect(state.evidence.source).toBe('strikethrough');
    expect(state.conflicts.map((signal) => signal.source)).toEqual(['checkbox']);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The README's table of every checkbox, marker and `state=` word, row by row.
 * The table is what a writer reads to learn what closes an item, so it is what
 * these hold the resolver to.
 */
function documentedSignals(): { checkbox: [Disposition, string][]; marker: [Disposition, string][]; state: [Disposition, string][] } {
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf('<summary>Every checkbox, marker');
  const block = readme.slice(start, readme.indexOf('</details>', start));
  const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  const out = { checkbox: [] as [Disposition, string][], marker: [] as [Disposition, string][], state: [] as [Disposition, string][] };
  for (const match of block.matchAll(/^\| `([a-z-]+)` \|(.*)\|(.*)\|(.*)\|$/gm)) {
    const disposition = match[1] as Disposition;
    for (const box of ticked(match[2] as string)) out.checkbox.push([disposition, box]);
    for (const marker of ticked(match[3] as string)) out.marker.push([disposition, marker]);
    for (const word of ticked(match[4] as string)) out.state.push([disposition, word]);
  }
  return out;
}

/** The text a signal points at. */
const spoken = (md: string, signal: StateSignal): string => md.slice(signal.at.span.start.offset, signal.at.span.end.offset);

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

describe('the documented checkboxes, markers and state words', () => {
  it('are read from the README, every disposition of them', () => {
    const { checkbox, marker, state } = documentedSignals();
    expect(new Set(marker.map(([disposition]) => disposition)).size).toBe(7);
    expect(checkbox.length).toBe(10);
    expect(marker.length).toBeGreaterThan(70);
    expect(state.length).toBeGreaterThan(15);
  });

  it('each checkbox is a signal for its row', () => {
    for (const [disposition, box] of documentedSignals().checkbox) {
      const state = stateOf(`- ${box} Ship the export`);
      expect([box, state.disposition, state.evidence.source]).toEqual([box, disposition, 'checkbox']);
    }
  });

  it('each marker, punctuated on the line under the item, decides its row', () => {
    for (const [disposition, marker] of documentedSignals().marker) {
      const state = stateOf(`- [ ] Ship the export\n  ${capitalised(marker)}: see #412.`);
      expect([marker, state.disposition, state.evidence.source]).toEqual([marker, disposition, 'marker']);
    }
  });

  it('document every state word the code exports', () => {
    const documented = documentedSignals().state.map(([, word]) => word);
    expect([...KNOWN_STATE_WORDS].sort()).toEqual(documented.sort());
  });

  it('each state word, in a directive, decides its row over a ticked box', () => {
    for (const [disposition, word] of documentedSignals().state) {
      const state = stateOf(`<!-- @spec-item state="${word}" -->\n- [x] Ship the export`);
      expect([word, state.disposition, state.evidence.source]).toEqual([word, disposition, 'directive']);
    }
  });
});

describe('where a marker counts', () => {
  it('at the start of a line under an item whose first line ends without a stop', () => {
    expect(stateOf('- [ ] Pick a shard key\n  **Decided:** tenant id.').disposition).toBe('satisfied');
  });

  it('on the continuation of an item inside a block quote', () => {
    expect(stateOf('> - [ ] Pick a shard key\n> **Decided:** tenant id.').disposition).toBe('satisfied');
  });

  it('under the README example, however far the answer is indented', () => {
    const md = [
      '- [ ] Should the write path shard before the migration?',
      '      **Resolved (2026-03):** no — one node holds three years of growth.',
    ].join('\n');
    const state = stateOf(md);
    expect(state.disposition).toBe('satisfied');
    expect(state.conflicts.map((signal) => signal.source)).toEqual(['checkbox']);
  });

  it('after an opening bracket', () => {
    expect(stateOf('- [ ] Ship the export (done: #412)').disposition).toBe('satisfied');
  });

  it('not in the middle of a sentence, punctuated or not', () => {
    expect(stateOf('- [ ] Decide what counts as resolved: the ticket or the deploy.').disposition).toBe('unresolved');
    expect(stateOf('- [ ] Agree when the export is **done** with the data team.').disposition).toBe('unresolved');
  });
});

describe('what qualifies a marker', () => {
  it('any of the four stops after it', () => {
    for (const line of ['Resolved: one node.', 'Resolved： one node.', 'Resolved - one node.', 'Done. Landed in #412.']) {
      expect([line, stateOf(`- [ ] Shard the write path\n  ${line}`).disposition]).toEqual([line, 'satisfied']);
    }
  });

  it('shouting it, with nothing after', () => {
    expect(stateOf('- [ ] Shard the write path\n  RESOLVED in #412').disposition).toBe('satisfied');
  });

  it('not a capital letter alone', () => {
    expect(stateOf('- [ ] Shard the write path\n  Resolved in #412 for the read path only').disposition).toBe(
      'unresolved',
    );
  });

  it('emphasis only when it closes on the marker', () => {
    expect(stateOf('- [ ] Pick the cohort. **Closed beta** starts in May.').disposition).toBe('unresolved');
    expect(stateOf('- [ ] Pick the cohort. **Closed** in #412.').disposition).toBe('satisfied');
  });

  it('spaced or hyphenated, whichever the table has', () => {
    expect(stateOf('- [ ] Retry budgets. **Tech-debt:** next quarter.').disposition).toBe('accepted-debt');
    expect(stateOf("- [ ] Retry budgets. **Won't-fix:** next quarter.").disposition).toBe('accepted-debt');
    expect(stateOf('- [ ] Retry budgets. **Follow up in:** ADR-0011.').disposition).toBe('delegated');
  });

  it('the whole marker, where a shorter one begins it', () => {
    // `complete` begins `completed`; read first, it would leave `d:` behind and
    // the marker would not qualify at all.
    expect(stateOf('- [ ] Ship the export. **Completed:** in #412.').disposition).toBe('satisfied');
  });
});

describe('strikethrough', () => {
  it('only when one strike runs the whole line', () => {
    expect(stateOf('- ~~Migrate~~ the hot tables and ~~the cold ones~~').disposition).toBe('unresolved');
    expect(stateOf('- ~~A~~').disposition).toBe('satisfied');
  });

  it('not when the tildes never close', () => {
    // Markdown renders an unpaired `~~` as the characters themselves.
    expect(stateOf('- ~~Migrate the legacy tables').disposition).toBe('unresolved');
    expect(stateOf('- Migrate the legacy tables~~').disposition).toBe('unresolved');
  });

  it('not when the line is the fence of a code block', () => {
    for (const fence of ['~~~', '~~~~', '~~~~~', '~~~~~~']) {
      const state = stateOf(`- ${fence}\n  migrate --all\n  ${fence}`);
      expect([fence, state.disposition, state.evidence.source]).toEqual([fence, 'unresolved', 'default']);
    }
  });
});

describe('what a signal carries', () => {
  it('the checkbox as written, at the checkbox', () => {
    const md = '- [ ] Ship the export';
    const { evidence } = stateOf(md);
    expect([evidence.raw, spoken(md, evidence)]).toEqual(['[ ]', '[ ]']);
  });

  it('the marker as written, at the marker', () => {
    const md = '- [x] Ship the export\n  **Resolved:** in #412.';
    const { evidence } = stateOf(md);
    expect([evidence.source, evidence.raw, spoken(md, evidence)]).toEqual(['marker', 'Resolved', 'Resolved']);
  });

  it('the struck line, at the line', () => {
    const md = '- ~~Ship the export~~';
    const { evidence } = stateOf(md);
    expect([evidence.raw, spoken(md, evidence)]).toEqual(['~~Ship the export~~', '~~Ship the export~~']);
  });

  it('the state word, at the word', () => {
    const md = '<!-- @spec-item state="debt" -->\n- [x] Rework the scheduler';
    const { evidence } = stateOf(md);
    expect([evidence.disposition, evidence.raw, spoken(md, evidence)]).toEqual(['accepted-debt', 'debt', 'debt']);
  });

  it('the heading an item sits under, for a section', () => {
    const { evidence } = stateOf('- Should we shard?', { section: ['Design', 'Open Questions'], obligationSection: true });
    expect([evidence.source, evidence.disposition, evidence.raw]).toEqual(['section', 'unresolved', 'Open Questions']);
  });

  it('nothing, for the default, which is open and in conflict with nothing', () => {
    const state = stateOf('- just a bullet');
    expect(state.openness).toBe('open');
    expect(state.conflicts).toEqual([]);
    expect([state.evidence.source, state.evidence.disposition, state.evidence.raw]).toEqual([
      'default',
      'unresolved',
      '',
    ]);
  });
});
