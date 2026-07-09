import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCaller, LlmRequest, LlmResponse } from './core/types.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- wired up by the Task 3 pre-network guard
import { LlmCallError } from './core/types.js';

// Minimal structural surface the adapter depends on. A real `Anthropic` client
// satisfies it. Typed against real SDK types so there is no drift and per-request
// `maxRetries` is compile-checked. `import type` keeps runtime free of the SDK.
export interface AnthropicClientLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicCallerOptions {
  /** Fallback for max_tokens when req.maxTokens is absent. Required in production; optional in the API for tests. */
  defaultMaxTokens?: number;
}

const STRUCTURED_TOOL_NAME = 'emit_structured_output';

function mapResponse(msg: Anthropic.Message): LlmResponse {
  const u = msg.usage;
  const usage: LlmResponse['usage'] = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = u.cache_creation_input_tokens;

  let text = '';
  let structured: unknown;
  let hasStructured = false;
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use' && block.name === STRUCTURED_TOOL_NAME) {
      structured = block.input;
      hasStructured = true;
    }
  }

  const res: LlmResponse = { usage };
  if (text.length > 0) res.text = text;
  if (hasStructured) res.structured = structured;
  return res;
}

export function createAnthropicLlmCaller(
  client: AnthropicClientLike,
  opts?: AnthropicCallerOptions,
): LlmCaller {
  return {
    async call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: req.maxTokens ?? opts?.defaultMaxTokens ?? 0, // guarded in Task 3
        messages: [{ role: 'user', content: req.input }],
      };

      const options: Anthropic.RequestOptions = { maxRetries: 0 };
      if (signal !== undefined) options.signal = signal;

      const msg = await client.messages.create(body, options);
      return mapResponse(msg);
    },
  };
}
