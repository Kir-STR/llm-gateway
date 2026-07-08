import { describe, it, expect } from 'vitest';
import { actualCostUsd, worstCaseCostUsd } from '../src/core/cost.js';

const prices = { m: { input: 3.0, output: 15.0 } };

describe('cost', () => {
  it('computes actual cost per MTok', () => {
    // 1000 in * 3/1e6 + 500 out * 15/1e6 = 0.003 + 0.0075 = 0.0105
    expect(actualCostUsd('m', { inputTokens: 1000, outputTokens: 500 }, prices)).toBeCloseTo(
      0.0105,
      6,
    );
  });
  it('prices cache read at input*0.1 and cache write at input*1.25', () => {
    // 1000 read * (3*0.1)/1e6 + 1000 write * (3*1.25)/1e6 = 0.0003 + 0.00375
    const c = actualCostUsd(
      'm',
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 },
      prices,
    );
    expect(c).toBeCloseTo(0.00405, 6);
  });
  it('worst-case estimates input tokens from chars', () => {
    // 400 chars -> 100 in tok * 3/1e6 + 1000 out * 15/1e6 = 0.0003 + 0.015
    expect(worstCaseCostUsd('m', 400, 1000, prices)).toBeCloseTo(0.0153, 6);
  });
  it('throws on unknown model (fail loud in caller path)', () => {
    expect(() => actualCostUsd('unknown', { inputTokens: 1, outputTokens: 1 }, prices)).toThrow();
  });
});
