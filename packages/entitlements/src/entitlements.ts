import { EntitlementsDenied } from './errors.js';
import type { Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      const allowed = await policy.canAccess(scope, resource, operation);
      if (!allowed) {
        throw new EntitlementsDenied('policy_denied', operation);
      }
      return await thunk();
    },
  };
}
