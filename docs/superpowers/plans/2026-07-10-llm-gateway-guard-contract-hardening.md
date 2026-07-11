# Guard Contract/Config Hardening (Increment A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close guard contract/config seams (init validation + one output-path bug fix) so the LLM judge (B) and external guards (D) can't be built with holes in timeouts, config, or output correctness.

**Architecture:** Four changes to two core files plus docs/versioning. `config-schema.ts` gets a tightened ajv schema (A5). `gateway.ts` `buildEntries` gets three init checks (A1 non-deterministic⇒positive timeout; A2 section≠phase; A3 custom-guard cfg apply/forbid via a non-mutating wrapper), and its output stage applies the aggregate transform (A4). The public `Guard` interface is unchanged.

**Tech Stack:** TypeScript strict (NodeNext, ES2022, ESM), ajv, vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-10-llm-gateway-guard-contract-hardening.md`.

## Global Constraints

Every task implicitly includes these (verbatim from the spec):

- Public `Guard` interface is **unchanged** (`run(ctx)` — no `signal`).
- All new validation is **init-time `ConfigError`** from `createGateway` (fail-fast); `runTurn` never throws for normal outcomes.
- **`deps.guards` is never mutated** — the custom-guard timeout override builds an effective guard via a delegating wrapper.
- A1 check is on a **positive** effective timeout: `guard.deterministic === false && (guard.timeoutMs === undefined || guard.timeoutMs < 1)` → `ConfigError` (closes the `guards-runner.ts:37` truthy-`0` hole).
- A4 applies transform to **`output.text` only**; `output.structured` is not masked (documented known limitation).
- ajv: guard elements stay **open** (`required:['name']` + typed common keys, `additionalProperties` NOT closed) except a **targeted** discriminated schema for `name:'limits'` (`per_day` closed). `timeout_ms` is `integer, minimum: 1`.
- Config `version` **`1.1.0 → 1.2.0`**; package `@kir-str/llm-gateway` **`0.4.0 → 0.5.0`** (breaking-in-minor allowed pre-1.0; note in CHANGELOG/README).
- TS strict via `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); ESM `.js` specifiers; `import type` for type-only.
- Work on branch `feat/guard-hardening` (isolated worktree if subagent-driven). Commit after each task. Existing 152 tests must stay green.

---

### Task 1: A5 — tighten the ajv config schema

**Files:**
- Modify: `packages/gateway/src/core/config-schema.ts:89-95` (schema object)
- Test: `packages/gateway/tests/config-schema.test.ts`

