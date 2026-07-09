import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCaller, LlmRequest, LlmResponse } from './core/types.js';
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
  const usage: LlmResponse['usage'] = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  if (typeof u.cache_read_input_tokens === 'number')
    usage.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number')
    usage.cacheWriteTokens = u.cache_creation_input_tokens;

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

// Duck-typed: no instanceof, no SDK value import. Order matters for errors that could
// carry more than one signal: abort/timeout by name first (always terminal), then numeric
// `status` (authoritative — an HTTP status means a real server response), then the
// no-status connection name, else unknown. So HTTP codes win over a generic class name.
// Messages are generic — never echo provider bodies (secret hygiene).
function classifyError(err: unknown): LlmCallError {
  const name =
    typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
  if (name === 'APIUserAbortError') return new LlmCallError('LLM call aborted', 'timeout', false);
  if (name === 'APIConnectionTimeoutError')
    return new LlmCallError('LLM call timed out', 'timeout', false);

  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return new LlmCallError('rate limited', 'rate_limit', true);
    if (status === 529) return new LlmCallError('overloaded', 'overloaded', true);
    if (status >= 500) return new LlmCallError('server error', 'server', true);
    if (status === 401 || status === 403) return new LlmCallError('auth error', 'auth', false);
    if (status === 400 || status === 404 || status === 413)
      return new LlmCallError('bad request', 'bad_request', false);
  }

  if (name === 'APIConnectionError')
    return new LlmCallError('LLM connection error', 'server', true);
  return new LlmCallError('unknown LLM error', 'unknown', false);
}

export function createAnthropicLlmCaller(
  client: AnthropicClientLike,
  opts?: AnthropicCallerOptions,
): LlmCaller {
  return {
    async call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      if (!req.model) {
        throw new LlmCallError('Missing req.model', 'bad_request', false);
      }
      const maxTokens = req.maxTokens ?? opts?.defaultMaxTokens;
      if (maxTokens === undefined) {
        throw new LlmCallError(
          'max_tokens is required: set req.maxTokens or AnthropicCallerOptions.defaultMaxTokens',
          'bad_request',
          false,
        );
      }
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: req.input }],
      };
      if (req.correction !== undefined) body.system = req.correction;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.toolSchema !== undefined) {
        body.tools = [
          {
            name: STRUCTURED_TOOL_NAME,
            description: 'Return the result strictly matching the provided JSON schema.',
            input_schema: req.toolSchema as Anthropic.Tool.InputSchema,
          },
        ];
        body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME };
      }

      const options: Anthropic.RequestOptions = { maxRetries: 0 };
      if (signal !== undefined) options.signal = signal;

      let msg: Anthropic.Message;
      try {
        msg = await client.messages.create(body, options);
      } catch (err) {
        throw classifyError(err);
      }
      return mapResponse(msg);
    },
  };
}
