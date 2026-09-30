import { describe, expect, it } from 'vitest';

import { extractDocument } from '../src/extract.js';
import { phaseOf, supersessionTargetsIn } from '../src/lifecycle.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * Statuses, relations, obligations and markers are read in English.
 *
 * A document may be written in any language, and its status is written in
 * English: `status: superseded`, `## Status` over `Superseded by ADR-0007`.
 * 0.10.0 read Chinese as well, and the reading was taken out again (ADR-0002,
 * ADR-0003 and ADR-0006, amended 2026-09-30): a heuristic in a second language
 * is where false positives come from, and one language is what a small team
 * can keep right. What is here is that a status, a phrase, a heading or a
 * marker in Chinese says nothing, and that the full-width punctuation that
 * stays - a stop at `。？！；`, a comma in a list of successors - only ends a
 * statement sooner or splits a list, and so reports less, never more. Every
 * document is made up for the test.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every document, as `id phase "raw status"`. */
function statuses(files: Record<string, string>): string[] {
  return analyse(files).graph.documents.map((document) => `${document.id} ${document.phase} ${JSON.stringify(document.rawStatus)}`);
}

const one = (text: string): string[] => statuses({ 'docs/adr/0001-a.md': text });

const RETIRED = { 'docs/adr/0002-b.md': '---\nstatus: superseded\n---\n\n# B\n' };

/** The findings on an accepted ADR-0001 whose body is `body`, beside a retired ADR-0002. */
function findings(body: string): string[] {
  return analyse({ ...RETIRED, 'docs/adr/0001-a.md': `---\nstatus: accepted\n---\n\n# A\n\n${body}\n` }).diagnostics.map(
    (diagnostic) => diagnostic.rule,
  );
}

/** How the one reference to ADR-0002 in `body` reads, as `kind` or `kind inverted`. */
function reading(body: string): string {
  const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text: `# A\n\n${body}\n` });
  const found = extracted?.references.filter((reference) => /0002/.test(reference.target)) ?? [];
  expect(found).toHaveLength(1);
  const [reference] = found;
  return `${reference?.kind}${reference?.inverted ? ' inverted' : ''}`;
}

/** The disposition of the one item in `body`. */
function disposition(body: string): string | undefined {
  const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text: `# A\n\n${body}\n` });
  return extracted?.items[0]?.disposition;
}

describe('a status written in Chinese', () => {
  it('is unknown, wherever it is written', () => {
    expect(one('---\nstatus: 已接受\n---\n\n# A\n')).toEqual(['ADR-0001 unknown "已接受"']);
    expect(one('# A\n\n## Status\n\n已被 ADR-0003 取代\n')).toEqual(['ADR-0001 unknown "已被 ADR-0003 取代"']);
    expect(one('# A\n\n| Status | 已棄用 |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown "已棄用"']);
  });

  it('is unknown whatever it holds: a word, a negation, the passive, 已取代 alone', () => {
    for (const status of ['已接受', '草案', '封存', '定案', '暫定接受', '未接受', '被取代', '被 ADR-0003 取代', '已取代']) {
      expect(phaseOf(status), status).toBe('unknown');
    }
  });

  it('names no successor, so no supersession reaches the graph', () => {
    expect(supersessionTargetsIn('已被 ADR-0003 取代')).toEqual([]);
    const { graph } = analyse({
      'docs/adr/0002-b.md': '---\nstatus: 已被 ADR-0003 取代\n---\n\n# B\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\n---\n\n# C\n',
    });
    expect(graph.edges.filter((edge) => edge.kind === 'supersedes')).toEqual([]);
  });

  it('punctuates an English list of successors, full-width or not, and joins none with a Chinese word', () => {
    expect(supersessionTargetsIn('Superseded by ADR-0003，ADR-0004；ADR-0005、（ADR-0006）')).toEqual([
      'ADR-0003',
      'ADR-0004',
      'ADR-0005',
      'ADR-0006',
    ]);
    expect(supersessionTargetsIn('Superseded by ADR-0003 和 ADR-0004')).toEqual(['ADR-0003 和 ADR-0004']);
  });

  it('beside an English word leaves the English word to be read', () => {
    expect(phaseOf('Accepted（已被 ADR-0003 取代）')).toBe('active');
    expect(phaseOf('已接受, superseded by ADR-0003')).toBe('retired');
    expect(supersessionTargetsIn('Superseded by ADR-0003')).toEqual(['ADR-0003']);
  });
});