**Interfaces:**
- Consumes: nothing new (edits the existing `schema` literal compiled at `config-schema.ts:103`).
- Produces: `createGateway`/config validation now rejects: a guard element without `name`; `timeout_ms` that isn't an integer ≥ 1; `hard_cap_uds` (any key other than `hard_cap_usd`/`soft_warning_usd`) inside a `name:'limits'` guard's `per_day`; unknown keys in top-level `limits` and in `routing.rules[]`. Guard-specific keys on non-`limits` guards still pass.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/tests/config-schema.test.ts` (it already imports the config validator; mirror its existing valid/invalid-config style). Use a helper that builds a minimal valid config and lets each test inject the offending fragment — if the file has no such helper, add these self-contained tests using `createGateway` with a fake llm/telemetry (throwing `ConfigError` on invalid config). Concretely:

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { GatewayConfig } from '../src/core/config-schema.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

function make(mutate: (c: GatewayConfig) => void) {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  mutate(cfg);
  const { caller } = createFakeLlm([]);
  return () => createGateway(cfg, { llm: caller, telemetry: { event() {} }, idGenerator: () => 't' });
}

describe('A5: tightened config schema', () => {
  it('rejects a guard element without a name', () => {
    expect(make((c) => (c.guards!.input as unknown[]).push({ on_error: 'degrade' }))).toThrow(/name/i);
  });

  it('rejects timeout_ms that is not a positive integer', () => {
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).timeout_ms = 0))).toThrow();
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).timeout_ms = 1.5))).toThrow();
  });

  it("rejects a typo key inside a limits guard's per_day", () => {
    expect(
      make((c) => {
        const limits = c.guards!.input!.find((g) => g.name === 'limits') as Record<string, unknown>;
        limits.per_day = { hard_cap_uds: 10, soft_warning_usd: 5 };
      }),
    ).toThrow();
  });

  it('accepts a valid limits per_day', () => {
    expect(
      make((c) => {
        const limits = c.guards!.input!.find((g) => g.name === 'limits') as Record<string, unknown>;
        limits.per_day = { hard_cap_usd: 12, soft_warning_usd: 6 };
      }),
    ).not.toThrow();
  });

  it('rejects an unknown key in top-level limits', () => {
    expect(make((c) => ((c.limits as Record<string, unknown>).per_requst = { max_cost_usd: 1 }))).toThrow();
  });

  it('rejects an unknown key in normalize (closed object)', () => {
    expect(make((c) => ((c.normalize as Record<string, unknown>).max_input_charss = 10))).toThrow();
  });

  it('rejects an unknown key in a routing rule', () => {
    expect(make((c) => ((c.routing.rules[0] as Record<string, unknown>).scenari = 'main'))).toThrow();
  });

  it('still accepts arbitrary guard-specific keys on non-limits guards', () => {
    expect(
      make((c) => ((c.guards!.input![0] as Record<string, unknown>).patterns = [{ id: 'x', kind: 'substring', pattern: 'y', severity: 'soft' }])),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kir-str/llm-gateway test tests/config-schema.test.ts`
Expected: the new cases FAIL (current schema has `guards.*: {type:'array'}`, `limits: {type:'object'}`, `routing.rules: {type:'array'}` — no element/typo constraints), i.e. missing-name, `timeout_ms:0/1.5`, `hard_cap_uds`, top-level `limits.per_requst`, and `routing.rules[].scenari` are all silently accepted today. Two cases are green on arrival: the `normalize.max_input_charss` case (the `normalize` object is already closed at `config-schema.ts:86`) and the two `not.toThrow` acceptance cases — those pass now and continue to pass after Task 1.

- [ ] **Step 3: Tighten the schema**

In `packages/gateway/src/core/config-schema.ts`, replace the `guards`, `limits`, and `routing` properties (lines 89-95) with:

```ts
    guards: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'array', items: { $ref: '#/$defs/guardConfig' } },
        output: { type: 'array', items: { $ref: '#/$defs/guardConfig' } },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        per_request: {
          type: 'object',
          additionalProperties: false,
          properties: { max_cost_usd: { type: 'number' } },
        },
        prices: { type: 'object' },
      },
    },
    routing: {
      type: 'object',
      required: ['rules'],
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              when: {
                type: 'object',
                additionalProperties: false,
                required: ['flags_any'],
                properties: { flags_any: { type: 'array', items: { type: 'string' } } },
              },
              scenario: { type: 'string' },
              default: { type: 'string' },
            },
          },
        },
      },
    },
```

Then add a `$defs` block to the top-level `schema` object (as a sibling of `properties`, before the closing `} as const;` at line 101):

```ts
    $defs: {
      guardConfig: {
        type: 'object',
        required: ['name'],
        // additionalProperties intentionally OPEN: guard-specific keys (patterns, rules, mask, per_day, ...)
        properties: {
          name: { type: 'string' },
          on_error: { enum: ['reject', 'degrade'] },
          timeout_ms: { type: 'integer', minimum: 1 },
          reject_template: { type: 'string' },
          route: { type: 'string' },
        },
        allOf: [
          {
            if: { required: ['name'], properties: { name: { const: 'limits' } } },
            then: {
              properties: {
                per_day: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    hard_cap_usd: { type: 'number', minimum: 0 },
                    soft_warning_usd: { type: 'number', minimum: 0 },
                  },
                },
              },
            },
          },
        ],
      },
    },
```

(ajv is created with `strict: false` at `config-schema.ts:64`, which permits `$defs`/`$ref`/`if`/`then`/`allOf`.)

