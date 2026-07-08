import type { Guard, Verdict, LimitsStore } from '../core/types.js';
import type { GuardConfig } from '../core/config-schema.js';

export type LimitsGuardDeps = {
  store: LimitsStore;
  now?: () => Date;
};

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function createLimitsGuard(cfg: GuardConfig, deps: LimitsGuardDeps): Guard {
  const perDay = (cfg.per_day as { hard_cap_usd?: number; soft_warning_usd?: number } | undefined) ?? {};
  const now = deps.now ?? (() => new Date());
  return {
    name: cfg.name,
    phase: 'input',
    deterministic: true,
    timeoutMs: cfg.timeout_ms,
    async run(): Promise<Verdict> {
      let costUsd = 0;
      try {
        const state = await deps.store.load();
        const today = utcDate(now());
        costUsd = state && state.date === today ? state.costUsd : 0;
      } catch {
        return { outcome: 'REJECT', code: 'E_COST_CAP', evidence: { reason: 'store_unavailable' } };
      }
      const hard = perDay.hard_cap_usd;
      if (hard !== undefined && costUsd >= hard) {
        return { outcome: 'REJECT', code: 'E_COST_CAP', evidence: { dailyCostUsd: costUsd, capUsd: hard } };
      }
      return { outcome: 'PASS' };
    },
  };
}
