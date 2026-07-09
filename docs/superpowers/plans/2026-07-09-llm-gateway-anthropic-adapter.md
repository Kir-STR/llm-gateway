# Anthropic Adapter (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an optional Anthropic `LlmCaller` implementation (`@kir-str/llm-gateway/anthropic`) on top of `@anthropic-ai/sdk` — a thin translator `LlmRequest` → `messages.create` → `LlmResponse`, with structured output via forced tool use and provider errors mapped to `LlmCallError`.

**Architecture:** New subpath entry `src/anthropic.ts` in the existing `@kir-str/llm-gateway` package. The factory takes an injected Anthropic client (a minimal structural interface typed against the real SDK via `import type`, so runtime stays SDK-free). It never constructs a client, owns no retry/timeout policy (core owns those — Spec A), passes `signal` through, and forces `maxRetries: 0` per request. Errors are classified by duck-typing (`err.name` / `err.status`), so the mapper needs no SDK value import.

**Tech Stack:** TypeScript (NodeNext, ES2022, ESM), `@anthropic-ai/sdk` (optional peer + dev dep), vitest 2.1, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-09-llm-gateway-anthropic-adapter.md`.

## Global Constraints

- **Node ≥ 22; ESM; `module`/`moduleResolution` NodeNext.** Relative imports use `.js` extensions.
- **`verbatimModuleSyntax: true`** → all type-only imports MUST use `import type`. The SDK is imported **type-only** in `src/anthropic.ts`; the built `dist/anthropic.js` must contain no `require('@anthropic-ai/sdk')`.
- **`exactOptionalPropertyTypes: true`** → never assign `undefined` to an optional property; add it conditionally (`if (x !== undefined) obj.x = x`), mirroring `src/core/gateway.ts`.
- **`noUncheckedIndexedAccess: true`** → indexed access is `T | undefined`; guard or iterate with `for..of`.
- **No `node:*` in `src/anthropic.ts`** (runtime-agnostic zone, like `core/`). `node:*` is allowed only in test files.
- **`@anthropic-ai/sdk` is NOT a runtime dependency.** Declared as `optionalDependency`-style peer (`peerDependencies` + `peerDependenciesMeta.optional`) plus `devDependencies`. Base entries `.` and `./node` never import it (value or type).
- **Core owns retry and timeout.** Adapter sends per-request `maxRetries: 0`; passes `signal` through; enforces no timeout of its own.
- **Structured output = forced tool use only.** `output_config.format` is out of scope. Synthetic tool name: `emit_structured_output`.
- **No secrets/PII in error messages.** `LlmCallError` messages are generic; do not echo provider error bodies.
- **Package version:** minor bump `0.2.0` → `0.3.0`. Contract types (`LlmCaller`/`LlmRequest`/`LlmResponse`) are NOT changed — only a stale doc-comment is refreshed.
- **Package name for `pnpm --filter`:** `@kir-str/llm-gateway`.

---

### Task 1: Optional SDK dependency, subpath export, version bump, and SDK-surface probe

Wire `@anthropic-ai/sdk` as dev + optional peer, add the `./anthropic` export, bump the version, and lock the exact SDK type symbols we depend on with a type-only probe (resolves spec §13). No adapter code yet.

**Files:**
- Modify: `packages/gateway/package.json`
- Create: `packages/gateway/tests/anthropic-sdk-compat.ts` (typechecked, not run by vitest)

**Interfaces:**
- Consumes: nothing.
- Produces: confirmed SDK symbols for later tasks — `Anthropic` (default export), `Anthropic.MessageCreateParamsNonStreaming`, `Anthropic.RequestOptions` (with a `maxRetries?: number` field), `Anthropic.Message`, `Anthropic.Tool.InputSchema`. The `./anthropic` subpath export resolving to `./dist/anthropic.js`.

- [ ] **Step 1: Install the SDK as a dev dependency (records the resolved version)**

Run:
```bash
pnpm --filter @kir-str/llm-gateway add -D @anthropic-ai/sdk
```
Expected: `@anthropic-ai/sdk` appears in `packages/gateway/package.json` `devDependencies` with a resolved version (e.g. `"^0.6x.y"`). Note the caret range — you will reuse it for the peer range in Step 2.

- [ ] **Step 2: Edit `packages/gateway/package.json` — version, exports, peer**

Set `version` to `0.3.0`, add the `./anthropic` export, and declare the SDK as an optional peer. Reuse the exact caret range recorded in Step 1 in place of `^0.x` below (all three occurrences must match).

```json
{
  "name": "@kir-str/llm-gateway",
  "version": "0.3.0",
  "description": "Config-driven LLM turn-processing pipeline as a library",
  "license": "MIT",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" },
    "./anthropic": { "types": "./dist/anthropic.d.ts", "import": "./dist/anthropic.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0",
    "yaml": "^2.6.0"
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": "^0.x"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true }
  },
  "devDependencies": {
    "@anthropic-ai/sdk": "^0.x"
  }
}
```

- [ ] **Step 3: Reinstall to apply the peer declaration**

Run:
```bash
pnpm install
```
Expected: completes without error; `@anthropic-ai/sdk` present under `packages/gateway/node_modules`.

- [ ] **Step 4: Write the SDK-surface probe (locks the exact type names + `maxRetries`)**

Create `packages/gateway/tests/anthropic-sdk-compat.ts`:
```ts
// Type-only probe: fails to typecheck if the installed @anthropic-ai/sdk does not
// expose the exact symbols the adapter relies on. Not a runtime test — vitest ignores
// non-*.test.ts files; `tsc --noEmit` (which includes tests/) validates it.
import type Anthropic from '@anthropic-ai/sdk';

