# Changelog

## 0.4.0

- Add optional Langfuse `TelemetrySink` adapter at the `@kir-str/llm-gateway/langfuse`
  subpath. `langfuse` is an optional peer dependency; base entry points remain SDK-free.
  Maps each turn to a Langfuse trace and each `llm_call` to a generation (usage/cost/latency);
  whitelist-only (no raw event data, no prompt text). Injected client; the consumer owns
  `flush`/`shutdown`.

## 0.3.0

- Add optional Anthropic `LlmCaller` adapter at the `@kir-str/llm-gateway/anthropic`
  subpath. `@anthropic-ai/sdk` is an optional peer dependency; base entry points remain
  SDK-free. Structured output via forced tool use; SDK errors mapped to `LlmCallError`;
  core-owned retry (`maxRetries: 0`) and timeout (`signal`).
- Refresh the `LlmCaller` timeout-ownership doc-comment (no contract/signature change).
