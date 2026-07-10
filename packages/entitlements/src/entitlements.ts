import { EntitlementsDenied } from './errors.js';
import type { Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      let allowed: boolean;
      try {
        allowed = await policy.canAccess(scope, resource, operation);
      } catch (cause) {
        throw new EntitlementsDenied('policy_error', operation, { cause });
      }
      if (!allowed) {
        throw new EntitlementsDenied('policy_denied', operation);
      }
      return await thunk();
    },
  };
}