export const _params = null as unknown as Anthropic.MessageCreateParamsNonStreaming;
export const _message = null as unknown as Anthropic.Message;
export const _inputSchema = null as unknown as Anthropic.Tool.InputSchema;

// Compile gate for spec §8: a per-request `maxRetries: 0` must be a valid RequestOptions.
export const _opts: Anthropic.RequestOptions = { maxRetries: 0 };
```

- [ ] **Step 5: Typecheck the probe**

Run:
```bash
pnpm --filter @kir-str/llm-gateway typecheck
```
Expected: PASS. If a symbol name is wrong for the installed version (e.g. `MessageCreateParams` without `NonStreaming`, or `Tool.InputSchema` renamed), fix the reference in the probe to the installed name and re-run until green. **Record the confirmed names** — Tasks 2 and 5 must use the same ones. If `_opts` fails because `RequestOptions` lacks `maxRetries`, stop and switch to the fallback in Appendix A before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/package.json packages/gateway/tests/anthropic-sdk-compat.ts pnpm-lock.yaml
git commit -m "build(anthropic): add optional @anthropic-ai/sdk peer, ./anthropic export, SDK-surface probe"
```

---

### Task 2: Adapter core — factory, client interface, happy text-path, request options

Create the adapter with the minimal client interface, the factory, and the non-structured call path: build the request body, call `messages.create`, map `usage` + text, and always pass `{ signal, maxRetries: 0 }`.

**Files:**
- Create: `packages/gateway/src/anthropic.ts`
- Create: `packages/gateway/tests/fixtures/fake-anthropic.ts`
- Create: `packages/gateway/tests/anthropic.test.ts`

**Interfaces:**
- Consumes: `LlmCaller`, `LlmRequest`, `LlmResponse`, `LlmErrorCode`, `LlmCallError` from `./core/types.js`; SDK types confirmed in Task 1.
- Produces:
  - `export interface AnthropicClientLike { messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message> } }`
  - `export interface AnthropicCallerOptions { defaultMaxTokens?: number }`
  - `export function createAnthropicLlmCaller(client: AnthropicClientLike, opts?: AnthropicCallerOptions): LlmCaller`
  - `createFakeAnthropic(responses)` → `{ client: AnthropicClientLike; calls: Array<{ body; options? }> }` and `makeMessage(content, usage)` from the fixture.

- [ ] **Step 1: Write the fake-anthropic fixture**

Create `packages/gateway/tests/fixtures/fake-anthropic.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicClientLike } from '../../src/anthropic.js';

export type FakeContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
>;

export type FakeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function makeMessage(content: FakeContent, usage: FakeUsage): Anthropic.Message {
  return { content, usage } as unknown as Anthropic.Message;
}

export function createFakeAnthropic(responses: Array<Anthropic.Message | Error>): {
  client: AnthropicClientLike;
  calls: Array<{
    body: Anthropic.MessageCreateParamsNonStreaming;
    options: Anthropic.RequestOptions | undefined;
  }>;
} {
  const calls: Array<{
    body: Anthropic.MessageCreateParamsNonStreaming;
    options: Anthropic.RequestOptions | undefined;
  }> = [];
  let i = 0;
  const client: AnthropicClientLike = {
    messages: {
      async create(body, options) {
        calls.push({ body, options });
        const next = responses[Math.min(i, responses.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}
```

