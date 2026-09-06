import { describe, expect, it } from 'vitest';

import { parseDirectives } from '../src/directives.js';
import { scanMarkdown } from '../src/markdown.js';
import { resolveItemState, type ResolvedState } from '../src/state.js';
import { createLineIndex } from '../src/source.js';

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
});
