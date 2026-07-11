# Telemetry Hygiene (Increment C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop unmasked evidence/PII from reaching telemetry via a per-guard evidence policy applied at a single emit-boundary chokepoint, add phase-aware pii (output masking), and lock the no-leak invariant with tests across both sinks.

**Architecture:** A pure `sanitizeEvidence(evidence, policy)` helper is applied at the two `guard_result` emit sites. Each guard carries a resolved `evidencePolicy` (built-in→`full`, custom→`safe`, config-overridable) threaded from `buildEntries` through `GuardEntry`/`GuardRunOutcome`. `pii` becomes phase-parameterized (masks `output.text` in the output phase via the A4 transform). Leakage tests drive a sentinel PII through a turn and assert it never appears in any event of any sink.

**Tech Stack:** TypeScript strict (NodeNext, ES2022, ESM), ajv, vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-12-llm-gateway-telemetry-hygiene.md`.

## Global Constraints

- Public `Guard`/`Verdict` unchanged (`evidence: unknown`).
- **One chokepoint:** sanitization only at the two `guard_result` emit sites (`gateway.ts:442` input, `:663` output); guards don't know the policy.
- Levels: `full` (as-is), `omit` (evidence undefined → dropped in serialization), `safe` (recursive: keep `boolean`/`number`/`null`; `string`→`'[omitted:string]'`; strip `undefined`/function/symbol/bigint; **object keys survive**, recurse values; array recurse; **depth > 4 → `'[omitted:depth]'`; node count > 64 → `'[omitted:size]'`**).
- Defaults: built-in guard → `full`; custom (`deps.guards`) → `safe`. Config `evidence: 'omit'|'safe'|'full'` overrides per guard.
- `safe` sanitizes **values, not keys** (documented boundary).
- Phase-aware pii: `output` masks `ctx.output.text` via `transform` (A4 delivers it); `route` on output-pii → init `ConfigError`. Input-phase behavior unchanged.
- Output guards run in **parallel** (`runGuards`=`Promise.all`); the pii transform masks only the delivered text — a judge in the same phase sends the UNMASKED `output.text` to its external LLM (documented). `input.text` IS already masked (input-phase transform mutates it at `gateway.ts:368`), so the boundary is output-only.
- Judge `evidence:{decision}` forever; `reason` never forwarded (update the `judge.ts` comment).
- Package `@kir-str/llm-gateway` **0.6.0 → 0.7.0**; config **1.3.0 → 1.4.0**; README + CHANGELOG.
- TS strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); ESM `.js`; `import type`. `sanitize-evidence.ts` and `pii.ts` runtime-agnostic (no `node:*`).
- Branch `feat/telemetry-hygiene`. Commit after each task. Existing 182 tests stay green. **After each commit, verify the worktree HEAD advanced and local `main` was NOT touched** (a prior increment had a subagent commit to the wrong checkout).

---

### Task 1: `sanitizeEvidence` helper

**Files:**
- Create: `packages/gateway/src/core/sanitize-evidence.ts`
- Test: `packages/gateway/tests/sanitize-evidence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type EvidencePolicy = 'omit' | 'safe' | 'full'` and `export function sanitizeEvidence(evidence: unknown, policy: EvidencePolicy): unknown`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/sanitize-evidence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeEvidence } from '../src/core/sanitize-evidence.js';

describe('sanitizeEvidence', () => {
  it('full returns evidence as-is', () => {
    const e = { email: true, note: 'raw text' };
    expect(sanitizeEvidence(e, 'full')).toBe(e);
  });

  it('omit returns undefined', () => {
    expect(sanitizeEvidence({ a: 1 }, 'omit')).toBeUndefined();
  });

  it('safe keeps booleans/numbers/null, redacts strings to a sentinel, keeps keys', () => {
    expect(sanitizeEvidence({ email: true, count: 3, who: 'a@b.co', n: null }, 'safe')).toEqual({
      email: true,
      count: 3,
      who: '[omitted:string]',
      n: null,
    });
  });

  it('safe redacts a bare string value', () => {
    expect(sanitizeEvidence('secret@x.com', 'safe')).toBe('[omitted:string]');
  });

  it('safe recurses arrays and nested objects', () => {
    expect(sanitizeEvidence({ items: [{ ok: true, name: 'x' }] }, 'safe')).toEqual({
      items: [{ ok: true, name: '[omitted:string]' }],
    });
  });

  it('safe strips undefined/function/symbol/bigint values', () => {
    const e = { a: undefined, b: () => 1, c: Symbol('s'), d: 10n, keep: true };
    expect(sanitizeEvidence(e, 'safe')).toEqual({ keep: true });
  });

  it('safe caps depth at 4 with a depth sentinel', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: true } } } } };
    expect(sanitizeEvidence(deep, 'safe')).toEqual({ l1: { l2: { l3: { l4: '[omitted:depth]' } } } });
  });

  it('safe caps node count at 64 with a size sentinel', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big['k' + i] = i;
    const out = sanitizeEvidence(big, 'safe') as Record<string, unknown>;
    expect(Object.values(out)).toContain('[omitted:size]');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kir-str/llm-gateway test tests/sanitize-evidence.test.ts`