- [ ] **Step 2: Write the failing text-path test**

Create `packages/gateway/tests/anthropic.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { LlmRequest } from '../src/core/types.js';
import { createAnthropicLlmCaller } from '../src/anthropic.js';
import { createFakeAnthropic, makeMessage } from './fixtures/fake-anthropic.js';

const baseReq: LlmRequest = { modelRef: 'fast', model: 'claude-x', input: 'hello', maxTokens: 64 };

describe('anthropic adapter — text path', () => {
  it('maps text blocks and usage (incl. cache tokens), sends user message + maxRetries:0', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }], {
        input_tokens: 3,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 9,
      }),
    ]);
    const caller = createAnthropicLlmCaller(client);

    const res = await caller.call(baseReq);

    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: 9,
    });
    expect(res.structured).toBeUndefined();
    expect(calls[0]?.body.model).toBe('claude-x');
    expect(calls[0]?.body.max_tokens).toBe(64);
    expect(calls[0]?.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(calls[0]?.options?.maxRetries).toBe(0);
  });

  it('forwards the AbortSignal into request options', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client);
    const ac = new AbortController();

    await caller.call(baseReq, ac.signal);

    expect(calls[0]?.options?.signal).toBe(ac.signal);
  });

  it('omits cache token fields when the provider does not return them', async () => {
    const { client } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 2 }),
    ]);
    const res = await createAnthropicLlmCaller(client).call(baseReq);
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: FAIL — `createAnthropicLlmCaller` / `../src/anthropic.js` not found.

- [ ] **Step 4: Implement the adapter (text path + options + response mapping)**

Create `packages/gateway/src/anthropic.ts`. Use the exact SDK symbol names confirmed in Task 1.
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmCaller, LlmRequest, LlmResponse } from './core/types.js';
import { LlmCallError } from './core/types.js';

// Minimal structural surface the adapter depends on. A real `Anthropic` client
// satisfies it. Typed against real SDK types so there is no drift and per-request
// `maxRetries` is compile-checked. `import type` keeps runtime free of the SDK.
export interface AnthropicClientLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicCallerOptions {
  /** Fallback for max_tokens when req.maxTokens is absent. Required in production; optional in the API for tests. */
  defaultMaxTokens?: number;
}

const STRUCTURED_TOOL_NAME = 'emit_structured_output';

function mapResponse(msg: Anthropic.Message): LlmResponse {
  const u = msg.usage;
  const usage: LlmResponse['usage'] = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = u.cache_creation_input_tokens;

  let text = '';
  let structured: unknown;
  let hasStructured = false;
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use' && block.name === STRUCTURED_TOOL_NAME) {
      structured = block.input;
      hasStructured = true;
    }
  }

  const res: LlmResponse = { usage };
  if (text.length > 0) res.text = text;
  if (hasStructured) res.structured = structured;
  return res;
}

export function createAnthropicLlmCaller(
  client: AnthropicClientLike,
  opts?: AnthropicCallerOptions,
): LlmCaller {
  return {
    async call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: req.maxTokens ?? opts?.defaultMaxTokens ?? 0, // guarded in Task 3
        messages: [{ role: 'user', content: req.input }],
      };

      const options: Anthropic.RequestOptions = { maxRetries: 0 };
      if (signal !== undefined) options.signal = signal;

      const msg = await client.messages.create(body, options);
      return mapResponse(msg);
    },
  };
}
```
Note: the `?? 0` on `max_tokens` is a temporary stand-in that Task 3 replaces with a pre-network guard. It keeps this task compiling without introducing the `LlmCallError` throw yet.

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/anthropic.ts packages/gateway/tests/fixtures/fake-anthropic.ts packages/gateway/tests/anthropic.test.ts
git commit -m "feat(anthropic): adapter text path — usage/text mapping, signal + maxRetries:0"
```

---

### Task 3: Request guardrails — model and max_tokens resolved before the network

Throw `LlmCallError('…','bad_request',false)` before any network call when `req.model` is empty or when neither `req.maxTokens` nor `defaultMaxTokens` is set; use `defaultMaxTokens` as the fallback otherwise.

**Files:**
- Modify: `packages/gateway/src/anthropic.ts`
- Modify: `packages/gateway/tests/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 2 factory.
- Produces: guaranteed non-empty `model` and numeric `max_tokens` in the body; pre-network `bad_request` failures.

- [ ] **Step 1: Write the failing guardrail tests**

