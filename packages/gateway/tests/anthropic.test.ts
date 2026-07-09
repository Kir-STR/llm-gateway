import { describe, it, expect } from 'vitest';
import type { LlmRequest } from '../src/core/types.js';
import { createAnthropicLlmCaller } from '../src/anthropic.js';
import { createFakeAnthropic, makeMessage } from './fixtures/fake-anthropic.js';

const baseReq: LlmRequest = { modelRef: 'fast', model: 'claude-x', input: 'hello', maxTokens: 64 };

describe('anthropic adapter — text path', () => {
  it('maps text blocks and usage (incl. cache tokens), sends user message + maxRetries:0', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }], {
        input_tokens: 3,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 9,
      }),
    ]);
    const caller = createAnthropicLlmCaller(client);

    const res = await caller.call(baseReq);

    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
    });
    expect(res.structured).toBeUndefined();
    expect(calls[0]?.body.model).toBe('claude-x');
    expect(calls[0]?.body.max_tokens).toBe(64);
    expect(calls[0]?.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(calls[0]?.options?.maxRetries).toBe(0);
  });

  it('forwards the AbortSignal into request options', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client);
    const ac = new AbortController();

    await caller.call(baseReq, ac.signal);

    expect(calls[0]?.options?.signal).toBe(ac.signal);
  });

  it('omits cache token fields when the provider does not return them', async () => {
    const { client } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 2 }),
    ]);
    const res = await createAnthropicLlmCaller(client).call(baseReq);
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