Expected: FAIL — `sanitize-evidence.js` does not exist.

- [ ] **Step 3: Implement the helper**

Create `packages/gateway/src/core/sanitize-evidence.ts`:

```ts
export type EvidencePolicy = 'omit' | 'safe' | 'full';

const STRING_SENTINEL = '[omitted:string]';
const DEPTH_SENTINEL = '[omitted:depth]';
const SIZE_SENTINEL = '[omitted:size]';
const MAX_DEPTH = 4;
const MAX_NODES = 64;

// safe: keep structural primitives (bool/number/null), redact string free-text to a fixed
// sentinel (shape preserved, no content), strip non-serializable values, cap depth/size.
// Object KEYS are preserved (not sanitized) — see the design spec §2 guarantee boundary.
export function sanitizeEvidence(evidence: unknown, policy: EvidencePolicy): unknown {
  if (policy === 'full') return evidence;
  if (policy === 'omit') return undefined;
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES) return SIZE_SENTINEL;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'boolean' || t === 'number') return v;
    if (t === 'string') return STRING_SENTINEL;
    if (t !== 'object') return undefined; // undefined, function, symbol, bigint
    if (depth >= MAX_DEPTH) return DEPTH_SENTINEL;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const sv = walk((v as Record<string, unknown>)[k], depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  };
  return walk(evidence, 0);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/sanitize-evidence.test.ts`
Expected: PASS (8 tests).
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/core/sanitize-evidence.ts packages/gateway/tests/sanitize-evidence.test.ts
git commit -m "feat(hygiene): sanitizeEvidence helper (safe = keep primitives, redact strings, cap depth/size)"
```

---

### Task 2: config schema — `evidence` key

**Files:**
- Modify: `packages/gateway/src/core/config-schema.ts`
- Test: `packages/gateway/tests/config-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: config validation accepts `evidence: 'omit'|'safe'|'full'` on any guard element (open guards, `limits`, and `judge`) and rejects other values.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/tests/config-schema.test.ts`:

```ts
describe('C: guard evidence policy config', () => {
  it('accepts evidence on an open (injection) guard', () => {
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).evidence = 'safe'))).not.toThrow();
  });
  it('accepts evidence on a limits guard', () => {
    expect(make((c) => {
      const limits = c.guards!.input!.find((g) => g.name === 'limits') as Record<string, unknown>;
      limits.evidence = 'omit';
    })).not.toThrow();
  });
  it('accepts evidence on a judge guard (closed schema)', () => {
    expect(make((c) => c.guards!.output!.push({ name: 'judge', model: 'cheap', criteria: 'x', timeout_ms: 5000, evidence: 'full' } as never))).not.toThrow();
  });
  it('rejects an invalid evidence value', () => {
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).evidence = 'loud'))).toThrow();
  });
});
```

(If `cheap` isn't a tier in `neutralConfig.models`, use the actual key.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kir-str/llm-gateway test tests/config-schema.test.ts`
Expected: FAIL — the invalid-value case is accepted (no `evidence` typing yet), and the judge case fails because `evidence` is not in the judge's closed schema (`additionalProperties:false`).

- [ ] **Step 3: Add `evidence` to the generic + judge schemas**

In `packages/gateway/src/core/config-schema.ts`:
(a) Add `evidence` to the generic `$defs.guardConfig.properties` (alongside `on_error`/`timeout_ms`) — this covers open guards AND `limits` (the `limits` `if/then` does NOT set `additionalProperties:false`, so it stays open):

```ts
          evidence: { enum: ['omit', 'safe', 'full'] },
```

(b) The `judge` `then` schema IS closed (`additionalProperties:false`) — add `evidence` to its `then.properties` too:

```ts
              evidence: { enum: ['omit', 'safe', 'full'] },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/config-schema.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/core/config-schema.ts packages/gateway/tests/config-schema.test.ts
git commit -m "feat(hygiene): allow per-guard evidence policy in config (open + limits + judge schemas)"
```

---

### Task 3: wire the evidence policy through to the emit sites

**Files:**
- Modify: `packages/gateway/src/core/guards-runner.ts` (`GuardEntry` + `GuardRunOutcome` gain `evidencePolicy`; `runOne` copies it)
- Modify: `packages/gateway/src/core/gateway.ts` (`buildEntries` resolves `evidencePolicy`; both `guard_result` emits apply `sanitizeEvidence`)
- Test: `packages/gateway/tests/evidence-policy.test.ts` (new)

**Interfaces:**
- Consumes: `sanitizeEvidence`/`EvidencePolicy` (Task 1); `DEFAULTS` (built-in name set) in gateway.ts.
- Produces: every `guard_result` event's `evidence` is `sanitizeEvidence(verdict.evidence, entry.evidencePolicy)`. A custom guard defaults to `safe` (strings redacted); a built-in defaults to `full`; `cfg.evidence` overrides.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/evidence-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig, TelemetryEvent, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

function run(cfg: GatewayConfig, guards: Guard[]) {
  const events: TelemetryEvent[] = [];
  const ok: LlmResponse = { text: 'hi', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
  const { caller } = createFakeLlm([ok]);
  const gw = createGateway(cfg, { llm: caller, telemetry: { event: (e) => events.push(e) }, guards, idGenerator: () => 't' });
  return { events, gw };
}

const SECRET = 'raw-evidence-secret@x.com';

describe('evidence policy at the emit boundary', () => {
  it('a custom guard defaults to safe: string evidence is redacted', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'custom_ev' } as never);
    const guard: Guard = { name: 'custom_ev', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { flag: true, note: SECRET } }) };
    const { events, gw } = run(cfg, [guard]);
    await gw.runTurn('q');
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'custom_ev');
    expect(JSON.stringify(ev?.data.evidence)).not.toContain(SECRET);
    expect(JSON.stringify(ev?.data.evidence)).toContain('[omitted:string]');
    expect((ev?.data.evidence as { flag?: boolean }).flag).toBe(true);
  });

  it('a built-in guard defaults to full (evidence passes through)', async () => {
    const { events, gw } = run(structuredClone(neutralConfig) as GatewayConfig, []);
    await gw.runTurn('contact me at a@b.com'); // triggers built-in pii evidence {email,phone}
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'pii');
    expect((ev?.data.evidence as { email?: boolean }).email).toBe(true); // booleans pass under full
  });

  it('config evidence:omit removes a custom guard evidence', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'custom_ev', evidence: 'omit' } as never);
    const guard: Guard = { name: 'custom_ev', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { note: SECRET } }) };
    const { events, gw } = run(cfg, [guard]);
    await gw.runTurn('q');
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'custom_ev');
    expect(ev?.data.evidence).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kir-str/llm-gateway test tests/evidence-policy.test.ts`
Expected: FAIL — evidence is currently emitted raw, so `SECRET` appears and no `evidencePolicy` exists.

- [ ] **Step 3: Add `evidencePolicy` to the runner types**

In `packages/gateway/src/core/guards-runner.ts`: import the type and extend both types + copy it in `runOne`:

```ts
import type { Guard, Verdict, TurnContext } from './types.js';
import type { EvidencePolicy } from './sanitize-evidence.js';

export type GuardEntry = {
  guard: Guard;
  onError: 'reject' | 'degrade';
  rejectTemplate: string;
  evidencePolicy: EvidencePolicy;
};
export type GuardRunOutcome = {
  name: string;
  phase: 'input' | 'output';
  verdict: Verdict;
  durationMs: number;
  timedOut: boolean;
  errored: boolean;
  rejectTemplate: string;
  evidencePolicy: EvidencePolicy;
};
```

In `runOne`, add `evidencePolicy: entry.evidencePolicy,` to BOTH returned outcome objects (the success return and the catch return).

- [ ] **Step 4: Resolve the policy in buildEntries and sanitize at the emits**

In `packages/gateway/src/core/gateway.ts`:
(a) import: `import { sanitizeEvidence, type EvidencePolicy } from './sanitize-evidence.js';`
(b) In `buildEntries`, where the entry is returned (currently `return { guard, onError, rejectTemplate };`), resolve and include the policy. `DEFAULTS[cfg.name]` is defined for every built-in (`injection`/`pii`/`limits`/`policy`/`judge`), so it is the built-in test:

```ts
      const evidencePolicy: EvidencePolicy =
        (cfg.evidence as EvidencePolicy | undefined) ?? (DEFAULTS[cfg.name] !== undefined ? 'full' : 'safe');
      return { guard, onError, rejectTemplate, evidencePolicy };
