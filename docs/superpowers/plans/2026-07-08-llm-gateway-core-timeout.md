# Core-managed timeout/abort (Stage 2 · Spec A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add config-driven, core-managed timeout/abort for LLM calls per `docs/superpowers/specs/2026-07-08-llm-gateway-core-timeout.md`: the facade bounds every `deps.llm.call` with `AbortController` + a timer race, passes the signal for cooperative cancellation, classifies a timeout as `upstream_unavailable` (not retried), and threads the structured-correction failure reason so a timeout/budget breach there is no longer misclassified as `parse_fail`.

**Architecture:** A focused change to the existing runtime-agnostic core — `config-schema.ts` (contract + validation) and `gateway.ts` (mechanism + classification). No new dependencies. The Anthropic adapter is Spec B (separate).

**Tech Stack:** existing — TypeScript strict NodeNext ESM, vitest. `AbortController`/`setTimeout` are globals (no `node:*`).

## Global Constraints

- Runtime-agnostic zone (`core/`): NO `node:*`. `exactOptionalPropertyTypes` is ON — guard optional assignments.
- `createGateway` is the ONLY throw site (config/deps validation, incl. new `timeout_ms` validation). `runTurn` never throws on normal failure — a timeout is `outcome: 'failed'`, not an exception.
- Opt-in & backward compatible: a config with no `llm.timeout_ms` and no `models.*.timeout_ms` behaves exactly as before (call made without a signal).
- **Timeout resolution:** `config.models[modelRef].timeout_ms ?? config.llm?.timeout_ms ?? undefined`.
- **Timeout is not retried.** Classification: `CoreTimeout` (core race) OR an adapter `LlmCallError` with `code: 'timeout'` → `errorCode: 'timeout'`, `outcome: 'failed'`, `degradeReason: 'upstream_unavailable'`, template `llm_fail`.
- **Structured-path reasons:** `resolveStructured` returns `{ failed: 'parse' | 'upstream' | 'cost_cap' }`; `'parse'`→`parse_fail`/failed, `'upstream'`→`llm_fail`/failed/upstream_unavailable, `'cost_cap'`→`degrade`/rejected/cost_cap.
- **Guarantee boundary:** core guarantees bounded `runTurn` only — not cancellation or exact cost accounting without a cooperative adapter. `costUsd: 0` on timeout = "unknown to the core", not "not billed".
- Ajv import convention: `import { Ajv } from 'ajv'` (named).
- Numbers in tests are illustrative; assert behavior, not fixed totals.

---

## File Structure

- Modify `packages/gateway/src/core/config-schema.ts` — `ModelTier.timeout_ms?`, `GatewayConfig.llm?`, ajv schema (`llm` object + `models.*.timeout_ms` integer≥1).
- Modify `packages/gateway/src/core/gateway.ts` — `CoreTimeout` class, `callWithTimeout` helper, `doLlmCall` timeout wiring + classification, `resolveStructured` reason threading + the two call sites.
- Modify `packages/gateway/tests/fixtures/fake-llm.ts` — record signals; support thunk script entries (for hanging/slow calls).
- Create `packages/gateway/tests/timeout.test.ts` — mechanism + structured-classification tests.
- Modify `packages/gateway/README.md` — replace the "adapter owns timeout" note with the core-managed timeout contract + guarantee boundary.
- Modify `packages/gateway/package.json` — version `0.1.0` → `0.2.0`.
- Modify `examples/minimal/gateway.config.yaml` — add `llm.timeout_ms`, bump `version` to `1.1.0`; and `packages/gateway/tests/fixtures/config.ts` `neutralConfig.version` note (optional, see Task 5).

---

## Task 1: Config contract — `timeout_ms` fields + validation

**Files:**
- Modify: `packages/gateway/src/core/config-schema.ts`
- Test: `packages/gateway/tests/config-schema.test.ts`

**Interfaces:**
- Produces: `ModelTier.timeout_ms?: number`; `GatewayConfig.llm?: { timeout_ms?: number }`; ajv validation that any `timeout_ms` is an integer ≥ 1.

- [ ] **Step 1: Write failing tests** (append to `tests/config-schema.test.ts`):