- [ ] **Step 4: Run the config-schema tests + the full package suite**

Run: `pnpm --filter @kir-str/llm-gateway test tests/config-schema.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS. **If the tightened schema newly rejects a pre-existing fixture/test config** (e.g. a routing rule or limits shape with a stray key), inspect it: fix the fixture if the key is a genuine typo/invalid, or widen the schema minimally if the key is legitimate and was under-specified in the spec. Do not loosen back to `type:'array'`/`type:'object'`.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

```bash
git add packages/gateway/src/core/config-schema.ts packages/gateway/tests/config-schema.test.ts
git commit -m "feat(hardening): A5 tighten ajv schema (guard elements, limits.per_day, routing.rules)"
```

---

### Task 2: A1 + A2 + A3 — buildEntries init checks

**Files:**
- Modify: `packages/gateway/src/core/gateway.ts:206-231` (`buildEntries`)
- Test: `packages/gateway/tests/guard-init.test.ts` (new)

**Interfaces:**
- Consumes: `ConfigError` (already imported in `gateway.ts`), `Guard` type from `./types.js`, `GuardConfig`, `GuardEntry`.
- Produces: `createGateway` now throws `ConfigError` for: a non-deterministic guard without a positive `timeoutMs`; a built-in guard placed in the wrong section (phase mismatch); a custom guard with a `route`. A custom guard's `cfg.timeout_ms` is applied to an **effective** guard (a delegating wrapper) — the injected object in `deps.guards` is not mutated.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/guard-init.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };
function gw(cfg: GatewayConfig, guards?: Guard[]) {
  const { caller } = createFakeLlm([]);
  return () => createGateway(cfg, { llm: caller, telemetry: nullSink, guards, idGenerator: () => 't' });
}
function withInputGuard(cfgEntry: Record<string, unknown>): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  cfg.guards!.input!.push(cfgEntry as never);
  return cfg;
}
const passGuard = (over: Partial<Guard>): Guard => ({
  name: 'judge',
  phase: 'input',
  deterministic: true,
  run: () => ({ outcome: 'PASS' }),
  ...over,
});

describe('A1: non-deterministic guard requires a positive timeout', () => {
  it('throws when deterministic:false and no timeout', () => {
    const cfg = withInputGuard({ name: 'judge' });
    expect(gw(cfg, [passGuard({ deterministic: false })])).toThrow(/deterministic|timeout/i);
  });
  it('throws when deterministic:false and timeoutMs is 0 (injected, bypasses schema)', () => {
    const cfg = withInputGuard({ name: 'judge' });
    expect(gw(cfg, [passGuard({ deterministic: false, timeoutMs: 0 })])).toThrow(/timeout/i);
  });
  it('accepts deterministic:false with a positive timeoutMs', () => {
    const cfg = withInputGuard({ name: 'judge' });
    expect(gw(cfg, [passGuard({ deterministic: false, timeoutMs: 5000 })])).not.toThrow();
  });
});

describe('A2: config section must match the guard phase', () => {
  it('throws when a built-in input guard (pii) is placed in guards.output', () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'pii' } as never);
    expect(gw(cfg)).toThrow(/phase/i);
  });
});

describe('A3: custom-guard config overlay', () => {
  it('throws when a custom guard config carries a route', () => {
    const cfg = withInputGuard({ name: 'judge', route: 'main' });
    expect(gw(cfg, [passGuard({})])).toThrow(/route/i);
  });
  it('applies cfg.timeout_ms to an effective guard WITHOUT mutating the injected guard', () => {
    const injected = passGuard({ deterministic: false });
    const cfg = withInputGuard({ name: 'judge', timeout_ms: 1234 });
    expect(gw(cfg, [injected])).not.toThrow(); // effective timeout satisfies A1
    expect(injected.timeoutMs).toBeUndefined(); // injected object left untouched
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @kir-str/llm-gateway test tests/guard-init.test.ts`
Expected: FAIL — current `buildEntries` performs none of these checks (A1/A2/A3 not implemented); the mutation-free timeout application is absent.

