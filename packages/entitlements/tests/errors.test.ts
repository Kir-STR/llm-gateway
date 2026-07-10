import { describe, it, expect } from 'vitest';
import { EntitlementsDenied } from '../src/errors.js';

describe('EntitlementsDenied', () => {
  it('constructs with reason + operation, generic message, no resource field', () => {
    const err = new EntitlementsDenied('policy_denied', 'read');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EntitlementsDenied');
    expect(err.message).toBe('Access denied');
    expect(err.reason).toBe('policy_denied');
    expect(err.operation).toBe('read');
    expect('resource' in err).toBe(false);
  });

  it('preserves cause on policy_error', () => {
    const cause = new Error('boom');
    const err = new EntitlementsDenied('policy_error', 'write', { cause });
    expect(err.reason).toBe('policy_error');
    expect(err.cause).toBe(cause);
  });

  it('has undefined cause when none is provided', () => {
    const err = new EntitlementsDenied('policy_denied', 'read');
    expect(err.cause).toBeUndefined();
  });
});
