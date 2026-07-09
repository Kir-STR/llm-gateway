# Changelog

## 0.3.0

- Add optional Anthropic `LlmCaller` adapter at the `@kir-str/llm-gateway/anthropic`
  subpath. `@anthropic-ai/sdk` is an optional peer dependency; base entry points remain
  SDK-free. Structured output via forced tool use; SDK errors mapped to `LlmCallError`;
  core-owned retry (`maxRetries: 0`) and timeout (`signal`).
- Refresh the `LlmCaller` timeout-ownership doc-comment (no contract/signature change).
