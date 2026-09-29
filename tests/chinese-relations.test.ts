import { describe, expect, it } from 'vitest';

import { extractDocument } from '../src/extract.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * Relations, obligations and markers written in Chinese.
 *
 * The phrases, headings and markers themselves are in the README's lists and
 * table, which `extract-vocabulary.test.ts` and `state.test.ts` read one by one.
 * What is here is how they are matched: a Chinese phrase with no word boundary,
 * an English one beside Chinese, a negation directly before a phrase, and a
 * statement that ends at a Chinese stop. Every document is made up for the test.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

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

describe('a Chinese hand-off, as the outside review tried it', () => {
  it('finds a question handed to a retired document, with no space around the phrase', () => {
    expect(findings('## 未決問題\n\n- 此問題延後至ADR-0002')).toEqual(['ghost-handover']);
  });

  it('finds nothing where the phrase ended a sentence before the reference', () => {
    expect(findings('## 未決問題\n\n- 上次延後至別處。另見 ADR-0002')).toEqual([]);
  });
});

describe('a Chinese phrase', () => {
  it('needs no space before or after it', () => {
    expect(reading('此問題延後至ADR-0002處理。')).toBe('delegates-to');
    expect(reading('此問題移交給 [ADR-0002](0002-b.md) 處理。')).toBe('delegates-to');
  });

  it.each(['不', '未', '非', '沒', '没', '無', '无', '勿', '尚未', '不再'])('says nothing directly after %s', (negation) => {
    expect(reading(`此問題${negation}延後至 ADR-0002。`)).toBe('references');
  });

  it('counts where the negation governs a word before it', () => {
    expect(reading('非同步寫入延後至 ADR-0002。')).toBe('delegates-to');
    expect(reading('未定的部分，延後至 ADR-0002。')).toBe('delegates-to');
  });

  it('makes a reference written before it its subject, as an English phrase does', () => {
    expect(reading('[ADR-0002](0002-b.md)延後至本決定處理。')).toBe('delegates-to inverted');
  });

  it('is not one that wraps the reference, nor one Chinese uses for any citation', () => {
    // Accepted misses: the verb stands on both sides of the reference.
    expect(reading('由 [ADR-0002](0002-b.md) 決定。')).toBe('references');
    expect(reading('在 [ADR-0002](0002-b.md) 中追蹤。')).toBe('references');
    // 根據, 依據 and 基於 would be assumes, and read that loosely a stale premise.
    for (const word of ['根據', '依據', '基於']) expect(reading(`${word} [ADR-0002](0002-b.md)。`)).toBe('references');
  });
});

describe('an English phrase beside Chinese', () => {
  it('counts, since a Han character is no part of an English word', () => {
    expect(findings('## Open Questions\n\n- [ ] 此問題deferred to ADR-0002')).toEqual(['ghost-handover']);
    expect(reading('此問題deferred to ADR-0002。')).toBe('delegates-to');
    expect(reading('此問題 deferred toADR-0002。')).toBe('references');
    expect(reading('交給 ADR-0002 決定，此問題deferred to下一版。')).toBe('references');
  });

  it('still needs a boundary against a Latin letter or a digit', () => {
    expect(reading('Undeferred to ADR-0002.')).toBe('references');
    expect(reading('v2deferred to ADR-0002.')).toBe('references');
    expect(reading('Deferred tos ADR-0002.')).toBe('references');
    expect(reading('Deferred to2 ADR-0002.')).toBe('references');
  });
});

describe('a statement ends at a Chinese stop', () => {
  it.each(['。', '？', '！', '；', '。 ', '？ ', '！ ', '；  '])('%j, with a space after it or none', (stop) => {
    expect(reading(`上次延後至別處${stop}另見 ADR-0002`)).toBe('references');
  });

  it('and a phrase in the same sentence still governs', () => {
    expect(reading('上次討論後，延後至 ADR-0002')).toBe('delegates-to');
  });
});

describe('a Chinese section', () => {
  it('makes a bullet under an obligation heading an open obligation', () => {
    expect(disposition('## 待辦事項\n\n- 決定分片鍵')).toBe('unresolved');
    expect(disposition('## 背景\n\n- 決定分片鍵')).toBeUndefined();
  });

  it('files a link under a bookkeeping heading as bookkeeping', () => {
    expect(reading('## 參考資料\n\n- [ADR-0002](0002-b.md)')).toBe('relates-to');
  });
});

describe('a Chinese marker', () => {
  it.each(['。', '？', '！', '；', '。 ', '？ '])('counts after a Chinese stop %j', (stop) => {
    expect(disposition(`- [ ] 是否分片${stop}已決定：不分片。`)).toBe('satisfied');
  });

  it('counts after a stop and an ideographic space', () => {
    const space = String.fromCharCode(0x3000);
    expect(disposition(`- [ ] 是否分片？${space}已決定：不分片。`)).toBe('satisfied');
  });

  it('counts at the start of the item, punctuated or emphasised', () => {
    expect(disposition('- [ ] 已解決：不分片。')).toBe('satisfied');
    expect(disposition('- [ ] **技術債**，先接受。')).toBe('accepted-debt');
    expect(disposition('- [ ] 部分解決: 只剩付款路徑。')).toBe('narrowed');
  });

  it('does not count inside a sentence, or with nothing to qualify it', () => {
    expect(disposition('- [ ] 我們已決定：不分片。')).toBe('unresolved');
    expect(disposition('- [ ] 已決定採用租戶分片。')).toBe('unresolved');
    expect(disposition('- [ ] 是否分片，已決定：不分片。')).toBe('unresolved');
  });
});
