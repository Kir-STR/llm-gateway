import type { Verdict } from './types.js';

export type InputGuardResult = { name: string; verdict: Verdict; rejectTemplate: string };
export type InputAggregate = {
  decision: 'pass' | 'reject';
  flags: string[];
  forcedRoute?: string;
  transform?: string;
  rejectCode?: string;
  rejectTemplate?: string;
};

export function aggregateInput(results: InputGuardResult[]): InputAggregate {
  const reject = results.find((r) => r.verdict.outcome === 'REJECT');
  if (reject) {
    const out: InputAggregate = { decision: 'reject', flags: [], rejectTemplate: reject.rejectTemplate };
    if (reject.verdict.code !== undefined) out.rejectCode = reject.verdict.code;
    return out;
  }
  const flags = results
    .filter((r) => r.verdict.outcome === 'DEGRADE')
    .map((r) => (r.verdict.code === 'E_GUARD_ERROR' ? 'guard_error' : r.name));
  const out: InputAggregate = { decision: 'pass', flags };
  const routed = results.find((r) => r.verdict.route !== undefined);
  if (routed) out.forcedRoute = routed.verdict.route;
  const transformed = results.find((r) => r.verdict.transform !== undefined);
  if (transformed) out.transform = transformed.verdict.transform;
  return out;
}