```ts
it('accepts llm.timeout_ms and models.*.timeout_ms', () => {
  expect(() => validateConfig({ ...minimal, llm: { timeout_ms: 30000 },
    models: { cheap: { model: 'm', timeout_ms: 10000 } } })).not.toThrow();
});
it('rejects non-integer or < 1 timeout_ms (llm)', () => {
  expect(() => validateConfig({ ...minimal, llm: { timeout_ms: 0 } })).toThrow(ConfigError);
  expect(() => validateConfig({ ...minimal, llm: { timeout_ms: 1.5 } })).toThrow(ConfigError);
});
it('rejects bad timeout_ms on a model tier', () => {
  expect(() => validateConfig({ ...minimal, models: { cheap: { model: 'm', timeout_ms: -5 } } })).toThrow(ConfigError);
});
it('rejects unknown keys under llm', () => {
  expect(() => validateConfig({ ...minimal, llm: { nope: 1 } })).toThrow(ConfigError);
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm -C packages/gateway test config-schema`).

- [ ] **Step 3: Implement** — extend the type and the ajv schema.

Type changes:
```ts
export type ModelTier = { model: string; max_tokens?: number; temperature?: number; timeout_ms?: number };
export type GatewayConfig = {
  version: string;
  models: Record<string, ModelTier>;
  llm?: { timeout_ms?: number };
  // ...unchanged fields...
};
```

Schema changes — add `llm` to `properties`, and validate `models.*.timeout_ms`:
```ts
    llm: {
      type: 'object', additionalProperties: false,
      properties: { timeout_ms: { type: 'integer', minimum: 1 } },
    },
    models: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { timeout_ms: { type: 'integer', minimum: 1 } },
      },
    },
```
(Keep `models` item `additionalProperties` permissive — do NOT add `additionalProperties: false` there, so existing `model`/`max_tokens`/`temperature` keys still pass; only `timeout_ms` gets format-validated when present.)

- [ ] **Step 4: Run → PASS. Commit.**
```bash
git add packages/gateway/src/core/config-schema.ts packages/gateway/tests/config-schema.test.ts
git commit -m "feat(core): config contract for llm/model timeout_ms"
```

---

## Task 2: Test fixture — record signals + support hanging/slow calls

**Files:**
- Modify: `packages/gateway/tests/fixtures/fake-llm.ts`

**Interfaces:**
- Consumes: `LlmCaller`/`LlmRequest`/`LlmResponse`/`LlmCallError` (types).
- Produces (backward compatible — existing destructures of `{ caller, calls }` keep working):
  ```ts
  // a script entry may now also be a thunk (signal) => Promise<LlmResponse>, e.g. a hanging call
  export function createFakeLlm(
    script: Array<LlmResponse | LlmCallError | ((signal?: AbortSignal) => Promise<LlmResponse>)>,
  ): { caller: LlmCaller; calls: LlmRequest[]; signals: Array<AbortSignal | undefined> };
  ```

