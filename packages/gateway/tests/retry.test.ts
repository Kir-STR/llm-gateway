import { describe, it, expect } from 'vitest';
import { findRetryRule, backoffMs } from '../src/core/retry.js';

const rules = [
  { trigger: 'llm_transport_error', max_attempts: 2, backoff_ms: 250 },
  { trigger: 'output_guard_rejected', max_attempts: 1, escalate_to_model: 'expensive' },
] as const;

describe('retry primitives', () => {
  it('finds a rule by trigger', () => {
    expect(findRetryRule([...rules], 'output_guard_rejected')?.max_attempts).toBe(1);
  });
  it('returns undefined for an absent trigger', () => {
    expect(findRetryRule([...rules], 'structured_parse_failed')).toBeUndefined();
  });
  it('computes exponential backoff', () => {
    expect(backoffMs(250, 1)).toBe(250);
    expect(backoffMs(250, 2)).toBe(500);
    expect(backoffMs(250, 3)).toBe(1000);
  });
});
