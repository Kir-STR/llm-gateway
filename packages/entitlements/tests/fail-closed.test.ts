import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';

describe('fail-closed', () => {
  it('canAccess throwing -> EntitlementsDenied(policy_error) with cause; thunk not called', async () => {
    const boom = new Error('policy blew up');
    const ent = bindScope(
      {},
      {
        canAccess: () => {
          throw boom;
        },
      },
    );
    const thunk = vi.fn(async () => 'DATA');
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toMatchObject({
      reason: 'policy_error',
      cause: boom,
    });
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    expect(thunk).not.toHaveBeenCalled();
  });

  it('proxies a thunk error unchanged (not wrapped as EntitlementsDenied)', async () => {
    const boom = new Error('db down');
    const ent = bindScope({}, { canAccess: () => true });
    await expect(
      ent.access({ id: 1 }, 'read', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
