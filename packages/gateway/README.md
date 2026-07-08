# @kir-str/llm-gateway

Config-driven LLM turn-processing pipeline as a library.

> **Early stage.** The public API may still change before `1.0.0`. Breaking changes are called
> out here rather than introduced silently.

## Install

```bash
pnpm add @kir-str/llm-gateway
```

Two entry points:

- `@kir-str/llm-gateway` — runtime-agnostic core (Node 22+, browser, edge). No `node:*` imports.
- `@kir-str/llm-gateway/node` — Node-only adapters (file config loader, JSONL telemetry sink,
  file-backed limits store).

## Embedding

```ts
import { createGateway } from '@kir-str/llm-gateway';
import { loadConfigFile, createJsonlSink, createFileLimitsStore } from '@kir-str/llm-gateway/node';
import type { GatewayConfig, LlmCaller, TelemetrySink } from '@kir-str/llm-gateway';

const config = loadConfigFile('./gateway.config.yaml') as GatewayConfig;

const llm: LlmCaller = {
  async call(req, signal) {
    // call your model provider here and map its response/errors to LlmResponse / LlmCallError
    return { text: '...', usage: { inputTokens: 0, outputTokens: 0 } };
  },
};

// The core can enforce an LLM-call timeout when configured (`llm.timeout_ms`, overridable
// per tier via `models.<tier>.timeout_ms`). It bounds `runTurn` with an AbortController +
// timer race and passes the `signal` to `LlmCaller.call` for cooperative cancellation; a
// timeout is classified as `upstream_unavailable` and is NOT retried. With no timeout
// configured, the call is made without a signal and the adapter owns its own timeout
// (reporting it as an `LlmCallError` with `code: 'timeout'`, `retryable: false`).
//
// Guarantee boundary: the core guarantees a bounded `runTurn`, not actual cancellation or
// exact cost accounting. If the adapter ignores the signal, the provider request may still
// complete and be billed; `costUsd: 0` on a timeout means "unknown to the core", not "not
// billed".

const gateway = createGateway(config, {
  llm,
  telemetry: createJsonlSink('./telemetry'),
  limitsStore: createFileLimitsStore('./limits-state.json'),
});

const result = await gateway.runTurn('Hello, how are you?', { userId: 'u1' });
// result.outcome: 'delivered' | 'rejected' | 'failed'

await gateway.close();
```

`createGateway` is the only place that throws — it validates `config` and `deps` and fails fast
and loud on anything invalid. `runTurn` never throws for a normal rejection; a rejected or failed
turn comes back as `outcome: 'rejected' | 'failed'` with a template string in `text`.

## Trusted context (`meta`) and data-scope isolation

`runTurn(input, meta)` draws a hard line between two kinds of data:

- **`meta` — trusted server context.** It comes from your server (session, auth), is `Readonly`,
  and reaches guards and custom scenario handlers via `TurnContext.meta`.
- **`input`, and the model's `output` / `structured` — untrusted, model-influenced.** Anything a
  user typed or the model produced.

The core **never forwards `meta` into `LlmRequest`.** The built-in LLM scenario sends the model
only the turn text and model settings — the trusted context is not part of the prompt the
framework builds. And `LlmRequest` deliberately has **no** session/scope/tenant field: that
absence _is_ the guarantee — the model has no channel through which it could select a data scope.

**Threat model:** prompt injection → cross-tenant / cross-section data access. The correct defense
is structural, not a heuristic: the scope that authorizes data access must come from trusted server
context, never from the dialog, the model's text, its `structured` output, or (future) tool
arguments.

**Embedding safely:**

- Put authorization/scope identifiers (tenant, section, session) in `meta` — or, better, bind them
  into your `LlmCaller` / RAG closure server-side, so scope is _captured_ on the server rather than
  passed as a parameter the model could influence.
- Never derive a data scope from `input` or from the model's `structured` output.

**Boundary of this guarantee:** the framework guarantees `meta` never enters the built-in
`LlmRequest`. It does **not** (and cannot) police what your own `LlmCaller` implementation or a
custom `ScenarioHandler` does with data it holds independently — enforcing scope on data / RAG /
tool access is your auth layer's job (a future `entitlements` package will address server-bound
scope enforcement). The gateway helps by keeping trusted context out of the model request; it does
not replace auth / RAG / tool enforcement.

## The `Guard` contract

