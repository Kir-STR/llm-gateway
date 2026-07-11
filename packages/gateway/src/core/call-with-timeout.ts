import type { LlmCaller, LlmRequest, LlmResponse } from './types.js';

export class CoreTimeout extends Error {}

// Bound a single LLM call: pass an AbortSignal for cooperative cancellation AND race the
// call against a timer, so the caller is bounded even if the adapter ignores the signal.
export async function callWithTimeout(
  llm: LlmCaller,
  req: LlmRequest,
  timeoutMs: number | undefined,
): Promise<LlmResponse> {
  if (timeoutMs === undefined) return llm.call(req);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CoreTimeout());
    }, timeoutMs);
  });
  const call = (async () => llm.call(req, controller.signal))();
  call.catch(() => {}); // swallow a late rejection after the race has already timed out
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