Append to `packages/gateway/tests/anthropic.test.ts`:
```ts
import { LlmCallError } from '../src/core/types.js';

describe('anthropic adapter — request guardrails', () => {
  it('uses defaultMaxTokens when req.maxTokens is absent', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client, { defaultMaxTokens: 512 });
    await caller.call({ modelRef: 'fast', model: 'claude-x', input: 'hi' });
    expect(calls[0]?.body.max_tokens).toBe(512);
  });

  it('throws bad_request without hitting the network when max_tokens is unresolved', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client); // no defaultMaxTokens
    await expect(caller.call({ modelRef: 'fast', model: 'claude-x', input: 'hi' })).rejects.toMatchObject({
      name: 'LlmCallError',
      code: 'bad_request',
      retryable: false,
    });
    expect(calls.length).toBe(0);
  });

  it('throws bad_request without hitting the network when model is empty', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const caller = createAnthropicLlmCaller(client, { defaultMaxTokens: 64 });
    await expect(caller.call({ modelRef: 'fast', model: '', input: 'hi' })).rejects.toBeInstanceOf(LlmCallError);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts -t 'request guardrails'
```
Expected: FAIL — `max_tokens` falls back to `0` and no throw; `calls.length` is 1, not 0.

- [ ] **Step 3: Implement the guards**

In `packages/gateway/src/anthropic.ts`, replace the start of the `call` body (the `const body …` block) with:
```ts
      if (!req.model) {
        throw new LlmCallError('Missing req.model', 'bad_request', false);
      }
      const maxTokens = req.maxTokens ?? opts?.defaultMaxTokens;
      if (maxTokens === undefined) {
        throw new LlmCallError(
          'max_tokens is required: set req.maxTokens or AnthropicCallerOptions.defaultMaxTokens',
          'bad_request',
          false,
        );
      }
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: req.input }],
      };
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/anthropic.ts packages/gateway/tests/anthropic.test.ts
git commit -m "feat(anthropic): pre-network bad_request guards for model and max_tokens"
```

---

### Task 4: Correction → system, and temperature passthrough

Map `req.correction` to the top-level `system` field (only when present) and pass `req.temperature` through (only when present).

**Files:**
- Modify: `packages/gateway/src/anthropic.ts`
- Modify: `packages/gateway/tests/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 3 body building.
- Produces: `body.system` set iff `req.correction` defined; `body.temperature` set iff `req.temperature` defined.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/tests/anthropic.test.ts`:
```ts
describe('anthropic adapter — correction & temperature', () => {
  it('maps req.correction to top-level system', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call({ ...baseReq, correction: 'Fix the output to match the schema.' });
    expect(calls[0]?.body.system).toBe('Fix the output to match the schema.');
  });

  it('omits system when there is no correction', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call(baseReq);
    expect(calls[0]?.body.system).toBeUndefined();
  });

  it('passes temperature through when set', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call({ ...baseReq, temperature: 0.2 });
    expect(calls[0]?.body.temperature).toBe(0.2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts -t 'correction & temperature'
```
Expected: FAIL — `system` / `temperature` undefined.

- [ ] **Step 3: Implement**

In `packages/gateway/src/anthropic.ts`, immediately after the `const body … };` block (Task 3), add:
```ts
      if (req.correction !== undefined) body.system = req.correction;
      if (req.temperature !== undefined) body.temperature = req.temperature;
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/anthropic.ts packages/gateway/tests/anthropic.test.ts
git commit -m "feat(anthropic): correction -> system, temperature passthrough"
```

---

### Task 5: Structured output via forced tool use

When `req.toolSchema` is present, send a single synthetic tool with `input_schema = req.toolSchema` and force it via `tool_choice`; extract the first matching `tool_use.input` into `LlmResponse.structured`. The extraction side already exists in `mapResponse` (Task 2); this task adds the request side and the missing-block case.