- [ ] **Step 1: Implement** (replace the fake's body; keep the existing behavior for object/error entries):

```ts
import type { LlmCaller, LlmRequest, LlmResponse } from '../../src/core/types.js';
import { LlmCallError } from '../../src/core/types.js';

type ScriptEntry = LlmResponse | LlmCallError | ((signal?: AbortSignal) => Promise<LlmResponse>);

export function createFakeLlm(script: ScriptEntry[]): {
  caller: LlmCaller;
  calls: LlmRequest[];
  signals: Array<AbortSignal | undefined>;
} {
  const calls: LlmRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let i = 0;
  const caller: LlmCaller = {
    async call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      calls.push(req);
      signals.push(signal);
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof LlmCallError) throw next;
      if (typeof next === 'function') return next(signal);
      return next as LlmResponse;
    },
  };
  return { caller, calls, signals };
}
```

- [ ] **Step 2: Verify existing suite unaffected.**

Run: `pnpm -C packages/gateway test`
Expected: existing set still green (the return type gained `signals`; existing destructures ignore it).

- [ ] **Step 3: Commit.**
```bash
git add packages/gateway/tests/fixtures/fake-llm.ts
git commit -m "test: fake LlmCaller records signals and supports thunk entries"
```

---

## Task 3: Core timeout mechanism in `doLlmCall`

**Files:**
- Modify: `packages/gateway/src/core/gateway.ts`
- Test: `packages/gateway/tests/timeout.test.ts` (create)

**Interfaces:**
- Consumes: `LlmCaller`/`LlmRequest`/`LlmResponse`/`LlmCallError`, config timeout fields (Task 1), fake fixture (Task 2).
- Produces: bounded LLM calls; `CoreTimeout` classification; `errorCode: 'timeout'` telemetry; timeout → `failed`/`upstream_unavailable`/`llm_fail`, not retried.

- [ ] **Step 1: Write failing tests** (`tests/timeout.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { LlmResponse, TelemetrySink, TelemetryEvent } from '../src/core/types.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const ok: LlmResponse = { text: 'hi', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
const nullSink: TelemetrySink = { event() {} };
const clone = () => structuredClone(neutralConfig);
const hang = () => new Promise<LlmResponse>(() => {}); // never resolves

describe('core-managed timeout', () => {
  it('opt-in: no timeout config -> call made without a signal, behavior unchanged', async () => {
    const { caller, signals } = createFakeLlm([ok]);
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('delivered');
    expect(signals[0]).toBeUndefined();
  });

  it('times out a hanging call -> failed/upstream_unavailable, signal aborted, errorCode timeout', async () => {
    const cfg = clone();
    cfg.llm = { timeout_ms: 10 };
    const events: TelemetryEvent[] = [];
    const { caller, calls, signals } = createFakeLlm([hang]);
    const gw = createGateway(cfg, { llm: caller, telemetry: { event: (e) => events.push(e) }, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r).toMatchObject({ outcome: 'failed', degradeReason: 'upstream_unavailable' });
    expect(r.text).toBe('Service temporarily unavailable. Code: t');
    expect(calls.length).toBe(1); // not retried
    expect(signals[0]?.aborted).toBe(true); // cooperative cancellation offered
    const llmCall = events.find((e) => e.event === 'llm_call');
    expect(llmCall?.data.errorCode).toBe('timeout');
    expect(llmCall?.data.costUsd).toBe(0);
  });

  it('does not retry a timeout even with a transport retry policy', async () => {
    const cfg = clone(); // neutralConfig has llm_transport_error retry max_attempts 2
    cfg.llm = { timeout_ms: 10 };
    const { caller, calls } = createFakeLlm([hang, ok, ok, ok]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('failed');
    expect(calls.length).toBe(1);
  });

  it('per-tier timeout overrides the global default', async () => {
    // A 100ms call would pass the 5000ms global but trip the 10ms tier override -> failed.
    // The outcome (failed vs delivered) is what proves which timeout was applied.
    const cfg = clone();
    cfg.llm = { timeout_ms: 5000 };
    cfg.models.expensive = { ...cfg.models.expensive, timeout_ms: 10 }; // main scenario uses `expensive`
    const slow = () => new Promise<LlmResponse>((r) => setTimeout(() => r(ok), 100));
    const { caller, calls } = createFakeLlm([slow]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('failed'); // proves the 10ms tier timeout applied, not the 5000ms global
    expect(calls.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm -C packages/gateway test timeout`).

- [ ] **Step 3: Implement in `gateway.ts`.**

Add near the other error classes (`BudgetExceeded`, `TransportExhausted`):
```ts
class CoreTimeout extends Error {}
```

Add a module-scope helper (after the error classes):
```ts
async function callWithTimeout(
  llm: LlmCaller,
  req: LlmRequest,
  timeoutMs: number | undefined,
): Promise<LlmResponse> {
  if (timeoutMs === undefined) return llm.call(req);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CoreTimeout());
    }, timeoutMs);
  });
  const call = llm.call(req, controller.signal);
  call.catch(() => {}); // swallow a late rejection after the race has already timed out
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

In `doLlmCall`, resolve the timeout right after resolving `tier` (before building `req`):
```ts
const timeoutMs = tier.timeout_ms ?? config.llm?.timeout_ms;
```

In the transport-retry loop, replace `const resp = await deps.llm.call(req);` with:
```ts
const resp = await callWithTimeout(deps.llm, req, timeoutMs);
```

Update the loop's `catch` to classify timeouts (emit `errorCode: 'timeout'`, do not retry):
```ts
} catch (err) {
  const isTimeout = err instanceof CoreTimeout || (err instanceof LlmCallError && err.code === 'timeout');
  const code = isTimeout ? 'timeout' : err instanceof LlmCallError ? err.code : 'unknown';
  emit(EVENTS.llmCall, {
    modelRef, model, attempt: attemptLabelBase + attempt,
    inTokens: 0, outTokens: 0, latencyMs: Date.now() - t0,
    outcome: 'error', errorCode: code, costUsd: 0,
  });
  if (isTimeout) throw new CoreTimeout(); // timeout is never retried
  const retryable = err instanceof LlmCallError && err.retryable;
  if (retryable && attempt <= maxRetries) {
    emit(EVENTS.retry, { trigger: 'llm_transport_error', attempt, maxAttempts: maxRetries });
    await sleep(backoffMs(rule?.backoff_ms ?? 250, attempt));
    continue;
  }
  throw new TransportExhausted();
}
```

Note: the two existing `doLlmCall` call sites (initial llm entry and output-stage retry) already map `BudgetExceeded`→cost_cap and everything else→`upstream_unavailable`. `CoreTimeout` is not `instanceof BudgetExceeded`, so it correctly falls through to `llm_fail`/`upstream_unavailable` with no change needed there.

- [ ] **Step 4: Run → PASS. Also run the full suite** (`pnpm -C packages/gateway test`) — the existing set stays green (opt-in). Typecheck.

- [ ] **Step 5: Commit.**
```bash
git add packages/gateway/src/core/gateway.ts packages/gateway/tests/timeout.test.ts
git commit -m "feat(core): core-managed LLM call timeout (AbortController + timer race)"
```

---

## Task 4: Structured-path failure classification

**Files:**
- Modify: `packages/gateway/src/core/gateway.ts`
- Test: `packages/gateway/tests/timeout.test.ts` (append)

**Interfaces:**
- Produces: `resolveStructured` returns `{ resp, value } | { failed: 'parse' | 'upstream' | 'cost_cap' }`; the two call sites map the reason to the correct stub/outcome. Closes deferred Minor #4.

- [ ] **Step 1: Write failing tests** (append to `tests/timeout.test.ts`):

```ts
describe('structured-correction failure classification', () => {
  const bad: LlmResponse = { text: 'x', structured: { answer: 'a' }, usage: { inputTokens: 1, outputTokens: 1 } }; // missing confidence

  it('schema exhaustion (valid transport) -> parse_fail/failed', async () => {
    const { caller } = createFakeLlm([bad, bad, bad]); // neutralConfig: structured_parse_failed max_attempts 1
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('failed');
    expect(r.text).toBe('Could not process the reply. Code: t'); // parse_fail
  });

  it('timeout during the structured-correction call -> llm_fail/upstream_unavailable (not parse_fail)', async () => {
    const cfg = clone();
    cfg.llm = { timeout_ms: 20 };
    // first call returns invalid structured (triggers a correction retry), the correction call hangs -> core timeout
    const { caller } = createFakeLlm([bad, hang]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r).toMatchObject({ outcome: 'failed', degradeReason: 'upstream_unavailable' });
    expect(r.text).toBe('Service temporarily unavailable. Code: t'); // llm_fail, NOT parse_fail
  });

  // No test for "budget breach during structured correction": it is unreachable. The
  // per-request worst-case budget check in doLlmCall uses ctx.input.text.length + the
  // (same) model tier, and a structured correction changes neither (it passes a
  // correction prompt via req.correction, not ctx.input.text, and does not escalate the
  // model). So if a correction call would exceed the budget, the initial call already
  // did and was blocked first. The `'cost_cap'` branch in resolveStructured is therefore
  // defensive/symmetric with the reason enum, not reachable via this path.
});
```

- [ ] **Step 2: Run → FAIL** (the timeout-in-correction test currently yields `parse_fail`).

- [ ] **Step 3: Implement in `gateway.ts`.**

Change `resolveStructured`'s return type and its two `return { failed: true }` sites:
```ts
const resolveStructured = async (
  first: LlmResponse,
  modelRef: string,
): Promise<{ resp: LlmResponse; value: unknown } | { failed: 'parse' | 'upstream' | 'cost_cap' }> => {
  // ...unchanged setup...
  while (true) {
    const parsed = validate(resp.structured);
    emit(EVENTS.structuredParse, { valid: parsed.valid, attempt, code: parsed.valid ? undefined : 'E_SCHEMA', detail: parsed.detail });
    if (parsed.valid) return { resp, value: parsed.value };
    if (attempt < maxRetries) {
      attempt++;
      emit(EVENTS.retry, { trigger: 'structured_parse_failed', attempt, maxAttempts: maxRetries });
      try {
        resp = await doLlmCall(modelRef, rule?.correction_prompt, attempt);
      } catch (err) {
        return { failed: err instanceof BudgetExceeded ? 'cost_cap' : 'upstream' };
      }
      continue;
    }
    return { failed: 'parse' }; // schema exhaustion, no transport/timeout failure
  }
};
```

Add a mapper inside `runTurn` (next to `stub`/`finish`):
```ts
const mapStructuredFailure = (
  reason: 'parse' | 'upstream' | 'cost_cap',
  scenario: string,
  flags: string[],
): TurnResult =>
  reason === 'cost_cap'
    ? stub('degrade', 'rejected', scenario, flags, 'cost_cap')
    : reason === 'upstream'
      ? stub('llm_fail', 'failed', scenario, flags, 'upstream_unavailable')
      : stub('parse_fail', 'failed', scenario, flags);
