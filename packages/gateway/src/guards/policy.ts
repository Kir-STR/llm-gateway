import type { Guard, Verdict } from '../core/types.js';
import type { GuardConfig, PolicyRule } from '../core/config-schema.js';
import { Ajv } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

// Rule patterns may carry a leading `(?i)` (PCRE-style inline case-insensitive
// flag) which JS regex syntax does not support natively — strip it and apply
// the `i` flag instead so the pattern still compiles.
function compileRegex(pattern: string): RegExp {
  if (pattern.startsWith('(?i)')) return new RegExp(pattern.slice(4), 'i');
  return new RegExp(pattern);
}

export function createPolicyGuard(cfg: GuardConfig): Guard {
  const rules = (cfg.rules as PolicyRule[] | undefined) ?? [];
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const r of rules) {
    if (r.kind === 'json_schema') validators.set(r.id, ajv.compile(r.schema));
  }
  return {
    name: cfg.name,
    phase: 'output',
    deterministic: true,
    ...(cfg.timeout_ms !== undefined ? { timeoutMs: cfg.timeout_ms } : {}),
    run(ctx): Verdict {
      const text = ctx.output?.text ?? '';
      const structured = ctx.output?.structured;
      const violated: { id: string; severity: 'hard' | 'soft' }[] = [];
      for (const r of rules) {
        let bad = false;
        if (r.kind === 'regex_deny') bad = compileRegex(r.pattern).test(text);
        else if (r.kind === 'regex_require') bad = !compileRegex(r.pattern).test(text);
        else bad = !validators.get(r.id)!(structured);
        if (bad) violated.push({ id: r.id, severity: r.severity });
      }
      if (violated.length === 0) return { outcome: 'PASS' };
      const evidence = { violations: violated.map((v) => v.id) };
      const hard = violated.some((v) => v.severity === 'hard');
      return hard
        ? { outcome: 'REJECT', code: 'E_POLICY_VIOLATION', evidence }
        : { outcome: 'DEGRADE', evidence };
    },
  };
}