- [ ] **Step 3: Implement the checks in buildEntries**

In `packages/gateway/src/core/gateway.ts`, ensure `Guard` is imported from `./types.js` (add it to the existing type import if absent). Replace `buildEntries` (lines 206-231) with:

```ts
  function buildEntries(cfgs: GuardConfig[], phase: 'input' | 'output'): GuardEntry[] {
    const entries = cfgs.map((cfg) => {
      const def = DEFAULTS[cfg.name];
      let guard: Guard;
      if (cfg.name === 'injection') guard = createInjectionGuard(cfg);
      else if (cfg.name === 'pii') guard = createPiiGuard(cfg);
      else if (cfg.name === 'limits') guard = createLimitsGuard(cfg, { store });
      else if (cfg.name === 'policy') guard = createPolicyGuard(cfg);
      else {
        const custom = (deps.guards ?? []).find((g) => g.name === cfg.name && g.phase === phase);
        if (!custom)
          throw new ConfigError(
            `Unknown guard "${cfg.name}" (${phase}); not built-in and not in deps.guards`,
          );
        // A3: route overlay is not supported for custom guards (ambiguous semantics).
        if (cfg.route !== undefined)
          throw new ConfigError(`Guard "${cfg.name}": "route" is supported only for built-in guards`);
        // A3: apply cfg.timeout_ms via a delegating wrapper — never mutate the injected guard.
        if (cfg.timeout_ms === undefined) {
          guard = custom;
        } else {
          guard = {
            name: custom.name,
            phase: custom.phase,
            deterministic: custom.deterministic,
            timeoutMs: cfg.timeout_ms,
            run: (ctx) => custom.run(ctx),
            ...(custom.transforms !== undefined ? { transforms: custom.transforms } : {}),
          };
        }
      }
      // A2: a materialized guard's phase must match the section it is configured under.
      if (guard.phase !== phase)
        throw new ConfigError(
          `Guard "${cfg.name}" has phase "${guard.phase}" but is configured under guards.${phase}`,
        );
      // A1: a non-deterministic guard requires a positive effective timeout (closes the
      // guards-runner truthy-0 hole where timeoutMs:0 silently disables the timer race).
      if (guard.deterministic === false && (guard.timeoutMs === undefined || guard.timeoutMs < 1))
        throw new ConfigError(
          `Guard "${cfg.name}" is non-deterministic and requires a positive timeout_ms`,
        );
      const onError = (cfg.on_error ?? def?.onError ?? 'degrade') as 'reject' | 'degrade';
      const rejectTemplate =
        (cfg.reject_template as string | undefined) ?? def?.template ?? 'degrade';
      return { guard, onError, rejectTemplate };
    });
    const transformers = entries.filter((e) => e.guard.transforms === true);
    if (transformers.length > 1)
      throw new ConfigError(`More than one transforming guard in ${phase} phase`);
    return entries;
  }
```

Note (`exactOptionalPropertyTypes`): `transforms` is added conditionally (never assigned `undefined`); `timeoutMs` is a concrete number in the wrapper.

- [ ] **Step 4: Run the new tests + full suite**

Run: `pnpm --filter @kir-str/llm-gateway test tests/guard-init.test.ts`
Expected: PASS.
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS (the existing `neutralConfig` uses only deterministic built-ins in matching sections, so A1/A2/A3 don't fire on it).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

```bash
git add packages/gateway/src/core/gateway.ts packages/gateway/tests/guard-init.test.ts
git commit -m "feat(hardening): A1/A2/A3 buildEntries init checks (deterministic timeout, section=phase, custom-guard overlay)"
```

---

### Task 3: A4 — apply the output-phase transform

**Files:**
- Modify: `packages/gateway/src/core/gateway.ts:587-597` (output stage non-reject branch)
- Test: `packages/gateway/tests/output-transform.test.ts` (new)

**Interfaces:**
- Consumes: the `outAgg` aggregate already computed at `gateway.ts:578`; `finish(...)`.
- Produces: when an output guard returns `{ outcome: 'PASS', transform: <text> }`, the delivered `TurnResult.text` is the transformed text (mirrors input handling at `gateway.ts:368`). `TurnResult.structured` is unchanged (not masked — documented limitation).

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/output-transform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };

