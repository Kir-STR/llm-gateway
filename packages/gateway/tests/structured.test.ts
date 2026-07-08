import { describe, it, expect } from 'vitest';
import { makeStructuredValidator } from '../src/core/structured.js';

const validate = makeStructuredValidator({
  type: 'object',
  required: ['answer', 'confidence'],
  properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
});

describe('structured validator', () => {
  it('accepts a valid value', () => {
    expect(validate({ answer: 'x', confidence: 0.9 })).toEqual({
      valid: true,
      value: { answer: 'x', confidence: 0.9 },
    });
  });
  it('rejects an invalid value with a detail string', () => {
    const r = validate({ answer: 'x' });
    expect(r.valid).toBe(false);
    expect(typeof r.detail).toBe('string');
  });
});
