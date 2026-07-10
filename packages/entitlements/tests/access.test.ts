import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';

describe('bindScope / access', () => {
  it('runs the thunk and returns its value when policy allows (async canAccess)', async () => {
    const ent = bindScope({ tenant: 't1' }, { canAccess: async () => true });
    const thunk = vi.fn(async () => 'DATA');
    const out = await ent.access({ id: 1 }, 'read', thunk);
    expect(out).toBe('DATA');
    expect(thunk).toHaveBeenCalledOnce();
  });

  it('denies by default: throws EntitlementsDenied(policy_denied) and never calls the thunk', async () => {
    const ent = bindScope({ tenant: 't1' }, { canAccess: () => false });
    const thunk = vi.fn(async () => 'DATA');
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toMatchObject({
      reason: 'policy_denied',
    });
    expect(thunk).not.toHaveBeenCalled();
  });
});