describe('a status key written in Chinese, or with a full-width colon', () => {
  it('is no status key in front matter, and no problem either: YAML reads a key of any script', () => {
    const extracted = extractDocument({ path: 'docs/adr/0001-a.md', text: '---\n狀態: accepted\n---\n\n# A\n' });
    expect(extracted?.problems).toEqual([]);
    expect(extracted?.document.frontMatter['狀態']).toBe('accepted');
    expect(one('---\n狀態: accepted\n---\n\n# A\n')).toEqual(['ADR-0001 unknown null']);
  });

  it('is no status heading, and neither is Status with a full-width colon', () => {
    expect(one('# A\n\n## 狀態\n\nAccepted\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n## 状态\n\nAccepted\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n## Status：\n\nAccepted\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n## Status:\n\nAccepted\n')).toEqual(['ADR-0001 active "Accepted"']);
  });

  it('is no key of a status table', () => {
    expect(one('# A\n\n| 狀態 | Accepted |\n| --- | --- |\n')).toEqual(['ADR-0001 unknown null']);
    expect(one('# A\n\n| Field | Value |\n| --- | --- |\n| 状态 | Accepted |\n')).toEqual(['ADR-0001 unknown null']);
  });

  it('is no status label, so a section of a register with only one is no specification', () => {
    const register = (label: string): string =>
      `---\nid: REG-1\n---\n\n# Register\n\n## ADR-0007: Sharding\n\n${label} Accepted\n`;
    expect(statuses({ 'docs/register.md': register('**狀態：**') })).toEqual(['REG-1 unknown null']);
    expect(statuses({ 'docs/register.md': register('状态:') })).toEqual(['REG-1 unknown null']);
    expect(statuses({ 'docs/register.md': register('**Status：**') })).toEqual(['REG-1 unknown null']);
    expect(statuses({ 'docs/register.md': register('**Status:**') })).toEqual(['REG-1 unknown null', 'ADR-0007 active "Accepted"']);
  });
});

describe('a hand-off phrase written in Chinese', () => {
  it('hands nothing on, so a question it names is no ghost handover', () => {
    expect(reading('此問題延後至 ADR-0002。')).toBe('references');
    expect(reading('此問題移交給 [ADR-0002](0002-b.md) 處理。')).toBe('references');
    expect(findings('## Open Questions\n\n- [ ] Eviction? 延後至 [ADR-0002](0002-b.md).')).not.toContain('ghost-handover');
    expect(findings('## Open Questions\n\n- [ ] Eviction? Deferred to [ADR-0002](0002-b.md).')).toContain('ghost-handover');
  });

  it('is no reason to read an English phrase that touches a Han character', () => {
    // A Han character is a letter, and an English phrase stands between
    // boundaries a letter does not cross.
    expect(reading('此問題deferred to ADR-0002.')).toBe('references');
    expect(reading('Deferred to下一版 ADR-0002.')).toBe('references');
    expect(reading('此問題 deferred to ADR-0002.')).toBe('delegates-to');
  });
});

describe('a stop that ends a sentence written in Chinese', () => {
  it.each(['。', '？', '！', '；', '。 ', '；  '])('%j ends the statement, so a phrase before it governs nothing after it', (stop) => {
    expect(reading(`Deferred to later${stop}另見 ADR-0002`)).toBe('references');
  });

  it('leaves a phrase in the same statement to govern', () => {
    expect(reading('另見前文，deferred to ADR-0002')).toBe('delegates-to');
  });
});

describe('a heading or a marker written in Chinese', () => {
  it('holds no obligation, and files no link as bookkeeping', () => {
    expect(disposition('## 待辦事項\n\n- Choose a shard key')).toBeUndefined();
    expect(disposition('## Open Questions\n\n- Choose a shard key')).toBe('unresolved');
    expect(reading('## 參考資料\n\n- [ADR-0002](0002-b.md)')).toBe('references');
  });

  it('closes no item', () => {
    expect(disposition('- [ ] 已決定：不分片。')).toBe('unresolved');
    expect(disposition('- [ ] **技術債**，先接受。')).toBe('unresolved');
    expect(disposition('- [ ] **Resolved:** 不分片。')).toBe('satisfied');
  });

  it('counts an English marker only where a statement starts, and not after a Chinese stop', () => {
    // A marker after `？` was read for the Chinese markers; it read more, not
    // less, and went with them.
    expect(disposition('- [ ] 是否分片？**Resolved:** 不分片。')).toBe('unresolved');
    expect(disposition('- [ ] Shard or not? **Resolved:** no.')).toBe('satisfied');
  });
});
