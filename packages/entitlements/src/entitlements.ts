import { EntitlementsDenied } from './errors.js';
import type { AuditEntry, Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  const scopeLabel = policy.scopeLabel ? policy.scopeLabel(scope) : undefined;

  async function emit(
    decision: 'allow' | 'deny',
    resource: R,
    operation: O,
    reason?: 'policy_denied' | 'policy_error',
  ): Promise<void> {
    const sink = policy.audit;
    if (!sink) return;
    const entry: AuditEntry<R, O> = { decision, operation, resource };
    if (scopeLabel !== undefined) entry.scopeLabel = scopeLabel;
    if (reason !== undefined) entry.reason = reason;
    try {
      await sink.record(entry);
    } catch {
      // best-effort: an audit failure never changes the allow/deny decision (spec §6)
    }
  }

  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      let allowed: boolean;
      try {
        allowed = await policy.canAccess(scope, resource, operation);
      } catch (cause) {
        await emit('deny', resource, operation, 'policy_error');
        throw new EntitlementsDenied('policy_error', operation, { cause });
      }
      if (!allowed) {
        await emit('deny', resource, operation, 'policy_denied');
        throw new EntitlementsDenied('policy_denied', operation);
      }
      await emit('allow', resource, operation);
      return await thunk();
    },
  };
}
