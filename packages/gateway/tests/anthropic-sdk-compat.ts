// Type-only probe: fails to typecheck if the installed @anthropic-ai/sdk does not
// expose the exact symbols the adapter relies on. Not a runtime test — vitest ignores
// non-*.test.ts files; `tsc --noEmit` (which includes tests/) validates it.
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from '../src/anthropic.js';

export const _params = null as unknown as Anthropic.MessageCreateParamsNonStreaming;
export const _message = null as unknown as Anthropic.Message;
export const _inputSchema = null as unknown as Anthropic.Tool.InputSchema;

// Compile gate for spec §8: a per-request `maxRetries: 0` must be a valid RequestOptions.
export const _opts: Anthropic.RequestOptions = { maxRetries: 0 };

// Fails to compile if a real Anthropic client no longer satisfies the adapter's
// minimal injected-client surface.
export const _clientConforms = (c: Anthropic): AnthropicClientLike => c;
