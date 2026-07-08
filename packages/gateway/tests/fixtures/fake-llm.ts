import type { LlmCaller, LlmRequest, LlmResponse } from '../../src/core/types.js';
import { LlmCallError } from '../../src/core/types.js';

export function createFakeLlm(script: Array<LlmResponse | LlmCallError>): { caller: LlmCaller; calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  let i = 0;
  const caller: LlmCaller = {
    async call(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof LlmCallError) throw next;
      return next as LlmResponse;
    },
  };
  return { caller, calls };
}
