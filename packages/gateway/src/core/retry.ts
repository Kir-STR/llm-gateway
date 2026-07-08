import type { RetryRule } from './config-schema.js';

export function findRetryRule(
  rules: RetryRule[] | undefined, trigger: RetryRule['trigger'],
): RetryRule | undefined {
  return (rules ?? []).find((r) => r.trigger === trigger);
}

export function backoffMs(baseMs: number, attempt: number): number {
  return baseMs * 2 ** (attempt - 1);
}
