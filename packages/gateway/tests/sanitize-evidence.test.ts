import { describe, it, expect } from 'vitest';
import { sanitizeEvidence } from '../src/core/sanitize-evidence.js';

describe('sanitizeEvidence', () => {
  it('full returns evidence as-is', () => {
    const e = { email: true, note: 'raw text' };
    expect(sanitizeEvidence(e, 'full')).toBe(e);
  });

  it('omit returns undefined', () => {
    expect(sanitizeEvidence({ a: 1 }, 'omit')).toBeUndefined();
  });

  it('safe keeps booleans/numbers/null, redacts strings to a sentinel, keeps keys', () => {
    expect(sanitizeEvidence({ email: true, count: 3, who: 'a@b.co', n: null }, 'safe')).toEqual({
      email: true,
      count: 3,
      who: '[omitted:string]',
      n: null,
    });
  });

  it('safe redacts a bare string value', () => {
    expect(sanitizeEvidence('secret@x.com', 'safe')).toBe('[omitted:string]');
  });

  it('safe recurses arrays and nested objects', () => {
    expect(sanitizeEvidence({ items: [{ ok: true, name: 'x' }] }, 'safe')).toEqual({
      items: [{ ok: true, name: '[omitted:string]' }],
    });
  });

  it('safe strips undefined/function/symbol/bigint values', () => {
    const e = { a: undefined, b: () => 1, c: Symbol('s'), d: 10n, keep: true };
    expect(sanitizeEvidence(e, 'safe')).toEqual({ keep: true });
  });

  it('safe caps depth at 4 with a depth sentinel', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: true } } } } };
    expect(sanitizeEvidence(deep, 'safe')).toEqual({ l1: { l2: { l3: { l4: '[omitted:depth]' } } } });
  });

  it('safe caps node count at 64 with a size sentinel', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big['k' + i] = i;
    const out = sanitizeEvidence(big, 'safe') as Record<string, unknown>;
    expect(Object.values(out)).toContain('[omitted:size]');
  });
});
