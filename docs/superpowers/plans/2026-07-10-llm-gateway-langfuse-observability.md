# Langfuse `TelemetrySink` Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an optional Langfuse `TelemetrySink` adapter at the `@kir-str/llm-gateway/langfuse` subpath that maps the gateway's telemetry events into Langfuse traces/generations.

**Architecture:** A single adapter file (`src/langfuse.ts`, mirroring `src/anthropic.ts`) exports `createLangfuseSink(client, options?)`. It takes an injected Langfuse client (typed against a hand-rolled minimal structural interface, `import type`-only SDK usage). It keeps a `Map<traceId, traceHandle>`, lazily creating a Langfuse trace on the first core event and evicting on `turn_completed`. v1 maps exactly three core events (`turn_started`, `llm_call`, `turn_completed`); all others are ignored. A `callClient` helper swallows both synchronous throws and async rejections so the turn never fails.

**Tech Stack:** TypeScript strict (NodeNext, ES2022, ESM), vitest, pnpm workspace, `langfuse` (v3, optional peer + dev dep).

**Spec:** `docs/superpowers/specs/2026-07-10-llm-gateway-langfuse-observability.md`.

**Langfuse SDK API (pinned by inspection of `langfuse@3.38.20` types — the spec's implementation-gate, resolved here):**
- `client.trace(body)` where trace body accepts `{ id?, name?, input?, output?, metadata?, ... }` (all optional) → returns a trace client.
- `traceClient.generation(body)` where body accepts `{ name?, model?, usageDetails?: Record<string,number>, costDetails?: Record<string,number>, startTime?: Date, endTime?: Date, metadata? }`. (`usage` is deprecated → use `usageDetails`; cost via `costDetails`.)
- `traceClient.update(body)` accepts `{ metadata?, output?, ... }`.
- The structural interface bodies are **concrete/narrow** (not `Record<string,unknown>` as sketched in spec §4) so the type-level conformance check against the real `Langfuse` type is sound. This resolves the spec's implementation-gate (§10).

## Global Constraints

Every task implicitly includes these (verbatim from the spec):

- Optional subpath `@kir-str/llm-gateway/langfuse`. Base entries (`.`, `./node`, `./anthropic`) MUST NOT import `langfuse`.
- `langfuse` SDK: **`import type` only** — zero runtime SDK in `dist/langfuse.js`. Declared as `peerDependencies` + `peerDependenciesMeta.optional: true` + `devDependency`, pinned `langfuse@^3.38.0`.
- **Client injected**: adapter does not read env, construct the client, or own `flush`/`shutdown`.
- **v1 maps exactly 3 core events** (`turn_started`, `llm_call`, `turn_completed`); all other events ignored (no client call).
- **Whitelist-only hygiene**: never forward `event.data` wholesale; `guard_result.evidence` and `structured_parse.detail` never forwarded; no prompt/completion text.
- **`callClient` swallows sync throw AND async reject** (`.catch(() => {})` on thenable return); `event()` stays synchronous fire-and-forget.
- Lazy `Map<traceId, handle>`; trace created **once** per `traceId`; **evict on `turn_completed`**; no `maxOpenTraces`.
- Timestamps: `endTime = now()`, `startTime = new Date(now().getTime() - latencyMs)`; `now` injected via `options.now` (default `() => new Date()`).
- Package `@kir-str/llm-gateway` **minor bump `0.3.0` → `0.4.0`**; README + CHANGELOG updated. Gateway config `version` unchanged.
- TypeScript via `tsconfig.base.json`: strict, NodeNext, ES2022, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. ESM `.js` import specifiers; `import type` for type-only imports.
- `src/langfuse.ts` is **runtime-agnostic**: no `node:*` (only `Date`, `Map`, `Set`).
- Work on a feature branch `feat/langfuse-observability` (isolated worktree if using subagent-driven-development). Commit after every task.

---

### Task 1: Package wiring + structural interface + conformance + trace lifecycle

**Files:**
- Modify: `packages/gateway/package.json` (version bump, `./langfuse` export, `langfuse` peer+dev deps)
- Create: `packages/gateway/src/langfuse.ts`
- Test: `packages/gateway/tests/langfuse.test.ts`
- Test: `packages/gateway/tests/langfuse-conformance.test.ts`

**Interfaces:**
- Consumes: `TelemetrySink`, `TelemetryEvent` from `./core/types.js`; `EVENTS` from `./core/telemetry-events.js`.
- Produces:
  - `interface LangfuseTraceLike { generation(body: { name?: string; model?: string; usageDetails?: Record<string, number>; costDetails?: Record<string, number>; startTime?: Date; endTime?: Date; metadata?: Record<string, unknown> }): unknown; update(body: { metadata?: Record<string, unknown> }): unknown }`
  - `interface LangfuseClientLike { trace(body: { id?: string; name?: string; input?: unknown; metadata?: Record<string, unknown> }): LangfuseTraceLike }`
  - `interface LangfuseSinkOptions { now?: () => Date; traceName?: string; generationName?: string }`
  - `function createLangfuseSink(client: LangfuseClientLike, options?: LangfuseSinkOptions): TelemetrySink`
  - After this task, the sink handles `turn_started` (trace metadata) and `turn_completed` (trace update + evict); `llm_call` is added in Task 2.

- [ ] **Step 1: Bump the package and wire the subpath + deps**

Modify `packages/gateway/package.json`: set `"version": "0.4.0"`, add the `./langfuse` export, and add the `langfuse` dep declarations. The `exports`, `peerDependencies`, `peerDependenciesMeta`, and `devDependencies` blocks become:

```jsonc
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" },
    "./anthropic": { "types": "./dist/anthropic.d.ts", "import": "./dist/anthropic.js" },
    "./langfuse": { "types": "./dist/langfuse.d.ts", "import": "./dist/langfuse.js" }
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": "^0.110.0",
    "langfuse": "^3.38.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true },
    "langfuse": { "optional": true }
  },
  "devDependencies": {
    "@anthropic-ai/sdk": "^0.110.0",
    "langfuse": "^3.38.0"
  }
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: `langfuse@3.38.x` added to the workspace; no errors.

- [ ] **Step 3: Write the failing tests (lifecycle + conformance)**

Create `packages/gateway/tests/langfuse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createLangfuseSink } from '../src/langfuse.js';
import type { LangfuseClientLike, LangfuseTraceLike } from '../src/langfuse.js';
import type { TelemetryEvent } from '../src/core/types.js';