**Files:**
- Modify: `packages/gateway/src/anthropic.ts`
- Modify: `packages/gateway/tests/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 4 body building; `STRUCTURED_TOOL_NAME`, `mapResponse` from Task 2.
- Produces: `body.tools` + `body.tool_choice` set iff `req.toolSchema` defined; `structured` populated from the tool call, `undefined` when no matching `tool_use` block is returned.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/tests/anthropic.test.ts`:
```ts
describe('anthropic adapter — structured (forced tool use)', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

  it('forces a single tool and extracts tool_use.input into structured', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage(
        [{ type: 'tool_use', id: 't1', name: 'emit_structured_output', input: { answer: 'a' } }],
        { input_tokens: 2, output_tokens: 3 },
      ),
    ]);
    const res = await createAnthropicLlmCaller(client).call({ ...baseReq, toolSchema: schema });

    expect(calls[0]?.body.tools).toEqual([
      {
        name: 'emit_structured_output',
        description: expect.any(String),
        input_schema: schema,
      },
    ]);
    expect(calls[0]?.body.tool_choice).toEqual({ type: 'tool', name: 'emit_structured_output' });
    expect(res.structured).toEqual({ answer: 'a' });
  });

  it('leaves structured undefined when the model returns no matching tool_use block', async () => {
    const { client } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'sorry' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    const res = await createAnthropicLlmCaller(client).call({ ...baseReq, toolSchema: schema });
    expect(res.structured).toBeUndefined();
  });

  it('does not send tools when toolSchema is absent', async () => {
    const { client, calls } = createFakeAnthropic([
      makeMessage([{ type: 'text', text: 'x' }], { input_tokens: 1, output_tokens: 1 }),
    ]);
    await createAnthropicLlmCaller(client).call(baseReq);
    expect(calls[0]?.body.tools).toBeUndefined();
    expect(calls[0]?.body.tool_choice).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts -t 'forced tool use'
```
Expected: FAIL — no `tools`/`tool_choice` on the body.

- [ ] **Step 3: Implement the request side**

