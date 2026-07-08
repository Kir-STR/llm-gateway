import type { LlmCaller, LlmRequest, LlmResponse } from '../../src/core/types.js';
import { LlmCallError } from '../../src/core/types.js';

// A script entry may be a ready response, an error to throw, or a thunk that receives the
// AbortSignal and returns a promise (e.g. a hanging or slow call, for timeout tests).
type ScriptEntry = LlmResponse | LlmCallError | ((signal?: AbortSignal) => Promise<LlmResponse>);

export function createFakeLlm(script: ScriptEntry[]): {
  caller: LlmCaller;
  calls: LlmRequest[];
  signals: Array<AbortSignal | undefined>;
} {
  const calls: LlmRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let i = 0;
  const caller: LlmCaller = {
    async call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      calls.push(req);
      signals.push(signal);
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof LlmCallError) throw next;
      if (typeof next === 'function') return next(signal);
      return next as LlmResponse;
    },
  };
  return { caller, calls, signals };
}
