# Changelog

## 0.5.0

- Guard contract/config hardening (breaking validation). Config `version` 1.1.0 → 1.2.0.
  - Non-deterministic guards (`deterministic: false`) now require a positive `timeout_ms`
    (init `ConfigError`) — a guard with no timeout could hang a turn.
  - Built-in guards must be configured in the section matching their phase (e.g. `pii` in
    `guards.input`, `policy` in `guards.output`) — mismatches are an init `ConfigError`.
  - Custom guards: `timeout_ms` from config is applied without mutating the injected guard;
    `route` is rejected for custom guards (supported only for built-ins).
  - Output-phase guards can now mask the delivered text via `Verdict.transform`
    (`output.structured` is not masked — known limitation).
  - Tightened config schema: guard elements require `name` and type common keys
    (`timeout_ms` must be an integer ≥ 1); a typo in a `limits` guard's `per_day`
    (e.g. `hard_cap_uds`) is now rejected; unknown keys in top-level `limits` and in
    `routing.rules` are rejected. Configs with such typos, previously silently accepted,
    now fail at init.

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