In `packages/gateway/src/anthropic.ts`, after the `temperature` line (Task 4), add:
```ts
      if (req.toolSchema !== undefined) {
        body.tools = [
          {
            name: STRUCTURED_TOOL_NAME,
            description: 'Return the result strictly matching the provided JSON schema.',
            input_schema: req.toolSchema as Anthropic.Tool.InputSchema,
          },
        ];
        body.tool_choice = { type: 'tool', name: STRUCTURED_TOOL_NAME };
      }
```
Note: `req.toolSchema` is typed `object` in the core contract; the `as Anthropic.Tool.InputSchema` cast passes it through unchanged (spec §6 — no transformation). If Anthropic rejects the schema, that surfaces as a provider 400 → `bad_request` (Task 6), not a structured-correction retry.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/anthropic.ts packages/gateway/tests/anthropic.test.ts
git commit -m "feat(anthropic): structured output via forced tool use"
```

---

### Task 6: Error classification → `LlmCallError`

Map thrown SDK errors to `LlmCallError` by duck-typing `err.name` (for the three no-status connection/abort/timeout errors) then numeric `err.status`, per spec §9.

**Files:**
- Modify: `packages/gateway/src/anthropic.ts`
- Modify: `packages/gateway/tests/anthropic.test.ts`

**Interfaces:**
- Consumes: the `try` around `client.messages.create` (added here).
- Produces: every provider failure surfaces as `LlmCallError` with the code/retryable from the spec table.

- [ ] **Step 1: Write the failing error-mapping tests**

Append to `packages/gateway/tests/anthropic.test.ts`:
```ts
describe('anthropic adapter — error classification', () => {
  function withStatus(status: number): Error {
    const e = new Error('provider error');
    (e as unknown as { status: number }).status = status;
    return e;
  }
  function withName(name: string): Error {
    const e = new Error('provider error');
    e.name = name;
    return e;
  }

  const cases: Array<[Error, string, boolean]> = [
    [withStatus(429), 'rate_limit', true],
    [withStatus(529), 'overloaded', true],
    [withStatus(500), 'server', true],
    [withStatus(503), 'server', true],
    [withName('APIConnectionError'), 'server', true],
    [withName('APIConnectionTimeoutError'), 'timeout', false],
    [withName('APIUserAbortError'), 'timeout', false],
    [withStatus(401), 'auth', false],
    [withStatus(403), 'auth', false],
    [withStatus(400), 'bad_request', false],
    [withStatus(404), 'bad_request', false],
    [withStatus(413), 'bad_request', false],
    [new Error('weird'), 'unknown', false],
  ];

  it.each(cases)('maps %o -> code/retryable', async (thrown, code, retryable) => {
    const { client } = createFakeAnthropic([thrown]);
    await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
      name: 'LlmCallError',
      code,
      retryable,
    });
  });

  it('prefers numeric status over a generic connection name', async () => {
    const e = new Error('provider error');
    e.name = 'APIConnectionError';
    (e as unknown as { status: number }).status = 429;
    const { client } = createFakeAnthropic([e]);
    await expect(createAnthropicLlmCaller(client).call(baseReq)).rejects.toMatchObject({
      name: 'LlmCallError',
      code: 'rate_limit',
      retryable: true,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts -t 'error classification'
```
Expected: FAIL — raw errors propagate; they are not `LlmCallError`.

- [ ] **Step 3: Implement the classifier and wrap the call**

In `packages/gateway/src/anthropic.ts`, add this helper above `createAnthropicLlmCaller`:
```ts
// Duck-typed: no instanceof, no SDK value import. Order matters for errors that could
// carry more than one signal: abort/timeout by name first (always terminal), then numeric
// `status` (authoritative — an HTTP status means a real server response), then the
// no-status connection name, else unknown. So HTTP codes win over a generic class name.
// Messages are generic — never echo provider bodies (secret hygiene).
function classifyError(err: unknown): LlmCallError {
  const name = typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';
  if (name === 'APIUserAbortError') return new LlmCallError('LLM call aborted', 'timeout', false);
  if (name === 'APIConnectionTimeoutError') return new LlmCallError('LLM call timed out', 'timeout', false);

  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return new LlmCallError('rate limited', 'rate_limit', true);
    if (status === 529) return new LlmCallError('overloaded', 'overloaded', true);
    if (status >= 500) return new LlmCallError('server error', 'server', true);
    if (status === 401 || status === 403) return new LlmCallError('auth error', 'auth', false);
    if (status === 400 || status === 404 || status === 413)
      return new LlmCallError('bad request', 'bad_request', false);
  }

  if (name === 'APIConnectionError') return new LlmCallError('LLM connection error', 'server', true);
  return new LlmCallError('unknown LLM error', 'unknown', false);
}
```
Then wrap the network call in `call`, replacing `const msg = await client.messages.create(body, options);` with:
```ts
      let msg: Anthropic.Message;
      try {
        msg = await client.messages.create(body, options);
      } catch (err) {
        throw classifyError(err);
      }
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/anthropic.test.ts
```
Expected: PASS (all adapter tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/anthropic.ts packages/gateway/tests/anthropic.test.ts
git commit -m "feat(anthropic): map SDK errors to LlmCallError (duck-typed)"
```

---

### Task 7: Import invariants — no SDK in core/index/node; real client conforms to the interface

Add a source-grep test proving base zones never import the SDK, and extend the compat probe to assert a real `Anthropic` client satisfies `AnthropicClientLike`.

**Files:**
- Create: `packages/gateway/tests/no-sdk-import.test.ts`
- Modify: `packages/gateway/tests/anthropic-sdk-compat.ts`

**Interfaces:**
- Consumes: `AnthropicClientLike` from `src/anthropic.js`.
- Produces: regression guards for the import-zone invariant (spec §3) and client-conformance.

- [ ] **Step 1: Write the failing invariant test**

Create `packages/gateway/tests/no-sdk-import.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Import-zone invariant (spec §3): the SDK lives only behind the ./anthropic subpath.
// Base entries (core/, index.ts, node.ts) must never import @anthropic-ai/sdk, value or type.

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

describe('import zones: @anthropic-ai/sdk stays behind ./anthropic', () => {
  it('is never imported by core/, index.ts, or node.ts', () => {
    const base = tsFiles(SRC).filter((f) => !f.endsWith(join('src', 'anthropic.ts')));
    const offenders = base.filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```
Note: `__dirname` is available because this test runs under vitest's CJS-interop for tests; if the runner reports `__dirname` undefined, replace with `import { fileURLToPath } from 'node:url'; const here = fileURLToPath(new URL('.', import.meta.url));` and use `here` instead of `__dirname`.

- [ ] **Step 2: Run to verify it passes immediately (guard, not red/green)**

Run:
```bash
pnpm --filter @kir-str/llm-gateway exec vitest run tests/no-sdk-import.test.ts
```
Expected: PASS (no base-zone file imports the SDK). To confirm the test has teeth, temporarily add `import type Anthropic from '@anthropic-ai/sdk';` to `src/index.ts`, re-run (expect FAIL listing `index.ts`), then remove it and re-run (expect PASS).

- [ ] **Step 3: Extend the compat probe with client conformance**

Append to `packages/gateway/tests/anthropic-sdk-compat.ts`:
```ts
import type { AnthropicClientLike } from '../src/anthropic.js';

// Fails to compile if a real Anthropic client no longer satisfies the adapter's
// minimal injected-client surface.
export const _clientConforms = (c: Anthropic): AnthropicClientLike => c;
```

- [ ] **Step 4: Typecheck the compat assertion**

Run:
```bash
pnpm --filter @kir-str/llm-gateway typecheck
```
Expected: PASS. If it fails because the real `create` signature is narrower than `AnthropicClientLike`, loosen the interface in `src/anthropic.ts` to match the SDK exactly (keep it minimal), then re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/tests/no-sdk-import.test.ts packages/gateway/tests/anthropic-sdk-compat.ts
git commit -m "test(anthropic): import-zone invariant + real-client conformance"
```

---

### Task 8: Docs and contract doc-comment refresh

Refresh the stale `LlmCaller` doc-comment (comment text only — no signature change), document the adapter in the README, and add a CHANGELOG entry.

**Files:**
- Modify: `packages/gateway/src/core/types.ts` (the `LlmCaller` doc-comment, currently around lines 49–56)
- Modify: `packages/gateway/README.md`
- Modify or Create: `packages/gateway/CHANGELOG.md`

**Interfaces:**
- Consumes: nothing.
- Produces: accurate contract documentation; no runtime/type change.

- [ ] **Step 1: Refresh the `LlmCaller` doc-comment**

In `packages/gateway/src/core/types.ts`, replace the comment block above `call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;` (the text claiming the adapter must enforce its own timeout and that `signal` is future work) with:
```ts
  /**
   * Single, thin call to the provider. The core owns retry and timeout policy:
   * when a per-turn timeout is configured it races the call and aborts via `signal`
   * (see `callWithTimeout` in gateway.ts). The adapter enforces no timeout of its own —
   * a transport backstop is the injected provider client's own timeout. The adapter must
   * pass `signal` through to the provider and report provider failures as `LlmCallError`
   * (timeouts/aborts as `code: 'timeout'`, `retryable: false`; the core does not retry them).
   */
```
Verify with `git diff` that only the comment changed, not the `call(...)` signature.

- [ ] **Step 2: Typecheck to confirm no accidental signature change**

Run:
```bash
pnpm --filter @kir-str/llm-gateway typecheck
```
Expected: PASS.

- [ ] **Step 3: Add the README adapter section**

Append to `packages/gateway/README.md` a section documenting the optional adapter. Include exactly:
```markdown
## Optional Anthropic adapter (`@kir-str/llm-gateway/anthropic`)

The Anthropic `LlmCaller` is shipped as an optional subpath export. `@anthropic-ai/sdk`
is an optional peer dependency — install it alongside the package and inject a client:

```bash
pnpm add @kir-str/llm-gateway @anthropic-ai/sdk
```

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createGateway } from '@kir-str/llm-gateway';
import { createAnthropicLlmCaller } from '@kir-str/llm-gateway/anthropic';

// The core owns retry and timeout policy — disable the SDK's own retries.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
const llm = createAnthropicLlmCaller(client, { defaultMaxTokens: 1024 });

const gateway = createGateway(config, { llm, telemetry });
```

Notes:
- The adapter never constructs a client, reads no environment variables, and owns no
  retry/timeout — configure those on the injected `Anthropic` client.
- Structured output uses forced tool use (`emit_structured_output`); the core validates
  the result and drives correction retries.
- The base entry points (`.`, `./node`) do not import the SDK; only this subpath does,
  and only as a type — the built package has no runtime dependency on `@anthropic-ai/sdk`.
```

- [ ] **Step 4: Add a CHANGELOG entry**

If `packages/gateway/CHANGELOG.md` does not exist, create it; otherwise prepend. Add:
```markdown
## 0.3.0

- Add optional Anthropic `LlmCaller` adapter at the `@kir-str/llm-gateway/anthropic`
  subpath. `@anthropic-ai/sdk` is an optional peer dependency; base entry points remain
  SDK-free. Structured output via forced tool use; SDK errors mapped to `LlmCallError`;
  core-owned retry (`maxRetries: 0`) and timeout (`signal`).
- Refresh the `LlmCaller` timeout-ownership doc-comment (no contract/signature change).
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/core/types.ts packages/gateway/README.md packages/gateway/CHANGELOG.md
git commit -m "docs(anthropic): adapter README, CHANGELOG 0.3.0, refresh LlmCaller doc-comment"
```

---

### Task 9: Full gate and build sanity

Run the complete quality gate across the workspace and confirm the package builds with the new subpath and that the existing example still works.

**Files:**
- None (verification only). Fix any failures in the file that caused them.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green gate.

- [ ] **Step 1: Typecheck all packages**

Run:
```bash
pnpm typecheck
```
Expected: PASS (includes `src/anthropic.ts`, both compat/probe files, and all tests).

- [ ] **Step 2: Lint and format**

Run:
```bash
pnpm lint && pnpm format:check
```
Expected: PASS. If prettier reports formatting, run `pnpm exec prettier --write packages/gateway` and re-check.

- [ ] **Step 3: Run the full test suite**

Run:
```bash
pnpm test
```
Expected: PASS — the previous suite (89 tests) plus the new adapter tests.

- [ ] **Step 4: Build the package and confirm the subpath + no runtime SDK require**

Run:
```bash
pnpm --filter @kir-str/llm-gateway build
```
Expected: PASS; `packages/gateway/dist/anthropic.js` and `dist/anthropic.d.ts` exist.

Then confirm the built adapter carries no runtime SDK dependency:
```bash
grep -R "@anthropic-ai/sdk" packages/gateway/dist/anthropic.js || echo "clean: no runtime SDK reference"
```
Expected: prints `clean: no runtime SDK reference` (the `import type` was erased).

- [ ] **Step 5: Confirm the existing example still builds**

Run:
```bash
pnpm --filter ./examples/minimal build 2>/dev/null || echo "examples/minimal has no build script — skip"
```
Expected: PASS or the skip message. (The adapter is additive; the example does not use it.)

- [ ] **Step 6: Final commit (only if Steps 2/4 changed tracked files)**

```bash
git add -A packages/gateway
git commit -m "chore(anthropic): green gate — typecheck, lint, format, build, tests"
```
If nothing changed, skip the commit.

---

## Appendix A — Fallback if the SDK has no per-request `maxRetries`

Only if Task 1 Step 5 shows `Anthropic.RequestOptions` has no `maxRetries` field:

1. In `src/anthropic.ts`, drop `maxRetries` from `options` (keep only `signal`).
2. In `createAnthropicLlmCaller`, fail fast when the injected client was built with retries enabled:
```ts
      const maybeRetries = (client as { maxRetries?: unknown }).maxRetries;
      if (typeof maybeRetries === 'number' && maybeRetries !== 0) {
        throw new TypeError('Anthropic client must be constructed with maxRetries: 0 (core owns retry policy)');
      }
```
   Put this check at the top of `createAnthropicLlmCaller`, before returning the caller.
3. Replace the Task 2 `options.maxRetries` assertion with a test that a client carrying `maxRetries: 2` makes the factory throw, and a client with `maxRetries: 0` or no field is accepted.
4. Update the README note to state that `new Anthropic({ maxRetries: 0 })` is required (not merely recommended).

---

## Self-Review

**Spec coverage:**
- §2 packaging (exports, optional peer, devDep) → Task 1. §3 import zone + no runtime SDK → Task 1 (type-only), Task 7 (invariant test), Task 9 Step 4 (dist grep). §4 public API → Task 2. §5 request mapping (model/max_tokens/messages/system/temperature) → Tasks 2–4. §6 forced tool use → Task 5. §7 response/usage/text/structured → Task 2 (+Task 5 extraction). §8 retry (`maxRetries:0`) / abort (`signal`) + doc-comment cleanup → Task 2, Task 8; §8 compile gate → Task 1 probe. §9 error table → Task 6. §10 test plan → Tasks 2–7. §11 known limitation → documentation only (no code). §12 versioning/README/CHANGELOG → Task 1 (version), Task 8. §13 open questions (SDK version, `RequestOptions.maxRetries`, symbol names) → Task 1 + Appendix A.
- Gap check: none. The §11 core limitation is intentionally not implemented (out of Spec B scope).

**Placeholder scan:** No "TBD"/"implement later"/"add error handling". The only conditional path (`maxRetries` availability) is resolved deterministically in Task 1 Step 5 with a concrete branch to Appendix A. The `?? 0` in Task 2 Step 4 is explicitly a temporary stand-in replaced by a real guard in Task 3.

**Type consistency:** `AnthropicClientLike`, `AnthropicCallerOptions`, `createAnthropicLlmCaller`, `STRUCTURED_TOOL_NAME` (`emit_structured_output`), `makeMessage`, `createFakeAnthropic`, `classifyError`, `mapResponse` are named identically across the tasks that define and consume them. Response fields (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) match `LlmResponse` in `src/core/types.ts`. Error codes match `LlmErrorCode`.