type Call = { method: 'trace' | 'generation' | 'update'; body: Record<string, unknown> };

function fakeClient() {
  const calls: Call[] = [];
  const client: LangfuseClientLike = {
    trace(body) {
      calls.push({ method: 'trace', body: body as Record<string, unknown> });
      const handle: LangfuseTraceLike = {
        generation(b) {
          calls.push({ method: 'generation', body: b as Record<string, unknown> });
          return undefined;
        },
        update(b) {
          calls.push({ method: 'update', body: b as Record<string, unknown> });
          return undefined;
        },
      };
      return handle;
    },
  };
  return { client, calls };
}

function ev(event: string, traceId: string, data: Record<string, unknown>): TelemetryEvent {
  return { event, traceId, configVersion: '1.0.0', data };
}

describe('createLangfuseSink — trace lifecycle', () => {
  it('creates a trace exactly once per traceId', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client);
    sink.event(ev('turn_started', 't1', { inputLen: 5 }));
    sink.event(ev('turn_completed', 't1', { outcome: 'delivered' }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(1);
  });

  it('turn_started updates the trace with inputLen + configVersion metadata', () => {
    const { client, calls } = fakeClient();
    createLangfuseSink(client).event(ev('turn_started', 't1', { inputLen: 42 }));
    const update = calls.find((c) => c.method === 'update');
    expect(update?.body).toEqual({ metadata: { inputLen: 42, configVersion: '1.0.0' } });
  });

  it('turn_completed updates the trace with the outcome then evicts (next event makes a new trace)', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client);
    sink.event(ev('turn_started', 't1', { inputLen: 1 }));
    sink.event(
      ev('turn_completed', 't1', {
        outcome: 'delivered',
        scenario: 'llm',
        flags: [],
        totalLatencyMs: 10,
        totalCostUsd: 0.01,
      }),
    );
    // evicted -> a further event with the same traceId creates a SECOND trace
    sink.event(ev('turn_started', 't1', { inputLen: 2 }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(2);
  });

  it('ignores non-core events (no client calls)', () => {
    const { client, calls } = fakeClient();
    createLangfuseSink(client).event(
      ev('guard_result', 't1', { guard: 'pii', phase: 'input', outcome: 'PASS', durationMs: 1 }),
    );
    expect(calls).toHaveLength(0);
  });
});
```

Create `packages/gateway/tests/langfuse-conformance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Langfuse } from 'langfuse';
import type { LangfuseClientLike } from '../src/langfuse.js';

