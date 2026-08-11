import { describe, expect, it } from 'vitest';
import { diffProse, renderDiffHtml } from '../../src/diff/index.js';

const PARA_A = 'The quick brown fox jumps over the lazy dog.';
const PARA_B = 'The quick brown fox jumps over the sleepy dog.';

describe('golden: rewrap tolerance', () => {
  it('rewrap-only change reports 0 inserted / 0 deleted words', () => {
    const wrapped = PARA_A.replace(/\s+/g, '\n  ');
    const r = diffProse(PARA_A, wrapped);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.ops.filter((o) => o.type !== 'equal')).toHaveLength(0);
  });

  it('a multi-paragraph doc rewrapped reports zero churn', () => {
    const a = `${PARA_A}\n\n${PARA_B}\n\nA third paragraph stays untouched.`;
    const b = a.split('\n\n').map((p) => p.replace(/\s+/g, '\n')).join('\n\n');
    const r = diffProse(a, b);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });
});

describe('golden: single word substitution', () => {
  it('exactly one delete op and one insert op', () => {
    const r = diffProse(PARA_A, PARA_B);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const dels = r.ops.filter((o) => o.type === 'delete');
    const ins = r.ops.filter((o) => o.type === 'insert');
    expect(dels).toHaveLength(1);
    expect(ins).toHaveLength(1);
    expect(dels[0]?.text).toBe('lazy');
    expect(ins[0]?.text).toBe('sleepy');
    expect(r.ops.filter((o) => o.type === 'equal')).toHaveLength(2);
  });
});

describe('golden: moved paragraph', () => {
  it('detects the move as delete+insert without churn on siblings', () => {
    const a = ['Paragraph one.', 'Paragraph two.', 'Paragraph three.'].join('\n\n');
    const b = ['Paragraph three.', 'Paragraph one.', 'Paragraph two.'].join('\n\n');
    const r = diffProse(a, b);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
    const dels = r.ops.filter((o) => o.type === 'delete');
    const ins = r.ops.filter((o) => o.type === 'insert');
    expect(dels).toHaveLength(1);
    expect(ins).toHaveLength(1);
    expect(dels[0]?.text).toBe(ins[0]?.text);
  });

  it('moved paragraph with no text change has zero churn words', () => {
    const a = ['Alpha block.', 'Beta block.', 'Gamma block.'].join('\n\n');
    const b = ['Beta block.', 'Gamma block.', 'Alpha block.'].join('\n\n');
    const r = diffProse(a, b);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(2);
  });
});

describe('golden: identical / empty / boundaries', () => {
  it('identical text yields empty ops', () => {
    const r = diffProse(PARA_A, PARA_A);
    expect(r.ops).toHaveLength(0);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('empty to text inserts everything', () => {
    const r = diffProse('', PARA_A);
    expect(r.added).toBe(9);
    expect(r.removed).toBe(0);
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]?.type).toBe('insert');
  });

  it('text to empty deletes everything', () => {
    const r = diffProse(PARA_A, '');
    expect(r.added).toBe(0);
    expect(r.removed).toBe(9);
    expect(r.ops[0]?.type).toBe('delete');
  });

  it('word counts sum correctly across ops', () => {
    const r = diffProse(PARA_A, PARA_B);
    const total = r.ops.reduce((sum, o) => sum + o.words, 0);
    expect(total).toBe(9 + r.added);
  });

  it('html renderer escapes and wraps', () => {
    const r = diffProse('<script>alert(1)</script>', 'safe & sound');
    const html = renderDiffHtml(r.ops);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<del>');
    expect(html).toContain('<ins>');
  });

  it('identical renders the muted marker', () => {
    const html = renderDiffHtml([]);
    expect(html).toContain('Identical');
  });
});

describe('golden: perf — 50k words under 2s with progress', () => {
  it('diffs 50k words < 2s and reports monotonic progress to 1', () => {
    const words = (n: number, seed: string) =>
      Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
    const paras = (count: number, seed: string) =>
      Array.from({ length: count }, (_, i) => words(50, `${seed}-${i}-`)).join('\n\n');
    const a = paras(1000, 'a');
    const b = paras(1000, 'a');
    const touched = b.split('\n\n');
    touched[100] = words(50, 'b-100-');
    touched[500] = words(50, 'b-500-');
    touched[900] = words(50, 'b-900-');
    const bText = touched.join('\n\n');

    const progress: number[] = [];
    const t0 = performance.now();
    const r = diffProse(a, bText, { onProgress: (p) => progress.push(p) });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(2000);
    expect(r.added).toBe(150);
    expect(r.removed).toBe(150);
    expect(progress.at(-1)).toBe(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
  });
});
