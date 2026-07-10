import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';
import type { AuditEntry } from '../src/index.js';

const SECRET = 'SCOPE-SECRET-xyz789';

function recorder<R, O>() {
  const entries: AuditEntry<R, O>[] = [];
  return { entries, record: (e: AuditEntry<R, O>) => void entries.push(e) };
}

describe('audit', () => {
  it('records an allow decision with scopeLabel and never the raw scope', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      { tenant: 't1', token: SECRET },
      { canAccess: () => true, scopeLabel: (s) => s.tenant, audit },
    );
    await ent.access({ id: 1 }, 'read', async () => 'DATA');
    expect(audit.entries).toEqual([
      { decision: 'allow', operation: 'read', resource: { id: 1 }, scopeLabel: 't1' },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(SECRET);
  });

  it('records a deny decision with reason and no raw scope', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      { tenant: 't1', token: SECRET },
      { canAccess: () => false, scopeLabel: (s) => s.tenant, audit },
    );
    await expect(ent.access({ id: 2 }, 'write', async () => 'x')).rejects.toBeInstanceOf(
      EntitlementsDenied,
    );
    expect(audit.entries).toEqual([
      {
        decision: 'deny',
        operation: 'write',
        resource: { id: 2 },
        scopeLabel: 't1',
        reason: 'policy_denied',
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(SECRET);
  });

  it('records a policy_error deny when canAccess throws', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      {},
      {
        canAccess: () => {
          throw new Error('boom');
        },
        audit,
      },
    );
    await expect(ent.access({ id: 3 }, 'read', async () => 'x')).rejects.toBeInstanceOf(
      EntitlementsDenied,
    );
    expect(audit.entries).toEqual([
      { decision: 'deny', operation: 'read', resource: { id: 3 }, reason: 'policy_error' },
    ]);
  });

  it('records the allow decision before running the thunk', async () => {
    const order: string[] = [];
    const ent = bindScope(
      {},
      {
        canAccess: () => true,
        audit: { record: () => void order.push('audit') },
      },
    );
    await ent.access({ id: 1 }, 'read', async () => void order.push('thunk'));
    expect(order).toEqual(['audit', 'thunk']);
  });

  it('best-effort: a sink error does not change an allowed access', async () => {
    const ent = bindScope(
      {},
      {
        canAccess: () => true,
        audit: {
          record: () => {
            throw new Error('sink down');
          },
        },
      },
    );
    const out = await ent.access({ id: 1 }, 'read', async () => 'DATA');
    expect(out).toBe('DATA');
  });

  it('best-effort: a sink error does not turn a deny into an allow', async () => {
    const thunk = vi.fn(async () => 'DATA');
    const ent = bindScope(
      {},
      {
        canAccess: () => false,
        audit: {
          record: () => {
            throw new Error('sink down');
          },
        },
      },
    );
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    expect(thunk).not.toHaveBeenCalled();
  });

  it('omits scopeLabel from the entry when no scopeLabel is configured', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope({}, { canAccess: () => true, audit });
    await ent.access({ id: 1 }, 'read', async () => 'x');
    expect('scopeLabel' in audit.entries[0]!).toBe(false);
  });
});