```

(c) At BOTH `guard_result` emit sites (input ~`:442`, output ~`:663`), change `evidence: r.verdict.evidence,` to:

```ts
          evidence: sanitizeEvidence(r.verdict.evidence, r.evidencePolicy),
```

- [ ] **Step 5: Run tests + full suite + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/evidence-policy.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/core/guards-runner.ts packages/gateway/src/core/gateway.ts packages/gateway/tests/evidence-policy.test.ts
git commit -m "feat(hygiene): apply evidence policy (sanitizeEvidence) at both guard_result emit sites"
```

---

### Task 4: phase-aware pii

**Files:**
- Modify: `packages/gateway/src/guards/pii.ts` (`createPiiGuard(cfg, phase)`)
- Modify: `packages/gateway/src/core/gateway.ts` (`buildEntries` passes `phase`; route-on-output → ConfigError)
- Test: `packages/gateway/tests/pii-output.test.ts` (new)

**Interfaces:**
- Consumes: `createPiiGuard(cfg, phase)`.
- Produces: a `pii` guard configured under `guards.output` masks `ctx.output.text` and returns it as `transform` (A4 delivers the masked text); `route` on an output-pii guard is an init `ConfigError`. Input-phase behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/pii-output.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };

describe('phase-aware pii (output)', () => {
  it('masks the delivered output text when pii is configured in guards.output', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'pii' } as never);
    const ok: LlmResponse = { text: 'reach me at leak@secret.com', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('q');
    expect(r.outcome).toBe('delivered');
    expect(r.text).not.toContain('leak@secret.com');
    expect(r.text).toContain('[EMAIL_MASKED]');
  });

  it('rejects a route on an output-phase pii guard at init', () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'pii', route: 'somewhere' } as never);
    const { caller } = createFakeLlm([]);
    expect(() => createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' })).toThrow(/route/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kir-str/llm-gateway test tests/pii-output.test.ts`
Expected: FAIL — `pii` in `guards.output` currently builds a `phase:'input'` guard (A2 mismatch throws, or it scans the input), and there is no route-forbid.

- [ ] **Step 3: Make `createPiiGuard` phase-aware**

Replace `packages/gateway/src/guards/pii.ts`'s factory signature and text source:

```ts
export function createPiiGuard(cfg: GuardConfig, phase: 'input' | 'output'): Guard {
  const rules = (cfg.rules as string[] | undefined) ?? ['ru_phone', 'email'];
  const mask = (cfg.mask as Record<string, string> | undefined) ?? {};
  const route = cfg.route as string | undefined;
  return {
    name: cfg.name,
    phase,
    deterministic: true,
    transforms: true,
    ...(cfg.timeout_ms !== undefined ? { timeoutMs: cfg.timeout_ms } : {}),
    run(ctx): Verdict {
      let text = phase === 'output' ? (ctx.output?.text ?? '') : ctx.input.text;
      let email = false;
      let phone = false;
      EMAIL_RE.lastIndex = 0;
      if (rules.includes('email') && EMAIL_RE.test(text)) {
        email = true;
        text = text.replace(EMAIL_RE, mask.email ?? '[EMAIL_MASKED]');
      }
      RU_PHONE_RE.lastIndex = 0;
      if (rules.includes('ru_phone') && RU_PHONE_RE.test(text)) {
        phone = true;
        text = text.replace(RU_PHONE_RE, mask.ru_phone ?? '[PHONE_MASKED]');
      }
      const evidence = { email, phone };
      if (!email && !phone) return { outcome: 'PASS', evidence };
      const verdict: Verdict = { outcome: 'PASS', transform: text, evidence };
      if (route && phase === 'input') verdict.route = route; // route is only meaningful pre-LLM
      return verdict;
    },
  };
}
```

- [ ] **Step 4: Pass `phase` and forbid route-on-output in buildEntries**

In `packages/gateway/src/core/gateway.ts` `buildEntries`, change the pii branch from `createPiiGuard(cfg)` to a phase-aware call with the route guard:

```ts
      else if (cfg.name === 'pii') {
        if (phase === 'output' && cfg.route !== undefined)
          throw new ConfigError(`Guard "pii" does not support "route" in the output phase`);
        guard = createPiiGuard(cfg, phase);
      }
```

- [ ] **Step 5: Run tests + full suite + typecheck**

Run: `pnpm --filter @kir-str/llm-gateway test tests/pii-output.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS (the existing input-pii tests still pass — the input branch behavior is unchanged).
Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/guards/pii.ts packages/gateway/src/core/gateway.ts packages/gateway/tests/pii-output.test.ts
git commit -m "feat(hygiene): phase-aware pii (masks output.text via transform; route forbidden on output)"
```

---

### Task 5: leakage tests across sinks + error/detail/retry paths

**Files:**
- Test: `packages/gateway/tests/leakage.test.ts` (new)

**Interfaces:**
- Consumes: `createGateway`, `createJsonlSink` (`../src/node.js`), the Langfuse sink (`../src/langfuse.js`), fixtures. No new source — this locks the no-leak invariants; if a test reveals a real leak, fix the responsible source minimally.

- [ ] **Step 1: Write the tests**

Create `packages/gateway/tests/leakage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/index.js';
import { createJsonlSink } from '../src/node.js';
import { createLangfuseSink } from '../src/langfuse.js';
import type { Guard, GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const EMAIL = 'victim@secret.example';
const PHONE = '+79991234567';

function cfgWith(guard?: Record<string, unknown>): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  if (guard) cfg.guards!.output!.push(guard as never);
  return cfg;
}

describe('leakage: sentinel PII never reaches any sink', () => {
  it('jsonl sink: raw PII from the input never appears in written events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leak-'));
    try {
      const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
      const { caller } = createFakeLlm([ok]);
      const gw = createGateway(neutralConfig, { llm: caller, telemetry: createJsonlSink(dir), idGenerator: () => 't' });
      await gw.runTurn(`email ${EMAIL} phone ${PHONE}`);
      const contents = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
      expect(contents).not.toContain(EMAIL);
      expect(contents).not.toContain(PHONE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Langfuse sink: raw PII never appears in client calls', async () => {
    const calls: unknown[] = [];
    const client = { trace: () => ({ generation: (b: unknown) => { calls.push(b); return {}; }, update: (b: unknown) => { calls.push(b); return {}; } }) };
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: createLangfuseSink(client as never), idGenerator: () => 't' });
    await gw.runTurn(`email ${EMAIL} phone ${PHONE}`);
    expect(JSON.stringify(calls)).not.toContain(EMAIL);
  });

  it('custom guard evidence with raw PII is redacted under safe', async () => {
    const guard: Guard = { name: 'ev_leak', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { note: EMAIL } }) };
    const events: string[] = [];
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfgWith({ name: 'ev_leak' }), { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, guards: [guard], idGenerator: () => 't' });
    await gw.runTurn('q');
    expect(events.join('')).not.toContain(EMAIL);
  });

  it('a thrown guard Error message with raw PII never reaches telemetry', async () => {
    const guard: Guard = { name: 'ev_throw', phase: 'output', deterministic: true, run: () => { throw new Error(`boom ${EMAIL}`); } };
    const events: string[] = [];
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfgWith({ name: 'ev_throw', on_error: 'degrade' }), { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, guards: [guard], idGenerator: () => 't' });
    await gw.runTurn('q');
    expect(events.join('')).not.toContain(EMAIL);
  });

  it('structured_parse.detail carries the path/constraint, not the failing value', async () => {
    // structured validation fails (missing confidence) → detail must not quote the answer value
    const bad: LlmResponse = { text: 'x', structured: { answer: EMAIL }, usage: { inputTokens: 1, outputTokens: 1 } };
    const ok: LlmResponse = { text: 'x', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const events: string[] = [];
    const { caller } = createFakeLlm([bad, ok]);
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, idGenerator: () => 't' });
    await gw.runTurn('q');
    const detailEvents = events.filter((e) => e.includes('structured_parse'));
    expect(detailEvents.join('')).not.toContain(EMAIL);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @kir-str/llm-gateway test tests/leakage.test.ts`
Expected: PASS. (The Langfuse and structured-detail cases are green on arrival — they lock the invariant. The jsonl / custom-evidence / guard-error cases rely on Tasks 3-4 and the existing PII-free event model.) **If any test finds a real leak, fix the responsible source minimally and re-run** — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/tests/leakage.test.ts
git commit -m "test(hygiene): leakage suite — sentinel PII absent from jsonl+langfuse sinks, evidence, error, detail, retry"
```

---

### Task 6: judge comment + versioning + docs + green gate

**Files:**
- Modify: `packages/gateway/src/guards/judge.ts` (reason comment)
- Modify: `packages/gateway/package.json` (0.7.0)
- Modify: `packages/gateway/CHANGELOG.md` (0.7.0 entry)
- Modify: `packages/gateway/README.md` (evidence policy, safe boundary, output-pii + structured-not-masked, parallel-guards boundary, config version 1.4.0)
- Modify: `examples/minimal/gateway.config.yaml` (config `version: 1.4.0`)

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: released version metadata + user docs (evidence policy, the two hygiene boundaries) + a green gate.

- [ ] **Step 1: Update the judge comment**

In `packages/gateway/src/guards/judge.ts`, find the reason-drop comment referencing "increment C" and replace it so it no longer promises future forwarding, e.g.:

```ts
      // `reason` is model-generated free text and is intentionally NOT forwarded to evidence or
      // telemetry — only the decision leaves the judge.
```

- [ ] **Step 2: Versions**

`packages/gateway/package.json`: `"version": "0.7.0"`.
`examples/minimal/gateway.config.yaml`: config `version:` → `1.4.0` (update the trailing comment to note the evidence-policy/output-pii addition).

- [ ] **Step 3: CHANGELOG**

Insert at the top of `packages/gateway/CHANGELOG.md` (above `## 0.6.0`):

```markdown
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
```

- [ ] **Step 4: README**

Add/extend the guards docs in `packages/gateway/README.md`:
- An "Evidence policy" subsection: the three levels, the built-in→`full` / custom→`safe` defaults, the `safe` semantics (redact strings, keep primitives/keys, depth/size cap), and the guarantee boundary (`safe` sanitizes values, not keys).
- In the pii docs: note that pii can run in `guards.output` to mask the delivered text, that `output.structured` is NOT masked, and the parallel-output-guards boundary (a judge in the same phase sends the unmasked output to its LLM).
- Update any config snippet `version:` to `1.4.0`.

- [ ] **Step 5: Green gate**

Run each; all must pass (fix only formatting/lint):
- `pnpm exec prettier --write "packages/gateway/**/*.{ts,json,md}" "examples/minimal/gateway.config.yaml"` then `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm --filter @kir-str/llm-gateway build`
- `pnpm test` — all packages green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/guards/judge.ts packages/gateway/package.json packages/gateway/CHANGELOG.md packages/gateway/README.md examples/minimal/gateway.config.yaml
git commit -m "chore(hygiene): judge reason comment; bump 0.7.0/config 1.4.0; README (evidence policy + boundaries); green gate"
```

---

## Self-Review

**1. Spec coverage:**
- §2 evidence policy (chokepoint, levels, safe semantics incl. sentinel/keys/depth-size, defaults) → Task 1 (sanitizer) + Task 3 (wiring/defaults). ✓
- §3 config (evidence on open + limits + judge) → Task 2 (note: `limits` `then` is open so the generic key covers it; only `judge` `then` is closed and needs the key added). ✓
- §4 phase-aware pii (output masking, route→ConfigError) → Task 4. ✓
- §5 parallel-output-guards boundary (judge sends unmasked output; input already masked) → documented in Global Constraints + Task 6 README/CHANGELOG. ✓
- §6 judge reason comment → Task 6. ✓
- §7 leakage tests (jsonl+langfuse+guard-error+structured+retry) → Task 5. ✓
- §8 files → Tasks 1-6. ✓
- §9 errors (route-on-output ConfigError; invalid evidence enum) → Task 4 + Task 2. ✓
- §10 versioning → Task 6. ✓
- §11 invariants → Global Constraints + tests. ✓
- §12 out-of-scope → nothing builds them. ✓

**2. Placeholder scan:** No TBD/TODO; every code/test step is complete; commands have expected results. Node cap (64) and depth cap (4) are concrete. ✓

**3. Type consistency:** `EvidencePolicy` and `sanitizeEvidence(evidence, policy)` (Task 1) are used identically in `GuardEntry`/`GuardRunOutcome`/`buildEntries`/emit (Task 3); `createPiiGuard(cfg, phase)` (Task 4) matches its buildEntries call; sentinel strings (`'[omitted:string]'`/`'[omitted:depth]'`/`'[omitted:size]'`) match between Task 1 impl and Task 1/3/5 assertions; `DEFAULTS[cfg.name] !== undefined` is the built-in test (DEFAULTS has injection/pii/limits/policy/judge). ✓
