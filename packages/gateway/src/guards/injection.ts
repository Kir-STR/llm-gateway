import type { Guard, Verdict } from '../core/types.js';
import type { GuardConfig, PatternRule } from '../core/config-schema.js';
import { matchPatterns } from '../core/pattern-engine.js';

export function createInjectionGuard(cfg: GuardConfig): Guard {
  const patterns = (cfg.patterns as PatternRule[] | undefined) ?? [];
  return {
    name: cfg.name,
    phase: 'input',
    deterministic: true,
    timeoutMs: cfg.timeout_ms,
    run(ctx): Verdict {
      const hits = matchPatterns(patterns, ctx.input.text);
      if (hits.length === 0) return { outcome: 'PASS' };
      const hard = hits.filter((h) => h.severity === 'hard');
      const ids = hits.map((h) => h.id);
      if (hard.length > 0) {
        return { outcome: 'REJECT', code: 'E_INJECTION_DETECTED', evidence: { patterns: ids } };
      }
      return { outcome: 'DEGRADE', evidence: { patterns: ids } };
    },
  };
}