// A custom output guard that masks a token in the model's output text.
const maskingOutputGuard: Guard = {
  name: 'output_masker',
  phase: 'output',
  deterministic: true,
  transforms: true,
  run: (ctx) => {
    const text = ctx.output?.text ?? '';
    if (!text.includes('SECRET')) return { outcome: 'PASS' };
    return { outcome: 'PASS', transform: text.replace(/SECRET/g, '[MASKED]') };
  },
};

function configWithMaskingOutput(): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  cfg.guards!.output!.push({ name: 'output_masker' } as never);
  return cfg;
}

describe('A4: output-phase transform is applied to delivered text', () => {
  it('delivers the transformed text, not the raw model output', async () => {
    const ok: LlmResponse = {
      text: 'here is a SECRET value',
      structured: { answer: 'a', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(configWithMaskingOutput(), {
      llm: caller,
      telemetry: nullSink,
      guards: [maskingOutputGuard],
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('question');
    expect(r.outcome).toBe('delivered');
    expect(r.text).toBe('here is a [MASKED] value');
  });

  it('does NOT mask output.structured (documented v1 limitation)', async () => {
    const ok: LlmResponse = {
      text: 'clean text',
      structured: { answer: 'contains SECRET', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(configWithMaskingOutput(), {
      llm: caller,
      telemetry: nullSink,
      guards: [maskingOutputGuard],
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('question');
    // structured is delivered as-is — transform only covers text (known limitation).
    expect(JSON.stringify(r.structured)).toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kir-str/llm-gateway test tests/output-transform.test.ts`
Expected: the first test FAILS — the delivered text is the raw `here is a SECRET value` because the output stage ignores `outAgg.transform`. (The second test passes on arrival — structured is already unmasked.)

- [ ] **Step 3: Apply the transform in the output stage**

In `packages/gateway/src/core/gateway.ts`, in the non-reject branch of the output loop (lines 587-597), change the delivered text argument from `c.output?.text ?? ''` to `outAgg.transform ?? c.output?.text ?? ''`:

```ts
        if (outAgg.decision !== 'reject') {
          return finish(
            'delivered',
            kind,
            outAgg.transform ?? c.output?.text ?? '',
            scenarioName,
            mergedFlags,
            undefined,
            c.output?.structured,
          );
        }
```

- [ ] **Step 4: Run the test + full suite**

Run: `pnpm --filter @kir-str/llm-gateway test tests/output-transform.test.ts`
Expected: PASS (both tests).
Run: `pnpm --filter @kir-str/llm-gateway test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @kir-str/llm-gateway typecheck`
Expected: clean.

```bash
git add packages/gateway/src/core/gateway.ts packages/gateway/tests/output-transform.test.ts
git commit -m "fix(hardening): A4 apply output-phase transform to delivered text (text-only)"
```

---

### Task 4: Versioning + docs + examples-typecheck follow-up + green gate

**Files:**
- Modify: `packages/gateway/package.json` (version `0.5.0`)
- Modify: `packages/gateway/CHANGELOG.md` (0.5.0 entry)
- Modify: `packages/gateway/README.md` (breaking-validation note)
- Modify: `examples/minimal/gateway.config.yaml` (config `version: 1.2.0`)
- Modify: root `package.json` (`typecheck` script — exclude examples)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: released version metadata, docs, a workspace `typecheck` that no longer requires a prior build, and a green workspace gate.

- [ ] **Step 1: Bump versions and config version**

In `packages/gateway/package.json`, set `"version": "0.5.0"`.
In `examples/minimal/gateway.config.yaml`, set the top-level `version:` field to `1.2.0` (locate the existing `version:` line and change its value).

- [ ] **Step 2: CHANGELOG + README**

Insert at the top of `packages/gateway/CHANGELOG.md` (above `## 0.4.0`):

```markdown
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
```

In `packages/gateway/README.md`: (a) update the config snippet at `README.md:140` from `version: 1.1.0` to `version: 1.2.0` (otherwise the README contradicts the CHANGELOG/spec after the bump); (b) add a short note where config/versioning is discussed (or a "Breaking changes" line): that 0.5.0 tightens config validation (config `version` 1.2.0) and that pre-1.0 minor releases may include breaking changes.

- [ ] **Step 3: Fix the examples workspace-typecheck follow-up**

The root `typecheck` (`pnpm -r --parallel exec tsc --noEmit`) fails in `examples/entitlements-basic` on a fresh checkout because the example resolves `@kir-str/entitlements` via its built `dist` (absent until `pnpm build`). Examples are demo consumers, not shipped packages. In the root `package.json`, change the `typecheck` script to exclude the examples workspace so the gate no longer depends on a prior build:

```jsonc
    "typecheck": "pnpm -r --parallel --filter=!./examples/* exec tsc --noEmit",
```

(Examples remain runnable via `--experimental-strip-types` and can be typechecked on demand after a build.)

- [ ] **Step 4: Green gate across the workspace**

Run each; all must pass (fix only formatting/lint — no behavior change):
- `pnpm exec prettier --write "packages/gateway/**/*.{ts,json,md}" "examples/minimal/gateway.config.yaml" "package.json"` then `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck` (now excludes examples; must be clean without a prior build)
- `pnpm --filter @kir-str/llm-gateway build`
- `pnpm test` — all packages green (gateway suite incl. Tasks 1-3 tests + entitlements).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/package.json packages/gateway/CHANGELOG.md packages/gateway/README.md examples/minimal/gateway.config.yaml package.json
git commit -m "chore(hardening): bump to 0.5.0 / config 1.2.0; docs; exclude examples from workspace typecheck; green gate"
```

---

## Self-Review

**1. Spec coverage:**

- §2 A1 (`deterministic:false ⇒ timeoutMs ≥ 1`) → Task 2 (buildEntries check) + Task 1 (schema `timeout_ms` integer≥1). ✓
- §3 A2 (section≠phase ConfigError) → Task 2. ✓
- §4 A3 (custom `timeout_ms` apply via non-mutating wrapper; `route` forbid) → Task 2. ✓
- §5 A4 (output transform, text-only, structured limitation) → Task 3 (both tests). ✓
- §6 A5 (guard element schema, discriminated limits.per_day, top-level limits, routing.rules) → Task 1. ✓
- §7 files → Tasks 1-4. ✓
- §8 errors (init ConfigError; runTurn doesn't throw) → Tasks 1-2 tests use `createGateway` throw. ✓
- §9 tests (A1 incl. timeoutMs:0; A2; A3 incl. no-mutation; A4 incl. structured; A5 incl. hard_cap_uds/missing-name/timeout_ms:0/normalize typo) → Tasks 1-3. ✓
- §10 versioning (config 1.2.0, package 0.5.0, CHANGELOG/README) + examples-typecheck follow-up → Task 4. ✓
- §11 invariants → Global Constraints + tests. ✓
- §12 out-of-scope → nothing builds them. ✓

**2. Placeholder scan:** No TBD/TODO; every code/test step is complete; commands have expected results. The one conditional (Task 1 Step 4 "if a pre-existing fixture is newly rejected, inspect") is a bounded verification tied to running the suite, not an open placeholder. ✓

**3. Type consistency:** `buildEntries(cfgs, phase)`, `ConfigError`, `Guard` (`name`/`phase`/`deterministic`/`timeoutMs`/`transforms`/`run`), `GuardEntry` (`guard`/`onError`/`rejectTemplate`), `outAgg.transform`, `finish(outcome, kind, text, scenario, flags, degradeReason?, structured?)` are used consistently across tasks and match the current source signatures verified in the spec. Schema `$defs.guardConfig` referenced by both `guards.input/output` items. ✓
