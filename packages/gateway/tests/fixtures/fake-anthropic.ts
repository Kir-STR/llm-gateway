import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from '../../src/anthropic.js';

export type FakeContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
>;

export type FakeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function makeMessage(content: FakeContent, usage: FakeUsage): Anthropic.Message {
  return { content, usage } as unknown as Anthropic.Message;
}

export function createFakeAnthropic(responses: Array<Anthropic.Message | Error>): {
  client: AnthropicClientLike;
  calls: Array<{
    body: Anthropic.MessageCreateParamsNonStreaming;
    options: Anthropic.RequestOptions | undefined;
  }>;
} {
  const calls: Array<{
    body: Anthropic.MessageCreateParamsNonStreaming;
    options: Anthropic.RequestOptions | undefined;
  }> = [];
  let i = 0;
  const client: AnthropicClientLike = {
    messages: {
      async create(body, options) {
        calls.push({ body, options });
        const next = responses[Math.min(i, responses.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}
