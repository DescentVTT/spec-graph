import { describe, expect, it } from 'vitest';

import { phaseOf, supersessionTargetsIn } from '../src/lifecycle.js';
import { analyseSources, type Source } from '../src/runner.js';

/**
 * A status written in Chinese.
 *
 * Each Chinese word is read as the English word it translates (ADR-0002), and
 * the README's "Every status word" table lists them; the vocabulary test reads
 * that table word by word. What is here is how the words are found: anywhere in
 * the status, since Chinese puts no space between words, never directly after a
 * negation, and the superseded forms that are rules rather than words. Every
 * document is made up for the test.
 */

const analyse = (files: Record<string, string>) =>
  analyseSources(Object.entries(files).map(([path, text]): Source => ({ path, text })));

/** Every document, as `id phase "raw status"`. */
function statuses(files: Record<string, string>): string[] {
  return analyse(files).graph.documents.map((document) => `${document.id} ${document.phase} ${JSON.stringify(document.rawStatus)}`);
}

/** Every supersession, as `from > to`. */
function supersessions(files: Record<string, string>): string[] {
  return analyse(files)
    .graph.edges.filter((edge) => edge.kind === 'supersedes')
    .map((edge) => `${edge.from} > ${edge.to}`);
}

const RULES = (files: Record<string, string>): string[] => analyse(files).diagnostics.map((diagnostic) => diagnostic.rule);

describe('a Chinese status, as the outside review tried it', () => {
  it('reads the status under a Chinese heading', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## 狀態\n\n已接受\n\n## 背景\n' })).toEqual(['ADR-0001 active "已接受"']);
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## 状态\n\n已接受\n' })).toEqual(['ADR-0001 active "已接受"']);
  });

  it('reads the heading with a full-width colon after it', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## 狀態：\n\n已接受\n' })).toEqual(['ADR-0001 active "已接受"']);
  });

  it('reads a Chinese key in front matter, and only with the colon YAML reads', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '---\n狀態: 已接受\n---\n\n# A\n' })).toEqual(['ADR-0001 active "已接受"']);
    expect(statuses({ 'docs/adr/0001-a.md': '---\n状态: 草案\n---\n\n# A\n' })).toEqual(['ADR-0001 draft "草案"']);
    // YAML has no full-width separator, so front matter does not take one,
    // where a heading or a label does.
    expect(statuses({ 'docs/adr/0001-a.md': '---\n狀態：已接受\n---\n\n# A\n' })).toEqual(['ADR-0001 unknown null']);
  });

  it('reads 暫定接受 as a draft, though it holds 接受', () => {
    expect(phaseOf('暫定接受')).toBe('draft');
    expect(phaseOf('暂定接受')).toBe('draft');
  });

  it('reads 已被 ADR-0003 取代 as retired, and ADR-0003 as what replaced it', () => {
    const files = {
      'docs/adr/0002-b.md': '# B\n\n## 狀態\n\n已被 ADR-0003 取代\n',
      'docs/adr/0003-c.md': '# C\n\n## 狀態\n\n已接受\n',
    };
    expect(statuses(files)).toEqual(['ADR-0002 retired "已被 ADR-0003 取代"', 'ADR-0003 active "已接受"']);
    expect(supersessions(files)).toEqual(['ADR-0003 > ADR-0002']);
  });

  it('reads a supersession written after an acceptance, with no space anywhere, as retired', () => {
    // Split into words, this was `已接受`, `後被adr` and `0003取代`, and read as active.
    expect(phaseOf('已接受，後被ADR-0003取代')).toBe('retired');
    expect(supersessionTargetsIn('已接受，後被ADR-0003取代')).toEqual(['ADR-0003']);
  });

  it('reads 取代 with no 被 before it as nothing: this document replaced another', () => {
    expect(phaseOf('已接受（取代 ADR-0002）')).toBe('active');
    expect(supersessionTargetsIn('已接受（取代 ADR-0002）')).toEqual([]);
    expect(supersessions({ 'docs/adr/0001-a.md': '---\nstatus: 已接受（取代 ADR-0002）\n---\n\n# A\n', 'docs/adr/0002-b.md': '# B\n' })).toEqual(
      [],
    );
  });

  it('reads 未接受 as nothing', () => {
    expect(statuses({ 'docs/adr/0001-a.md': '# A\n\n## 狀態\n\n未接受\n' })).toEqual(['ADR-0001 unknown "未接受"']);
  });
});

describe('a Chinese word after a negation', () => {
  it.each(['不', '未', '非', '沒', '没', '無', '无', '勿', '尚未', '不再'])('says nothing after %s', (negation) => {
    expect(phaseOf(`${negation}接受`)).toBe('unknown');
    expect(phaseOf(`${negation}生效`)).toBe('unknown');
  });

  it('says nothing in the review examples', () => {
    expect(phaseOf('尚未核准')).toBe('unknown');
    expect(phaseOf('不再生效')).toBe('unknown');
  });

  it('counts only where the negation stands directly before it', () => {
    // A space, or another word, between them, and the negation governs something else.
    expect(phaseOf('未定，已接受')).toBe('active');
    expect(phaseOf('再生效')).toBe('active');
    // The word written a second time, without the negation, is still written.
    expect(phaseOf('未接受，後已接受')).toBe('active');
    expect(phaseOf('**未**接受')).toBe('unknown');
  });

  it('reads a word that starts with one as itself', () => {
    expect(phaseOf('不採納')).toBe('retired');
    expect(phaseOf('不采纳')).toBe('retired');
  });

  it('reads no supersession after one', () => {
    expect(phaseOf('未被取代')).toBe('unknown');
    expect(phaseOf('尚未被 ADR-0003 取代')).toBe('unknown');
    expect(supersessionTargetsIn('未被 ADR-0003 取代')).toEqual([]);
    expect(phaseOf('未已取代')).toBe('unknown');
  });
});

