import { describe, it, expect } from 'vitest';
import type { LlmRequest } from '../src/core/types.js';
import { LlmCallError } from '../src/core/types.js';
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

describe('anthropic adapter — request guardrails', () => {
  it('uses defaultMaxTokens when req.maxTokens is absent', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client, { defaultMaxTokens: 512 });
    await caller.call({ modelRef: 'fast', model: 'claude-x', input: 'hi' });
    expect(calls[0]?.body.max_tokens).toBe(512);
  });

  it('throws bad_request without hitting the network when max_tokens is unresolved', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client); // no defaultMaxTokens
    await expect(caller.call({ modelRef: 'fast', model: 'claude-x', input: 'hi' })).rejects.toMatchObject({
      name: 'LlmCallError',
      code: 'bad_request',
      retryable: false,
    });
    expect(calls.length).toBe(0);
  });

  it('throws bad_request without hitting the network when model is empty', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client, { defaultMaxTokens: 64 });
    await expect(caller.call({ modelRef: 'fast', model: '', input: 'hi' })).rejects.toBeInstanceOf(LlmCallError);
    expect(calls.length).toBe(0);
  });
});

describe('anthropic adapter — correction & temperature', () => {
  it('maps req.correction to top-level system', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call({ ...baseReq, correction: 'Fix the output to match the schema.' });
    expect(calls[0]?.body.system).toBe('Fix the output to match the schema.');
  });

  it('omits system when there is no correction', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call(baseReq);
    expect(calls[0]?.body.system).toBeUndefined();
  });

  it('passes temperature through when set', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call({ ...baseReq, temperature: 0.2 });
    expect(calls[0]?.body.temperature).toBe(0.2);
  });
});
