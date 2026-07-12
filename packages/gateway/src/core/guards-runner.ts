import type { Guard, Verdict, TurnContext } from './types.js';
import type { EvidencePolicy } from './sanitize-evidence.js';

export type GuardEntry = {
  guard: Guard;
  onError: 'reject' | 'degrade';
  rejectTemplate: string;
  evidencePolicy: EvidencePolicy;
};
export type GuardRunOutcome = {
  name: string;
  phase: 'input' | 'output';
  verdict: Verdict;
  durationMs: number;
  timedOut: boolean;
  errored: boolean;
  rejectTemplate: string;
  evidencePolicy: EvidencePolicy;
};

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function runOne(entry: GuardEntry, ctx: TurnContext): Promise<GuardRunOutcome> {
  const { guard } = entry;
  const start = Date.now();
  try {
    const run = Promise.resolve(guard.run(ctx));
    const verdict = guard.timeoutMs ? await withTimeout(run, guard.timeoutMs) : await run;
    return {
      name: guard.name,
      phase: guard.phase,
      verdict,
      durationMs: Date.now() - start,
      timedOut: false,
      errored: false,
      rejectTemplate: entry.rejectTemplate,
      evidencePolicy: entry.evidencePolicy,
    };
  } catch (err) {
    const timedOut = err instanceof TimeoutError;
    const outcome = entry.onError === 'reject' ? 'REJECT' : 'DEGRADE';
    return {
      name: guard.name,
      phase: guard.phase,
      verdict: { outcome, code: 'E_GUARD_ERROR' },
      durationMs: Date.now() - start,
      timedOut,
      errored: true,
      rejectTemplate: entry.rejectTemplate,
      evidencePolicy: entry.evidencePolicy,
    };
  }
}

export function runGuards(entries: GuardEntry[], ctx: TurnContext): Promise<GuardRunOutcome[]> {
  return Promise.all(entries.map((e) => runOne(e, ctx)));
}