```

Update the two call sites:
- Output-stage (`const s = await resolveStructured(resp, modelRef);`):
```ts
if ('failed' in s) return mapStructuredFailure(s.failed, scenarioName, mergedFlags);
```
- Initial llm entry (`const structuredResult = await resolveStructured(firstResp, scenario.model);`):
```ts
if ('failed' in structuredResult) return mapStructuredFailure(structuredResult.failed, route.scenario, agg.flags);
```

- [ ] **Step 4: Run → PASS. Full suite + typecheck green.**

- [ ] **Step 5: Commit.**
```bash
git add packages/gateway/src/core/gateway.ts packages/gateway/tests/timeout.test.ts
git commit -m "fix(core): classify structured-correction failures (timeout/budget vs parse)"
```

---

## Task 5: Docs, example, version bump

**Files:**
- Modify: `packages/gateway/README.md`, `examples/minimal/gateway.config.yaml`, `packages/gateway/package.json`

- [ ] **Step 1: README** — replace the current "The core does not impose an LLM-call timeout…" note in the Embedding section with:

> The core can enforce an LLM-call timeout when configured (`llm.timeout_ms`, overridable per tier via `models.<tier>.timeout_ms`). It bounds `runTurn` with an `AbortController` + timer race and passes the `signal` to `LlmCaller.call` for cooperative cancellation; a timeout is classified as `upstream_unavailable` and is **not** retried. If no timeout is configured, the call is made without a signal and the adapter owns its own timeout (reporting it as `LlmCallError` with `code: 'timeout'`). **Guarantee boundary:** the core guarantees a bounded `runTurn`, not actual cancellation or exact cost accounting — if the adapter ignores the signal, the provider request may still complete and be billed; `costUsd: 0` on a timeout means "unknown to the core", not "not billed".

- [ ] **Step 2: Example config** — add to `examples/minimal/gateway.config.yaml`:
```yaml
version: 1.1.0   # bumped: config format gained optional llm.timeout_ms