// Compile-time guard: a real Langfuse client structurally satisfies LangfuseClientLike.
// If a future SDK revision changes trace()/generation()/update() shape, this fails typecheck.
const _conforms = (c: Langfuse): LangfuseClientLike => c;

describe('langfuse conformance', () => {
  it('real Langfuse conforms to LangfuseClientLike (enforced at typecheck via _conforms)', () => {
    expect(typeof _conforms).toBe('function');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @kir-str/llm-gateway test tests/langfuse.test.ts`
Expected: FAIL — `../src/langfuse.js` does not exist.

- [ ] **Step 5: Implement the adapter (lifecycle only)**

Create `packages/gateway/src/langfuse.ts`:

```ts
import type { TelemetryEvent, TelemetrySink } from './core/types.js';
import { EVENTS } from './core/telemetry-events.js';

export interface LangfuseTraceLike {
  generation(body: {
    name?: string;
    model?: string;
    usageDetails?: Record<string, number>;
    costDetails?: Record<string, number>;
    startTime?: Date;
    endTime?: Date;
    metadata?: Record<string, unknown>;
  }): unknown;
  update(body: { metadata?: Record<string, unknown> }): unknown;
}

export interface LangfuseClientLike {
  trace(body: {
    id?: string;
    name?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseTraceLike;
}

export interface LangfuseSinkOptions {
  now?: () => Date;
  traceName?: string;
  generationName?: string;
}

// emit.ts wraps sink.event() in try/catch, but event() is synchronous — it only catches
// synchronous throws. If a client method returns a rejecting promise it would be an unhandled
// rejection. callClient swallows both: sync throw and async reject.
function callClient<T>(fn: () => T): T | undefined {
  try {
    const r = fn();
    if (r != null && typeof (r as { then?: unknown }).then === 'function') {
      (r as Promise<unknown>).catch(() => {});
    }
    return r;
  } catch {
    return undefined;
  }
}

export function createLangfuseSink(
  client: LangfuseClientLike,
  options: LangfuseSinkOptions = {},
): TelemetrySink {
  const traceName = options.traceName ?? 'llm-gateway turn';
  const open = new Map<string, LangfuseTraceLike>();

  function getOrCreate(traceId: string): LangfuseTraceLike | undefined {
    const existing = open.get(traceId);
    if (existing) return existing;
    const created = callClient(() => client.trace({ id: traceId, name: traceName }));
    if (created) open.set(traceId, created);
    return created;
  }

  return {
    event(e: TelemetryEvent): void {
      if (e.event !== EVENTS.turnStarted && e.event !== EVENTS.turnCompleted) {
        return; // v1 core events; llm_call added in Task 2, all others ignored
      }
      const trace = getOrCreate(e.traceId);
      if (!trace) return;
      const d = e.data;

      if (e.event === EVENTS.turnStarted) {
        callClient(() =>
          trace.update({ metadata: { inputLen: d.inputLen, configVersion: e.configVersion } }),
        );
        return;
      }

      // turn_completed
      callClient(() =>
        trace.update({
          metadata: {
            outcome: d.outcome,
            scenario: d.scenario,
            flags: d.flags,
            degradeReason: d.degradeReason,
            totalLatencyMs: d.totalLatencyMs,
            totalCostUsd: d.totalCostUsd,
          },
        }),
      );
      open.delete(e.traceId);
    },
  };
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/langfuse.test.ts tests/langfuse-conformance.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean. **If `_conforms` errors**, the installed SDK's `trace`/`generation`/`update` shape differs from the pinned one — minimally widen the affected body param types in `langfuse.ts` to match the real types (do NOT weaken to `any`), then re-run. Record any adjustment in the report.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/package.json packages/gateway/src/langfuse.ts packages/gateway/tests/langfuse.test.ts packages/gateway/tests/langfuse-conformance.test.ts pnpm-lock.yaml
git commit -m "feat(langfuse): package wiring + structural interface + trace lifecycle"
```

---

### Task 2: `llm_call` → generation (usage / cost / timestamps)

**Files:**
- Modify: `packages/gateway/src/langfuse.ts` (add `llm_call` handling + `now`/`generationName` options usage)
- Test: `packages/gateway/tests/langfuse.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `createLangfuseSink`, `LangfuseClientLike`, `LangfuseTraceLike` (Task 1).
- Produces: `llm_call` events now emit `trace.generation(...)` with `usageDetails` (token counts), `costDetails: { total: costUsd }`, `startTime`/`endTime` derived from `latencyMs` and the injected `now`, `model`, and a whitelisted `metadata` (`modelRef`, `attempt`, `outcome`, `errorCode`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/tests/langfuse.test.ts` (reuse `fakeClient`/`ev` from the file):

```ts
describe('createLangfuseSink — llm_call generation', () => {
  const fixedNow = new Date('2026-07-10T12:00:00.000Z');

  it('maps llm_call to a generation with usageDetails, costDetails, model and deterministic timestamps', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(ev('turn_started', 't1', { inputLen: 3 }));
    sink.event(
      ev('llm_call', 't1', {
        modelRef: 'primary',
        model: 'claude-x',
        attempt: 1,
        inTokens: 100,
        outTokens: 40,
        latencyMs: 250,
        outcome: 'ok',
        costUsd: 0.0021,
      }),
    );
    const gen = calls.find((c) => c.method === 'generation');
    expect(gen).toBeDefined();
    expect(gen!.body).toMatchObject({
      name: 'llm call',
      model: 'claude-x',
      usageDetails: { input: 100, output: 40 },
      costDetails: { total: 0.0021 },
      startTime: new Date(fixedNow.getTime() - 250),
      endTime: fixedNow,
      metadata: { modelRef: 'primary', attempt: 1, outcome: 'ok' },
    });
  });

  it('includes cache token counts in usageDetails when present', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(
      ev('llm_call', 't1', {
        model: 'm',
        inTokens: 10,
        outTokens: 2,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        latencyMs: 5,
        outcome: 'ok',
        costUsd: 0,
      }),
    );
    const gen = calls.find((c) => c.method === 'generation');
    expect(gen!.body.usageDetails).toEqual({ input: 10, output: 2, cache_read: 7, cache_write: 3 });
  });

  it('emits one generation per llm_call under a single trace', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(ev('llm_call', 't1', { model: 'm', inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok', costUsd: 0 }));
    sink.event(ev('llm_call', 't1', { model: 'm', inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok', costUsd: 0 }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'generation')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kir-str/llm-gateway test tests/langfuse.test.ts`
Expected: FAIL — `llm_call` is currently ignored, so no `generation` call is recorded.

- [ ] **Step 3: Add `llm_call` handling**

In `packages/gateway/src/langfuse.ts`: (a) read `now`/`generationName` from options at the top of `createLangfuseSink`; (b) include `llm_call` in the core-event guard; (c) add the generation branch.

Change the options block near the top of `createLangfuseSink` to:

```ts
  const now = options.now ?? ((): Date => new Date());
  const traceName = options.traceName ?? 'llm-gateway turn';
  const generationName = options.generationName ?? 'llm call';
  const open = new Map<string, LangfuseTraceLike>();
```

Change the core-event guard to include `llm_call`:

```ts
      if (
        e.event !== EVENTS.turnStarted &&
        e.event !== EVENTS.llmCall &&
        e.event !== EVENTS.turnCompleted
      ) {
        return; // v1: only the three core events; all others ignored
      }
```

Add the generation branch immediately after the `turn_started` branch (before the `turn_completed` handling):

```ts
      if (e.event === EVENTS.llmCall) {
        const endTime = now();
        const latencyMs = typeof d.latencyMs === 'number' ? d.latencyMs : 0;
        const usageDetails: Record<string, number> = {};
        if (typeof d.inTokens === 'number') usageDetails.input = d.inTokens;
        if (typeof d.outTokens === 'number') usageDetails.output = d.outTokens;
        if (typeof d.cacheReadTokens === 'number') usageDetails.cache_read = d.cacheReadTokens;
        if (typeof d.cacheWriteTokens === 'number') usageDetails.cache_write = d.cacheWriteTokens;
        const body: Parameters<LangfuseTraceLike['generation']>[0] = {
          name: generationName,
          usageDetails,
          startTime: new Date(endTime.getTime() - latencyMs),
          endTime,
          metadata: {
            modelRef: d.modelRef,
            attempt: d.attempt,
            outcome: d.outcome,
            errorCode: d.errorCode,
          },
        };
        if (typeof d.model === 'string') body.model = d.model;
        if (typeof d.costUsd === 'number') body.costDetails = { total: d.costUsd };
        callClient(() => trace.generation(body));
        return;
      }
```

Note (`exactOptionalPropertyTypes`): `model` and `costDetails` are added conditionally (never assigned `undefined`); the always-present keys carry defined values. `metadata` is `Record<string, unknown>`, so `undefined` values there are permitted.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/langfuse.test.ts`
Expected: PASS (Task 1 + Task 2 blocks).
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/langfuse.ts packages/gateway/tests/langfuse.test.ts
git commit -m "feat(langfuse): map llm_call to generation with usage/cost/timestamps"
```

---

### Task 3: Robustness + hygiene (async-reject, ignore, defensive, whitelist)

**Files:**
- Test: `packages/gateway/tests/langfuse.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `createLangfuseSink` (Tasks 1-2). No source change expected — this task verifies invariants already implemented (`callClient` sync+async swallow, non-core ignore, whitelist, defensive optional fields). If a test reveals a gap, fix `langfuse.ts` minimally.

- [ ] **Step 1: Write the tests**

Add to `packages/gateway/tests/langfuse.test.ts`:

```ts
describe('createLangfuseSink — robustness & hygiene', () => {
  it('does not throw and produces no unhandled rejection when a client method rejects', async () => {
    const client: LangfuseClientLike = {
      trace() {
        return {
          generation: () => Promise.reject(new Error('sink down')),
          update: () => Promise.reject(new Error('sink down')),
        };
      },
    };
    const sink = createLangfuseSink(client, { now: () => new Date('2026-07-10T00:00:00Z') });
    expect(() => {
      sink.event(ev('turn_started', 't1', { inputLen: 1 }));
      sink.event(ev('llm_call', 't1', { model: 'm', inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok', costUsd: 0 }));
      sink.event(ev('turn_completed', 't1', { outcome: 'delivered', flags: [] }));
    }).not.toThrow();
    // if callClient failed to attach .catch(), vitest would report an unhandled rejection here
    await Promise.resolve();
  });

  it('does not throw when a client method throws synchronously', () => {
    const client: LangfuseClientLike = {
      trace() {
        throw new Error('boom');
      },
    };
    const sink = createLangfuseSink(client);
    expect(() => sink.event(ev('turn_started', 't1', { inputLen: 1 }))).not.toThrow();
  });

  it('does not forward guard_result.evidence — the event is ignored, sentinel never appears', () => {
    const { client, calls } = fakeClient();
    const SECRET = 'EVIDENCE-SECRET-abc123';
    createLangfuseSink(client).event(
      ev('guard_result', 't1', { guard: 'pii', phase: 'input', outcome: 'REJECT', durationMs: 1, evidence: SECRET }),
    );
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('does not forward structured_parse.detail — the event is ignored, sentinel never appears', () => {
    const { client, calls } = fakeClient();
    const SECRET = 'DETAIL-SECRET-def456';
    createLangfuseSink(client).event(
      ev('structured_parse', 't1', { valid: false, attempt: 1, code: 'schema', detail: SECRET }),
    );
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('a stream of non-core events between started and completed adds no extra client calls', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client);
    sink.event(ev('turn_started', 't1', { inputLen: 1 }));
    sink.event(ev('normalize', 't1', { outcome: 'PASS', rulesApplied: [] }));
    sink.event(ev('route_decision', 't1', { scenario: 'llm', matchedRule: 'r1' }));
    sink.event(ev('retry', 't1', { trigger: 'structured', attempt: 1, maxAttempts: 2 }));
    sink.event(ev('turn_completed', 't1', { outcome: 'delivered', flags: [] }));
    // exactly: 1 trace + 2 updates (started, completed); nothing from the non-core events
    expect(calls.map((c) => c.method)).toEqual(['trace', 'update', 'update']);
  });

  it('does not throw on llm_call with missing optional fields', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => new Date('2026-07-10T00:00:00Z') });
    expect(() =>
      sink.event(ev('llm_call', 't1', { inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok' })),
    ).not.toThrow();
    const gen = calls.find((c) => c.method === 'generation');
    expect(gen!.body.model).toBeUndefined();
    expect(gen!.body.costDetails).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @kir-str/llm-gateway test tests/langfuse.test.ts`
Expected: PASS. These verify behavior already built in Tasks 1-2 (`callClient` swallow, non-core ignore, whitelist, defensive optionals). **If any fails**, fix `langfuse.ts` minimally to satisfy it (do not weaken the test), then re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/tests/langfuse.test.ts
git commit -m "test(langfuse): robustness (sync/async swallow), non-core ignore, whitelist hygiene"
```

---

### Task 4: Import-zone guard + README + CHANGELOG + green gate

**Files:**
- Modify: `packages/gateway/tests/no-sdk-import.test.ts` (extend to cover `langfuse`)
- Modify: `packages/gateway/README.md` (add the Langfuse adapter section)
- Modify: `packages/gateway/CHANGELOG.md` (add the 0.4.0 entry)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: an import-zone guard ensuring `langfuse` stays behind `./langfuse`; user-facing docs; a green workspace gate.

- [ ] **Step 1: Extend the import-zone guard**

Replace the body of `packages/gateway/tests/no-sdk-import.test.ts` with a version that guards both SDKs and both adapter files:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Import-zone invariant: provider/observability SDKs live only behind their subpaths.
// Base entries (core/, index.ts, node.ts) must import neither @anthropic-ai/sdk nor langfuse,
// value or type. anthropic.ts may import @anthropic-ai/sdk; langfuse.ts may import langfuse.

const SRC = join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('import zones: provider/observability SDKs stay behind their subpaths', () => {
  it('@anthropic-ai/sdk is only imported by anthropic.ts', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('src', 'anthropic.ts')))
      .filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('langfuse is only imported by langfuse.ts', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('src', 'langfuse.ts')))
      .filter((f) => /from\s+['"]langfuse['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the import-zone test**

Run: `pnpm --filter @kir-str/llm-gateway test tests/no-sdk-import.test.ts`
Expected: PASS — only `anthropic.ts` imports `@anthropic-ai/sdk`; only `langfuse.ts` imports `langfuse`.

- [ ] **Step 3: Add the README section**

Append to `packages/gateway/README.md` a section mirroring the Anthropic one (after the Anthropic adapter section):

```markdown
## Optional Langfuse observability adapter (`@kir-str/llm-gateway/langfuse`)

A Langfuse `TelemetrySink` is shipped as an optional subpath export. `langfuse` is an
optional peer dependency; base entry points do not import it (built package has no runtime
dependency on `langfuse`).

```bash
pnpm add @kir-str/llm-gateway langfuse
```

```ts
import { Langfuse } from 'langfuse';
import { createGateway } from '@kir-str/llm-gateway';
import { createLangfuseSink } from '@kir-str/llm-gateway/langfuse';

const langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
const telemetry = createLangfuseSink(langfuse);

const gateway = createGateway(config, { llm, telemetry });
// ... run turns ...
await langfuse.shutdownAsync(); // the consumer owns flush/shutdown
```

- Each turn (`traceId`) becomes a Langfuse trace; each `llm_call` becomes a generation
  (model, token usage, cost, latency). The turn outcome/flags/totals land on the trace.
- v1 maps only `turn_started` / `llm_call` / `turn_completed`; other events are ignored.
- Whitelist-only: the sink never forwards raw `TelemetryEvent.data`; `guard_result.evidence`
  and `structured_parse.detail` and prompt/completion text never reach Langfuse.
- The consumer constructs and owns the client (env, `flush`/`shutdown`); the sink does not.
```

- [ ] **Step 4: Add the CHANGELOG entry**

Insert at the top of `packages/gateway/CHANGELOG.md` (above `## 0.3.0`):

```markdown
## 0.4.0

- Add optional Langfuse `TelemetrySink` adapter at the `@kir-str/llm-gateway/langfuse`
  subpath. `langfuse` is an optional peer dependency; base entry points remain SDK-free.
  Maps each turn to a Langfuse trace and each `llm_call` to a generation (usage/cost/latency);
  whitelist-only (no raw event data, no prompt text). Injected client; the consumer owns
  `flush`/`shutdown`.
```

- [ ] **Step 5: Green gate across the workspace**

Run each and ensure all pass (fix only formatting/lint if they fire — no behavior changes):
- `pnpm exec prettier --write "packages/gateway/src/langfuse.ts" "packages/gateway/tests/langfuse.test.ts" "packages/gateway/tests/langfuse-conformance.test.ts" "packages/gateway/tests/no-sdk-import.test.ts" "packages/gateway/README.md" "packages/gateway/CHANGELOG.md" "packages/gateway/package.json"` then `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm --filter @kir-str/llm-gateway build` — verify `dist/langfuse.js` + `dist/langfuse.d.ts` exist and that `dist/langfuse.js` contains **no** `import ... from "langfuse"` (SDK is type-only). Grep: `grep -n "langfuse" packages/gateway/dist/langfuse.js` should show no runtime import of the SDK package.
- `pnpm test` — all packages green (gateway suite incl. new Langfuse tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/tests/no-sdk-import.test.ts packages/gateway/README.md packages/gateway/CHANGELOG.md
git commit -m "docs(langfuse): import-zone guard + README + CHANGELOG 0.4.0; green gate"
```

---

## Self-Review

**1. Spec coverage:**

- §1 goal (subpath adapter, trace=turn, generation=llm_call) → Tasks 1-2. ✓
- §2 non-goals (no spans, no maxOpenTraces, no env/lifecycle, no prompt text, non-core ignored) → nothing builds them; non-core ignore verified Task 3. ✓
- §3 packaging (subpath, optional peer+dev, import type, injected client, runtime-agnostic) → Task 1 (deps/export) + langfuse.ts (`import type`, `Date`/`Map` only). ✓
- §4 public API (`createLangfuseSink`, options, structural interfaces, conformance) → Task 1. ✓
- §5 mapping (3 core events; others ignored) → Tasks 1-2 + Task 3 ignore tests. ✓
- §6 state (lazy-create, evict, no maxOpenTraces) → Task 1 lifecycle + evict test. ✓
- §7 errors + whitelist hygiene (callClient sync+async, defensive, evidence/detail not forwarded) → `callClient` (Task 1) + Task 3 tests. ✓
- §8 timestamps (endTime=now, startTime=now-latencyMs, injected now) → Task 2. ✓
- §9 tests (creation-once, metadata, generation, evict, hygiene sentinel, async-reject, conformance, import-zone) → Tasks 1-4. ✓
- §10 implementation-gates (SDK signatures/fields, conformance form) → resolved in the plan header + Task 1 Step 6 adjustment clause. ✓
- §11 invariants → Global Constraints + tests. ✓
- §12 out-of-scope → nothing builds them. ✓
- §13 versioning (0.4.0, README, CHANGELOG, optional peer+dev) → Task 1 (bump/deps) + Task 4 (README/CHANGELOG). ✓

**2. Placeholder scan:** No TBD/TODO; every code and test step is complete; commands have expected results. The single conditional ("if `_conforms` errors, widen minimally") is a bounded, spec-declared implementation-gate tied to a concrete check, not an open placeholder. ✓

**3. Type consistency:** `createLangfuseSink(client, options?)`, `LangfuseClientLike.trace`, `LangfuseTraceLike.generation`/`update`, `LangfuseSinkOptions { now, traceName, generationName }`, `callClient`, field names (`usageDetails`, `costDetails`, `startTime`, `endTime`, `metadata`) are used identically across Tasks 1-4 and match the Task 1 Interfaces block. `EVENTS.turnStarted`/`llmCall`/`turnCompleted` match `telemetry-events.ts`. ✓
