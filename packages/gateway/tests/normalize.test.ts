import { describe, it, expect } from 'vitest';
import { normalize } from '../src/core/normalize.js';

describe('normalize', () => {
  it('trims and passes normal input', () => {
    expect(normalize('  hi  ', 4000)).toEqual({ text: 'hi', rulesApplied: ['trim', 'length_cap'] });
  });
  it('rejects empty input', () => {
    expect(normalize('   ', 4000).reject).toEqual({ code: 'E_NORMALIZE_EMPTY' });
  });
  it('rejects too-long input', () => {
    expect(normalize('x'.repeat(10), 5).reject).toEqual({ code: 'E_NORMALIZE_TOO_LONG' });
  });
  it('skips length cap when maxInputChars is undefined', () => {
    expect(normalize('x'.repeat(10), undefined).reject).toBeUndefined();
  });
});