describe('a status holding words of two rows, in Chinese', () => {
  it('takes the higher row, as it does in English', () => {
    expect(phaseOf('已接受，後已棄用')).toBe('retired');
    expect(phaseOf('已接受並定案')).toBe('frozen');
    expect(phaseOf('封存，已被 B-0007 取代')).toBe('retired');
    expect(phaseOf('草案，已核准')).toBe('active');
    expect(phaseOf('Accepted（已被 ADR-0003 取代）')).toBe('retired');
  });
});

describe('superseded, in the passive', () => {
  it.each(['被 ADR-0003 取代', '被 ADR-0003 替代', '被 ADR-0003 取而代之', '被 ADR-0003 所取代', '被ADR-0003取代'])(
    'reads %s as retired, and names the successor',
    (status) => {
      expect(phaseOf(status)).toBe('retired');
      expect(supersessionTargetsIn(status)).toEqual(['ADR-0003']);
    },
  );

  it('reads 被取代 with nothing between as retired, naming nothing', () => {
    expect(phaseOf('被取代')).toBe('retired');
    expect(phaseOf('已被取代')).toBe('retired');
    expect(supersessionTargetsIn('已被取代')).toEqual([]);
  });

  it.each(['、', '，', '和', '及', '與', '与', ', ', ' and '])('names every successor listed with %j', (separator) => {
    expect(supersessionTargetsIn(`已被 ADR-0003${separator}ADR-0004 取代`)).toEqual(['ADR-0003', 'ADR-0004']);
  });

  it('names every successor an English status lists with a full-width semicolon', () => {
    // In the passive a semicolon ends the clause, and the list with it.
    expect(supersessionTargetsIn('Superseded by ADR-0003；ADR-0004')).toEqual(['ADR-0003', 'ADR-0004']);
    expect(supersessionTargetsIn('被 ADR-0003；ADR-0004 取代')).toEqual([]);
  });

  it('names a successor by the label of its link, and out of its brackets', () => {
    expect(supersessionTargetsIn('已被 [ADR-0003](0003-a-name-long-enough-to-pass-thirty.md) 取代')).toEqual(['ADR-0003']);
    expect(phaseOf('已被 [ADR-0003](0003-a-name-long-enough-to-pass-thirty.md) 取代')).toBe('retired');
    expect(supersessionTargetsIn('被（ADR-0003）取代')).toEqual(['ADR-0003']);
    expect(supersessionTargetsIn('被 **ADR-0003** 取代')).toEqual(['ADR-0003']);
  });

  it('reads no more than 30 characters between 被 and the verb', () => {
    const gap = (length: number): string => `被${'x'.repeat(length)}取代`;
    expect(phaseOf(gap(30))).toBe('retired');
    expect(phaseOf(gap(31))).toBe('unknown');
  });

  it.each(['。', '；', '！', '？'])('reads nothing across the end of a sentence, %s', (end) => {
    // Accepted by the team; the scheme that replaces ADR-0002 is for later.
    expect(phaseOf(`被團隊接受${end}取代 ADR-0002 的方案另議`)).toBe('active');
  });

});

describe('已取代', () => {
  it.each(['已取代', '**已取代**', '已取代（2026-09-30）', '已取代 2026-09-30', '已取代。', '已取代，見 ADR-0003'])(
    'is retired said alone: %s',
    (status) => {
      expect(phaseOf(status)).toBe('retired');
    },
  );

  it.each(['已取代 ADR-0002', '已取代ADR-0002', '已取代：ADR-0002', '已取代: 0002', '已取代 [ADR-0002](0002-b.md)', '已取代舊方案'])(
    'is not read followed by a name, which it usually says this document replaced: %s',
    (status) => {
      expect(phaseOf(status)).toBe('unknown');
    },
  );

  it('leaves the rest of the status to be read', () => {
    expect(phaseOf('已接受，已取代 ADR-0002')).toBe('active');
  });
});

describe('a Chinese status, where the rules read it', () => {
  it('records the supersession on both sides, so neither asks for the other', () => {
    const files = {
      'docs/adr/0002-b.md': '# B\n\n## 狀態\n\n已被 ADR-0003 取代\n',
      'docs/adr/0003-c.md': '---\nstatus: accepted\nsupersedes: ADR-0002\n---\n\n# C\n',
    };
    expect(RULES(files)).toEqual([]);
    expect(RULES({ ...files, 'docs/adr/0002-b.md': '# B\n\n## 狀態\n\n已被取代\n' })).toEqual(['unreciprocated-supersession']);
  });

  it('finds a hand-off into a document retired in Chinese', () => {
    const files = {
      'docs/adr/0002-b.md': '# B\n\n## 狀態\n\n已棄用\n',
      'docs/adr/0004-d.md': '# D\n\n## 狀態\n\n已接受\n\n## Open Questions\n\n- [ ] Eviction? Deferred to [ADR-0002](0002-b.md).\n',
    };
    expect(RULES(files)).toEqual(['ghost-handover']);
  });

  it('reads a register section labelled in Chinese', () => {
    expect(
      statuses({ 'docs/register.md': '---\nid: REG-1\n---\n\n# Register\n\n## ADR-0007：分片\n\n**狀態：** 已接受\n\n## ADR-0008：快取\n\n状态: 草案\n' }),
    ).toEqual(['REG-1 unknown null', 'ADR-0007 active "已接受"', 'ADR-0008 draft "草案"']);
  });
});