llm:
  timeout_ms: 30000
```
And add `timeout_ms` to one tier for illustration, e.g. `expensive: { model: model-expensive, max_tokens: 2500, temperature: 0.3, timeout_ms: 60000 }`.

- [ ] **Step 3: Version bump** — `packages/gateway/package.json` `"version": "0.1.0"` → `"0.2.0"`.

- [ ] **Step 4: Verify + commit.**

Run: `pnpm -C packages/gateway typecheck && pnpm -w lint && pnpm -w format:check && pnpm -w build && pnpm -C packages/gateway test`
```bash
git add packages/gateway/README.md examples/minimal/gateway.config.yaml packages/gateway/package.json
git commit -m "docs: document core-managed timeout; bump package to 0.2.0"
```

---

## Notes on execution

- Order is strict: Task 1 (contract) and Task 2 (fixture) enable Task 3; Task 3 (`CoreTimeout`) is used by Task 4's classification. Task 5 last.
- The `packages/gateway/tests/fixtures/config.ts` `neutralConfig.version` may stay `1.0.0` (it's a fixture; bumping is optional and orthogonal to behavior). Do not add `llm.timeout_ms` to `neutralConfig` itself — tests that need a timeout clone it and set it, keeping the opt-in (no-timeout) path as the default under test.
