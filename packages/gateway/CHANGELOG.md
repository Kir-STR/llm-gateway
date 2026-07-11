# Changelog

## 0.7.0

- Telemetry hygiene. Config `version` 1.3.0 → 1.4.0.
  - Per-guard `evidence: 'omit' | 'safe' | 'full'` policy, applied at the telemetry emit
    boundary. Default: built-in guards `full`, custom guards `safe`. `safe` keeps
    booleans/numbers/null, redacts strings to `'[omitted:string]'`, preserves object keys, and
    caps depth/size. Guarantee boundary: `safe` sanitizes values, not object keys.
  - `pii` is now phase-aware: configured under `guards.output` it masks the delivered
    `output.text`. NOTE: it does **not** mask `output.structured` (A4 limitation), and — because
    output guards run in parallel — a `judge` in the same phase still sends the **unmasked**
    `output.text` to its external LLM.
  - Leakage tests assert sentinel PII never reaches the jsonl or Langfuse sinks (incl. guard
    evidence, thrown guard-error messages, `structured_parse.detail`, and retry paths).

## 0.6.0

- Add a built-in LLM output judge guard (`name: 'judge'` in `guards.output`). Config `version`
  1.2.0 → 1.3.0.
  - Judge cost is integrated into the turn: it counts toward `usage`/daily cap/`llm_call`
    telemetry (marked `purpose: 'judge'`), and a worst-case cost-cap pre-check that would bust
    the per-request cap rejects the turn (fail-closed) instead of skipping the judge.
  - Verdict is a core-owned schema `{decision: pass|degrade|reject}`; an invalid/missing verdict
    is a guard error → `on_error` (default `reject`, fail-closed). A judge guard-error rejects the
    turn without regenerating the main model (retry cannot fix a broken judge).
  - **Availability trade-off:** with the default `on_error: reject`, a judge-LLM outage makes the
    gateway reject turns (fail-closed). This is deliberate and configurable via `on_error`.
  - **Prompt-injection boundary:** the judged output is passed to the judge as delimited data; the
    core does not guarantee the judge LLM resists decision-manipulation (threat model).

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
