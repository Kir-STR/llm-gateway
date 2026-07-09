import { describe, it, expect } from 'vitest';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type { LlmRequest } from '../src/core/types.js';
import { LlmCallError } from '../src/core/types.js';
import { createAnthropicLlmCaller } from '../src/anthropic.js';
import { createFakeAnthropic, makeMessage } from './fixtures/fake-anthropic.js';

const baseReq: LlmRequest = { modelRef: 'fast', model: 'claude-x', input: 'hello', maxTokens: 64 };

describe('anthropic adapter — text path', () => {
  it('maps text blocks and usage (incl. cache tokens), sends user message + maxRetries:0', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage(
        [
          { type: 'text', text: 'he' },
          { type: 'text', text: 'llo' },
        ],
        {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 9,
        },
      ),
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
    await expect(
      caller.call({ modelRef: 'fast', model: 'claude-x', input: 'hi' }),
    ).rejects.toMatchObject({
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
    await expect(caller.call({ modelRef: 'fast', model: '', input: 'hi' })).rejects.toBeInstanceOf(
      LlmCallError,
    );
    expect(calls.length).toBe(0);
  });
});

describe('anthropic adapter — correction & temperature', () => {
  it('maps req.correction to top-level system', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call({
      ...baseReq,
      correction: 'Fix the output to match the schema.',
    });
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

  it('omits temperature when not set', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call(baseReq);
    expect(calls[0]?.body.temperature).toBeUndefined();
  });
});

describe('anthropic adapter — structured (forced tool use)', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };

  it('forces a single tool and extracts tool_use.input into structured', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage(
        [{ type: 'tool_use', id: 't1', name: 'emit_structured_output', input: { answer: 'a' } }],
        { input_tokens: 2, output_tokens: 3 },
      ),
    ]);
    const res = await createAnthropicLlmCaller(client).call({ ...baseReq, toolSchema: schema });

    expect(calls[0]?.body.tools).toEqual([
      {
        name: 'emit_structured_output',
        description: expect.any(String),
        input_schema: schema,
      },
    ]);
    expect(calls[0]?.body.tool_choice).toEqual({ type: 'tool', name: 'emit_structured_output' });
    expect(res.structured).toEqual({ answer: 'a' });
  });

  it('leaves structured undefined when the model returns no matching tool_use block', async () => {
    const { client } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'sorry' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const res = await createAnthropicLlmCaller(client).call({ ...baseReq, toolSchema: schema });
    expect(res.structured).toBeUndefined();
  });

  it('does not send tools when toolSchema is absent', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call(baseReq);
    expect(calls[0]?.body.tools).toBeUndefined();
    expect(calls[0]?.body.tool_choice).toBeUndefined();
  });
});

describe('anthropic adapter — error classification', () => {
  function withStatus(status: number): Error {
    const e = new Error('provider error');
    (e as unknown as { status: number }).status = status;
    return e;
  }
  function withName(name: string): Error {
    const e = new Error('provider error');
    e.name = name;
    return e;
  }

  const cases: Array<[Error, string, boolean]> = [
    [withStatus(429), 'rate_limit', true],
    [withStatus(529), 'overloaded', true],
    [withStatus(500), 'server', true],
    [withStatus(503), 'server', true],
    [withName('APIConnectionError'), 'server', true],
    [withName('APIConnectionTimeoutError'), 'timeout', false],
    [withName('APIUserAbortError'), 'timeout', false],
    [withStatus(401), 'auth', false],
    [withStatus(403), 'auth', false],
    [withStatus(400), 'bad_request', false],
    [withStatus(404), 'bad_request', false],
    [withStatus(413), 'bad_request', false],
    [new Error('weird'), 'unknown', false],
  ];

  it.each(cases)('maps %o -> code/retryable', async (thrown, code, retryable) => {
    const { client } = createFakeAnthropic([thrown]);
    await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
      name: 'LlmCallError',
      code,
      retryable,
    });
  });

  it('prefers numeric status over a generic connection name', async () => {
    const e = new Error('provider error');
    e.name = 'APIConnectionError';
    (e as unknown as { status: number }).status = 429;
    const { client } = createFakeAnthropic([e]);
    await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
      name: 'LlmCallError',
      code: 'rate_limit',
      retryable: true,
    });
  });

  // Real SDK error instances leave `.name === 'Error'` (see the comment on
  // classifyError) — the class name only lives on `.constructor.name`. These
  // guard against classification silently going dead again if the SDK ever
  // changes (or someone "simplifies" classifyError back to `.name`-only).
  describe('against real @anthropic-ai/sdk error instances', () => {
    it('classifies a real APIConnectionError as server/retryable', async () => {
      const { client } = createFakeAnthropic([
        new APIConnectionError({ message: 'Connection error.' }),
      ]);
      await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
        name: 'LlmCallError',
        code: 'server',
        retryable: true,
      });
    });

    it('classifies a real APIConnectionTimeoutError as timeout/non-retryable', async () => {
      const { client } = createFakeAnthropic([new APIConnectionTimeoutError()]);
      await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
        name: 'LlmCallError',
        code: 'timeout',
        retryable: false,
      });
    });

    it('classifies a real APIUserAbortError as timeout/non-retryable', async () => {
      const { client } = createFakeAnthropic([new APIUserAbortError()]);
      await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
        name: 'LlmCallError',
        code: 'timeout',
        retryable: false,
      });
    });
  });
});