Guards are deterministic, fast checks that run in parallel per phase (`input` or `output`).
Built-in guards (`injection`, `pii`, `limits`, `policy`) are config-driven; custom guards are
supplied via `deps.guards` and implement the same interface:

```ts
interface Guard {
  name: string;
  phase: 'input' | 'output';
  deterministic: boolean;
  transforms?: boolean; // true only for guards that rewrite the turn text (e.g. pii masking)
  timeoutMs?: number;
  run(ctx: TurnContext): Promise<Verdict> | Verdict;
}

type Outcome = 'PASS' | 'DEGRADE' | 'REJECT';

type Verdict = {
  outcome: Outcome;
  code?: string; // machine code, e.g. E_INJECTION_DETECTED
  evidence?: unknown; // never raw PII/secrets — booleans/ids only
  route?: string; // force a scenario (e.g. pii short-circuit)
  transform?: string; // rewritten text, for transforming guards
};
```

A guard failing or timing out is controlled per guard by `on_error: 'reject' | 'degrade'`.
Built-in input guards default to `reject` (fail-closed — a broken `pii` guard must never let
unmasked personal data reach the LLM); custom guards default to `degrade`.

## Config format

The core accepts a `GatewayConfig` object and validates it against a single ajv JSON Schema
inside `createGateway` (`additionalProperties: false` — typos don't silently pass). The
`./node` loader (`loadConfigFile`) reads YAML or JSON from disk based on file extension. The
`version` field is required and is written into every telemetry event as `configVersion`.

Full annotated example (values are neutral placeholders — see
[`examples/minimal/gateway.config.yaml`](../../examples/minimal/gateway.config.yaml) for the
same config, runnable):

```yaml
version: 1.0.0

models: # tiers; referenced by key from scenarios and retry
  cheap: { model: model-cheap, max_tokens: 1024, temperature: 0.3 }
  expensive: { model: model-expensive, max_tokens: 2500, temperature: 0.3 }

normalize:
  max_input_chars: 4000

guards:
  input:
    - name: injection # built-in, pattern-engine
      on_error: reject
      timeout_ms: 50
      patterns:
        - {
            id: ignore_prev,
            kind: substring,
            pattern: 'ignore previous',
            case_sensitive: false,
            severity: hard,
          }
        - {
            id: base64_chunk,
            kind: regex,
            pattern: '[A-Za-z0-9+/]{200,}={0,3}',
            case_sensitive: true,
            severity: soft,
          }
    - name: pii # built-in, transforms: true
      on_error: reject
      rules: [ru_phone, email] # built-in rule sets; custom rules go through `patterns`
      mask: { ru_phone: '[PHONE_MASKED]', email: '[EMAIL_MASKED]' }
      route: pii_short_circuit # forced scenario on hit
    - name: limits # built-in: daily cap via LimitsStore
      on_error: reject
      per_day: { hard_cap_usd: 10, soft_warning_usd: 5 }
    # custom guards are supplied via deps.guards; their own config is a free-form
    # `custom: {...}` section keyed by guard name
  output:
    - name: policy # built-in, config-driven rules
      on_error: degrade
      rules:
        - { id: no_leak, kind: regex_deny, pattern: '(?i)system prompt', severity: hard }
        - { id: has_disclaimer, kind: regex_require, pattern: 'see the docs', severity: soft }
        - {
            id: shape_ok,
            kind: json_schema,
            schema: { type: object, required: [answer] },
            severity: hard,
          }

limits: # shared cost limits
  per_request: { max_cost_usd: 0.15 }
  prices: # USD per MTok; cache_read = input*0.1, cache_write = input*1.25
    model-cheap: { input: 1.0, output: 5.0 }
    model-expensive: { input: 3.0, output: 15.0 }

routing: # order = priority; a guard's forced route outranks the rules
  rules:
    - { when: { flags_any: [injection] }, scenario: cautious }
    - default: main
scenarios:
  main: { kind: llm, model: expensive, structured_output: answer_v1 }
  cautious: { kind: llm, model: cheap }
  pii_short_circuit: { kind: stub, template: pii_detected }
  # kind: custom, handler: <name> -> deps.customScenarios[name]

structured_output:
  answer_v1:
    schema:
      {
        type: object,
        required: [answer, confidence],
        properties: { answer: { type: string }, confidence: { type: number } },
      }

retry: # max_attempts = retries beyond the initial attempt
  - { trigger: llm_transport_error, max_attempts: 2, backoff_ms: 250 } # exponential
  - {
      trigger: structured_parse_failed,
      max_attempts: 1,
      correction_prompt: 'Previous reply failed schema validation. Reply strictly via the tool.',
    }
  - {
      trigger: output_guard_rejected,
      max_attempts: 1,
      correction_prompt: 'Previous reply violated output policy. Follow the policy strictly.',
      escalate_to_model: expensive,
    }

templates: # {{trace_id_short}} is the only variable
  llm_fail: 'Service temporarily unavailable. Code: {{trace_id_short}}'
  parse_fail: 'Could not process the reply. Code: {{trace_id_short}}'
  policy_reject: 'I cannot answer that directly. Code: {{trace_id_short}}'
  injection_reject: 'The request contains elements I cannot process.'
  normalize_reject: 'The message is too long or empty.'
  pii_detected: 'I do not store personal data.'
  degrade: 'Service is degraded, please try again later. Code: {{trace_id_short}}'
```

### Built-in guards

- **normalize (pre-stage):** trims the input; empty input -> `E_NORMALIZE_EMPTY`; length over
  `max_input_chars` -> `E_NORMALIZE_TOO_LONG` (the raw long text is never written to telemetry).
- **injection:** shared pattern engine (`substring` | `regex`, `case_sensitive`,
  `severity: hard|soft`). Any hard hit -> REJECT `E_INJECTION_DETECTED`; only soft hits ->
  DEGRADE (flag `injection`); evidence is the ids of the patterns that matched, never the input
  text.
- **pii:** built-in rule sets `ru_phone`, `email`; masks every match (email first, then phone).
  A hit is _not_ a rejection: the verdict is `outcome: 'PASS'` with a `transform` (masked text)
  and a `route` from config (short-circuit without calling the LLM). Evidence is boolean
  presence flags only (e.g. `{ email: true }`), never raw values. `on_error: reject` applies to
  the guard itself failing, not to a PII hit.
- **limits:** a UTC-rolling daily counter via `LimitsStore`; hitting the hard cap -> REJECT
  (`degradeReason: 'cost_cap'`, stub template `degrade`); crossing the soft threshold emits a
  `cost_cap` event once. Per-request budget is checked before the LLM call (a worst-case
  estimate); actual cost is computed from `usage` and increments the daily counter. A broken or
  unreachable store is fail-closed (treated like the hard cap).
- **policy (output):** `regex_deny` (a match is a violation), `regex_require` (no match is a
  violation), `json_schema` (validates `structured`). `hard` -> REJECT, `soft` -> DEGRADE.

## Telemetry event dictionary

Every event carries `traceId` and `configVersion`. Event names are exported as `EVENTS` from
`core/telemetry-events` (event-name constants + a data-shape type per event).

| event               | data                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `turn_started`      | `inputLen`                                                                                                                    |
| `normalize`         | `outcome, code?, rulesApplied`                                                                                                |
| `guard_result`      | `guard, phase, outcome, code?, durationMs, timedOut, errored, evidence?`                                                      |
| `guards_aggregated` | `decision, flags[], forcedRoute?, rejectCode?`                                                                                |
| `route_decision`    | `scenario, matchedRule`                                                                                                       |
| `llm_call`          | `modelRef, model, attempt, inTokens, outTokens, cacheReadTokens?, cacheWriteTokens?, latencyMs, outcome, errorCode?, costUsd` |
| `structured_parse`  | `valid, attempt, code?, detail?`                                                                                              |
| `retry`             | `trigger, attempt, maxAttempts, escalatedTo?`                                                                                 |
| `cost_cap`          | `state: soft\|hard, dailyCostUsd, capUsd`                                                                                     |
| `delivery`          | `kind, scenario, textLen`                                                                                                     |
| `turn_completed`    | `outcome, scenario, flags[], totalLatencyMs, totalCostUsd, degradeReason?`                                                    |

The `./node` JSONL sink (`createJsonlSink`) writes one line per event —
`{ts, event, traceId, configVersion, ...data}` — append-only, with daily file rotation. The
event shape is designed so a future Langfuse-style adapter (trace = turn; events with durations
map onto spans/generations) can be added without changing the interface.

## `./node` adapters

- `loadConfigFile(path)` — reads YAML or JSON from disk based on file extension.
- `createJsonlSink(dir)` — `TelemetrySink` that appends JSONL, rotated daily.
- `createFileLimitsStore(path)` — file-backed `LimitsStore`.

## License

MIT — see [LICENSE](../../LICENSE).
