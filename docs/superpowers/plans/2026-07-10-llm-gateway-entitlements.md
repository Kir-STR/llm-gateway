# Entitlements (`@kir-str/entitlements`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, runtime-agnostic library `@kir-str/entitlements` that gives project code a single auditable server-bound scope chokepoint for data/tool access.

**Architecture:** One primitive — `bindScope(scope, policy)` returns an `Entitlements` object whose `access(resource, operation, thunk)` runs the thunk only after a project-defined `canAccess` predicate allows it. `scope` is captured in the closure and is never an `access` argument, so model-controlled values structurally cannot override it. The package owns the chokepoint mechanics (deny-by-default, fail-closed, audit); the authorization model (`S`/`R`/`O` types, the predicate) is project-defined.

**Tech Stack:** TypeScript strict (NodeNext, ES2022, ESM), vitest, pnpm workspace. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-llm-gateway-entitlements.md`.

## Global Constraints

Every task's requirements implicitly include these (verbatim from spec):

- Package `@kir-str/entitlements`, version `0.1.0`. **Standalone: MUST NOT import `@kir-str/llm-gateway`.**
- **Runtime-agnostic: MUST NOT import any `node:*` builtin inside `src/**`.**
- **Zero runtime dependencies.**
- TypeScript via `tsconfig.base.json`: `strict`, `module: NodeNext`, `target: ES2022`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. ESM with `.js` import specifiers; type-only imports use `import type`.
- `S`/`R`/`O` are **project-defined generics**; the package owns mechanics only. **No RBAC/ABAC, no claims/capabilities matcher, no tenant/section in the public API.**
- **Deny-by-default; fail-closed** (a throwing `canAccess` denies). `scope` is **never** an `access` argument.
- Raw `scope` **never** appears in audit or in `EntitlementsDenied` — only `scopeLabel`. `EntitlementsDenied` carries **no `resource`**; message is exactly `Access denied`. `cause` is **not** sanitized by the package.
- **Audit is best-effort:** a sink failure never changes the allow/deny decision.
- Node `>=22`.
- Work on a feature branch `feat/entitlements` (isolated worktree if using subagent-driven-development). Commit after every task.

---

### Task 1: Package scaffold + contract types + `EntitlementsDenied`

**Files:**
- Create: `packages/entitlements/package.json`
- Create: `packages/entitlements/tsconfig.json`
- Create: `packages/entitlements/tsconfig.build.json`
- Create: `packages/entitlements/src/types.ts`
- Create: `packages/entitlements/src/errors.ts`
- Create: `packages/entitlements/src/index.ts`
- Test: `packages/entitlements/tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `EntitlementsPolicy<S, R = unknown, O = string>` with `canAccess(scope: S, resource: R, operation: O): boolean | Promise<boolean>`, optional `audit?: AuditSink<R, O>`, optional `scopeLabel?: (scope: S) => string`.
  - `Entitlements<R = unknown, O = string>` with `access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T>`.
  - `AuditSink<R = unknown, O = string>` with `record(entry: AuditEntry<R, O>): void | Promise<void>`.
  - `AuditEntry<R = unknown, O = string>` = `{ decision: 'allow' | 'deny'; operation: O; resource: R; scopeLabel?: string; reason?: 'policy_denied' | 'policy_error' }`.
  - `class EntitlementsDenied extends Error` with `readonly reason: 'policy_denied' | 'policy_error'`, `readonly operation: unknown`, constructor `(reason, operation, options?: { cause?: unknown })`, message `Access denied`, `name === 'EntitlementsDenied'`, no `resource` field.

- [ ] **Step 1: Create the package manifest**

Create `packages/entitlements/package.json`:

```json
{
  "name": "@kir-str/entitlements",
  "version": "0.1.0",
  "description": "Server-bound scope chokepoint for project-owned data/tool access",
  "license": "MIT",
  "type": "module",
  "files": ["dist"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Create the tsconfig files**

Create `packages/entitlements/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

Create `packages/entitlements/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Link the new package into the workspace**

Run: `pnpm install`
Expected: pnpm resolves the new `packages/entitlements` workspace package (it matches the existing `packages/*` glob); no errors.

- [ ] **Step 4: Write the contract types**

Create `packages/entitlements/src/types.ts`:

```ts
export interface EntitlementsPolicy<S, R = unknown, O = string> {
  /** Project-defined predicate. May be sync or async. */
  canAccess(scope: S, resource: R, operation: O): boolean | Promise<boolean>;
  /** Optional project-owned audit sink. */
  audit?: AuditSink<R, O>;
  /** Safe label of the scope for audit. The raw scope is never audited — only this label. */
  scopeLabel?: (scope: S) => string;
}

export interface Entitlements<R = unknown, O = string> {
  access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T>;
}

export interface AuditSink<R = unknown, O = string> {
  record(entry: AuditEntry<R, O>): void | Promise<void>;
}

export interface AuditEntry<R = unknown, O = string> {
  decision: 'allow' | 'deny';
  operation: O;
  /** Project-defined; masking is the sink's responsibility. */
  resource: R;
  /** From policy.scopeLabel; absent when scopeLabel is not configured. */
  scopeLabel?: string;
  /** Only present when decision === 'deny'. */
  reason?: 'policy_denied' | 'policy_error';
}
```

- [ ] **Step 5: Write the failing test for `EntitlementsDenied`**

Create `packages/entitlements/tests/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EntitlementsDenied } from '../src/errors.js';

describe('EntitlementsDenied', () => {
  it('constructs with reason + operation, generic message, no resource field', () => {
    const err = new EntitlementsDenied('policy_denied', 'read');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EntitlementsDenied');
    expect(err.message).toBe('Access denied');
    expect(err.reason).toBe('policy_denied');
    expect(err.operation).toBe('read');
    expect('resource' in err).toBe(false);
  });

  it('preserves cause on policy_error', () => {
    const cause = new Error('boom');
    const err = new EntitlementsDenied('policy_error', 'write', { cause });
    expect(err.reason).toBe('policy_error');
    expect(err.cause).toBe(cause);
  });

  it('has undefined cause when none is provided', () => {
    const err = new EntitlementsDenied('policy_denied', 'read');
    expect(err.cause).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @kir-str/entitlements test`
Expected: FAIL — `src/errors.ts` does not exist / `EntitlementsDenied` is not defined.

- [ ] **Step 7: Implement `EntitlementsDenied`**

Create `packages/entitlements/src/errors.ts`:

```ts
export class EntitlementsDenied extends Error {
  readonly reason: 'policy_denied' | 'policy_error';
  readonly operation: unknown;

  constructor(
    reason: 'policy_denied' | 'policy_error',
    operation: unknown,
    options?: { cause?: unknown },
  ) {
    super('Access denied', options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'EntitlementsDenied';
    this.reason = reason;
    this.operation = operation;
  }
}
```

- [ ] **Step 8: Write the public barrel**

Create `packages/entitlements/src/index.ts`:

```ts
export { EntitlementsDenied } from './errors.js';
export type { EntitlementsPolicy, Entitlements, AuditSink, AuditEntry } from './types.js';
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @kir-str/entitlements test`
Expected: PASS (3 tests).

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @kir-str/entitlements typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/entitlements/package.json packages/entitlements/tsconfig.json packages/entitlements/tsconfig.build.json packages/entitlements/src/types.ts packages/entitlements/src/errors.ts packages/entitlements/src/index.ts packages/entitlements/tests/errors.test.ts pnpm-lock.yaml
git commit -m "feat(entitlements): scaffold package + contract types + EntitlementsDenied"
```

---

### Task 2: `bindScope` + `access` (allow / deny-by-default)

**Files:**
- Create: `packages/entitlements/src/entitlements.ts`
- Modify: `packages/entitlements/src/index.ts` (add the `bindScope` export)
- Test: `packages/entitlements/tests/access.test.ts`

**Interfaces:**
- Consumes: `EntitlementsPolicy`, `Entitlements` (Task 1); `EntitlementsDenied` (Task 1).
- Produces: `bindScope<S, R = unknown, O = string>(scope: S, policy: EntitlementsPolicy<S, R, O>): Entitlements<R, O>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/entitlements/tests/access.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';

describe('bindScope / access', () => {
  it('runs the thunk and returns its value when policy allows (async canAccess)', async () => {
    const ent = bindScope({ tenant: 't1' }, { canAccess: async () => true });
    const thunk = vi.fn(async () => 'DATA');
    const out = await ent.access({ id: 1 }, 'read', thunk);
    expect(out).toBe('DATA');
    expect(thunk).toHaveBeenCalledOnce();
  });

  it('denies by default: throws EntitlementsDenied(policy_denied) and never calls the thunk', async () => {
    const ent = bindScope({ tenant: 't1' }, { canAccess: () => false });
    const thunk = vi.fn(async () => 'DATA');
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toMatchObject({ reason: 'policy_denied' });
    expect(thunk).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kir-str/entitlements test tests/access.test.ts`
Expected: FAIL — `bindScope` is not exported.

- [ ] **Step 3: Implement `bindScope` (minimal: allow + deny)**

Create `packages/entitlements/src/entitlements.ts`:

```ts
import { EntitlementsDenied } from './errors.js';
import type { Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      const allowed = await policy.canAccess(scope, resource, operation);
      if (!allowed) {
        throw new EntitlementsDenied('policy_denied', operation);
      }
      return await thunk();
    },
  };
}
```

- [ ] **Step 4: Add the `bindScope` export to the barrel**

Modify `packages/entitlements/src/index.ts` — prepend the value export so the file reads:

```ts
export { bindScope } from './entitlements.js';
export { EntitlementsDenied } from './errors.js';
export type { EntitlementsPolicy, Entitlements, AuditSink, AuditEntry } from './types.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @kir-str/entitlements test`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @kir-str/entitlements typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/entitlements/src/entitlements.ts packages/entitlements/src/index.ts packages/entitlements/tests/access.test.ts
git commit -m "feat(entitlements): bindScope + access with deny-by-default"
```

---

### Task 3: Fail-closed (`canAccess` throws) + thunk-error passthrough

**Files:**
- Modify: `packages/entitlements/src/entitlements.ts` (wrap `canAccess` in try/catch)
- Test: `packages/entitlements/tests/fail-closed.test.ts`

**Interfaces:**
- Consumes: `bindScope` (Task 2).
- Produces: no new symbols — refines `access` behavior. After this task: a throwing `canAccess` yields `EntitlementsDenied` with `reason: 'policy_error'` and the original error as `cause`; a throwing `thunk` propagates unchanged.

- [ ] **Step 1: Write the failing tests**

Create `packages/entitlements/tests/fail-closed.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';

describe('fail-closed', () => {
  it('canAccess throwing -> EntitlementsDenied(policy_error) with cause; thunk not called', async () => {
    const boom = new Error('policy blew up');
    const ent = bindScope(
      {},
      {
        canAccess: () => {
          throw boom;
        },
      },
    );
    const thunk = vi.fn(async () => 'DATA');
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toMatchObject({
      reason: 'policy_error',
      cause: boom,
    });
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    expect(thunk).not.toHaveBeenCalled();
  });

  it('proxies a thunk error unchanged (not wrapped as EntitlementsDenied)', async () => {
    const boom = new Error('db down');
    const ent = bindScope({}, { canAccess: () => true });
    await expect(
      ent.access({ id: 1 }, 'read', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Run the fail-closed test to verify it fails**

Run: `pnpm --filter @kir-str/entitlements test tests/fail-closed.test.ts`
Expected: FAIL — the first test fails because the minimal `access` lets the raw `boom` propagate (it is not an `EntitlementsDenied`, has no `reason`). (The second test — thunk passthrough — already passes with the Task 2 code; it guards Step 3 against wrapping the thunk in the new try/catch.)

- [ ] **Step 3: Implement fail-closed in `access`**

Replace the body of `access` in `packages/entitlements/src/entitlements.ts` so the function reads:

```ts
import { EntitlementsDenied } from './errors.js';
import type { Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      let allowed: boolean;
      try {
        allowed = await policy.canAccess(scope, resource, operation);
      } catch (cause) {
        throw new EntitlementsDenied('policy_error', operation, { cause });
      }
      if (!allowed) {
        throw new EntitlementsDenied('policy_denied', operation);
      }
      return await thunk();
    },
  };
}
```

Note: only the `canAccess` call is inside the try/catch — the `thunk()` call is not, so thunk errors propagate unchanged (guarded by the second test).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kir-str/entitlements test`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add packages/entitlements/src/entitlements.ts packages/entitlements/tests/fail-closed.test.ts
git commit -m "feat(entitlements): fail-closed on canAccess error; thunk errors pass through"
```

---

### Task 4: Audit (records, ordering, best-effort, scopeLabel, hygiene)

**Files:**
- Modify: `packages/entitlements/src/entitlements.ts` (emit audit entries)
- Test: `packages/entitlements/tests/audit.test.ts`

**Interfaces:**
- Consumes: `bindScope` (Task 3); `AuditEntry`, `AuditSink` (Task 1).
- Produces: no new symbols — `access` now emits an `AuditEntry` per decision. Allow is recorded **before** the thunk. Raw `scope` never appears in an entry (only `scopeLabel`). A throwing sink is swallowed and does not change the decision.

- [ ] **Step 1: Write the failing tests**

Create `packages/entitlements/tests/audit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { bindScope, EntitlementsDenied } from '../src/index.js';
import type { AuditEntry } from '../src/index.js';

const SECRET = 'SCOPE-SECRET-xyz789';

function recorder<R, O>() {
  const entries: AuditEntry<R, O>[] = [];
  return { entries, record: (e: AuditEntry<R, O>) => void entries.push(e) };
}

describe('audit', () => {
  it('records an allow decision with scopeLabel and never the raw scope', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      { tenant: 't1', token: SECRET },
      { canAccess: () => true, scopeLabel: (s) => s.tenant, audit },
    );
    await ent.access({ id: 1 }, 'read', async () => 'DATA');
    expect(audit.entries).toEqual([
      { decision: 'allow', operation: 'read', resource: { id: 1 }, scopeLabel: 't1' },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(SECRET);
  });

  it('records a deny decision with reason and no raw scope', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      { tenant: 't1', token: SECRET },
      { canAccess: () => false, scopeLabel: (s) => s.tenant, audit },
    );
    await expect(ent.access({ id: 2 }, 'write', async () => 'x')).rejects.toBeInstanceOf(
      EntitlementsDenied,
    );
    expect(audit.entries).toEqual([
      {
        decision: 'deny',
        operation: 'write',
        resource: { id: 2 },
        scopeLabel: 't1',
        reason: 'policy_denied',
      },
    ]);
    expect(JSON.stringify(audit.entries)).not.toContain(SECRET);
  });

  it('records a policy_error deny when canAccess throws', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope(
      {},
      {
        canAccess: () => {
          throw new Error('boom');
        },
        audit,
      },
    );
    await expect(ent.access({ id: 3 }, 'read', async () => 'x')).rejects.toBeInstanceOf(
      EntitlementsDenied,
    );
    expect(audit.entries).toEqual([
      { decision: 'deny', operation: 'read', resource: { id: 3 }, reason: 'policy_error' },
    ]);
  });

  it('records the allow decision before running the thunk', async () => {
    const order: string[] = [];
    const ent = bindScope(
      {},
      {
        canAccess: () => true,
        audit: { record: () => void order.push('audit') },
      },
    );
    await ent.access({ id: 1 }, 'read', async () => void order.push('thunk'));
    expect(order).toEqual(['audit', 'thunk']);
  });

  it('best-effort: a sink error does not change an allowed access', async () => {
    const ent = bindScope(
      {},
      {
        canAccess: () => true,
        audit: {
          record: () => {
            throw new Error('sink down');
          },
        },
      },
    );
    const out = await ent.access({ id: 1 }, 'read', async () => 'DATA');
    expect(out).toBe('DATA');
  });

  it('best-effort: a sink error does not turn a deny into an allow', async () => {
    const thunk = vi.fn(async () => 'DATA');
    const ent = bindScope(
      {},
      {
        canAccess: () => false,
        audit: {
          record: () => {
            throw new Error('sink down');
          },
        },
      },
    );
    await expect(ent.access({ id: 1 }, 'read', thunk)).rejects.toBeInstanceOf(EntitlementsDenied);
    expect(thunk).not.toHaveBeenCalled();
  });

  it('omits scopeLabel from the entry when no scopeLabel is configured', async () => {
    const audit = recorder<{ id: number }, string>();
    const ent = bindScope({}, { canAccess: () => true, audit });
    await ent.access({ id: 1 }, 'read', async () => 'x');
    expect('scopeLabel' in audit.entries[0]!).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kir-str/entitlements test tests/audit.test.ts`
Expected: FAIL — the current `access` never calls `policy.audit.record`, so the entry-recording assertions fail. (The two best-effort tests pass trivially since audit is currently ignored; they lock the decision behavior once audit is wired in.)

- [ ] **Step 3: Implement audit emission**

Replace `packages/entitlements/src/entitlements.ts` with the final version:

```ts
import { EntitlementsDenied } from './errors.js';
import type { AuditEntry, Entitlements, EntitlementsPolicy } from './types.js';

export function bindScope<S, R = unknown, O = string>(
  scope: S,
  policy: EntitlementsPolicy<S, R, O>,
): Entitlements<R, O> {
  const scopeLabel = policy.scopeLabel ? policy.scopeLabel(scope) : undefined;

  async function emit(
    decision: 'allow' | 'deny',
    resource: R,
    operation: O,
    reason?: 'policy_denied' | 'policy_error',
  ): Promise<void> {
    const sink = policy.audit;
    if (!sink) return;
    const entry: AuditEntry<R, O> = { decision, operation, resource };
    if (scopeLabel !== undefined) entry.scopeLabel = scopeLabel;
    if (reason !== undefined) entry.reason = reason;
    try {
      await sink.record(entry);
    } catch {
      // best-effort: an audit failure never changes the allow/deny decision (spec §6)
    }
  }

  return {
    async access<T>(resource: R, operation: O, thunk: () => Promise<T> | T): Promise<T> {
      let allowed: boolean;
      try {
        allowed = await policy.canAccess(scope, resource, operation);
      } catch (cause) {
        await emit('deny', resource, operation, 'policy_error');
        throw new EntitlementsDenied('policy_error', operation, { cause });
      }
      if (!allowed) {
        await emit('deny', resource, operation, 'policy_denied');
        throw new EntitlementsDenied('policy_denied', operation);
      }
      await emit('allow', resource, operation);
      return await thunk();
    },
  };
}
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `pnpm --filter @kir-str/entitlements test`
Expected: PASS (errors + access + fail-closed + audit).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @kir-str/entitlements typecheck`
Expected: no errors (note `exactOptionalPropertyTypes` — `scopeLabel`/`reason` are only assigned when defined).

- [ ] **Step 6: Commit**

```bash
git add packages/entitlements/src/entitlements.ts packages/entitlements/tests/audit.test.ts
git commit -m "feat(entitlements): best-effort audit with scope-label hygiene"
```

---

### Task 5: Runtime-agnostic zone invariant test (no `node:*` in `src`)

**Files:**
- Test: `packages/entitlements/tests/no-node-import.test.ts`

**Interfaces:**
- Consumes: nothing new — a guard test over the `src` tree.
- Produces: a regression guard enforcing the "no `node:*` in `src/**`" invariant (spec §10). Mirrors `packages/gateway/tests/no-sdk-import.test.ts`.

- [ ] **Step 1: Write the guard test**

Create `packages/entitlements/tests/no-node-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Runtime-agnostic zone invariant (spec §10): src/** must never import a node: builtin.
// (Tests may use node:* — they are not part of the shipped runtime zone.)
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

describe('runtime-agnostic zone: no node:* in src', () => {
  it('no src file imports a node: builtin', () => {
    const offenders = tsFiles(SRC).filter((f) => /from\s+['"]node:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter @kir-str/entitlements test tests/no-node-import.test.ts`
Expected: PASS — no `src` file imports `node:*`. (This is a guard test: green on arrival, red only if a future change introduces a `node:*` import into `src`.)

- [ ] **Step 3: Commit**

```bash
git add packages/entitlements/tests/no-node-import.test.ts
git commit -m "test(entitlements): guard runtime-agnostic zone (no node:* in src)"
```

---

### Task 6: Package README + `examples/entitlements-basic` consumer

**Files:**
- Create: `packages/entitlements/README.md`
- Create: `examples/entitlements-basic/package.json`
- Create: `examples/entitlements-basic/tsconfig.json`
- Create: `examples/entitlements-basic/run.ts`

**Interfaces:**
- Consumes: the public API from `@kir-str/entitlements` (`bindScope`, `EntitlementsDenied`, `AuditEntry`).
- Produces: a runnable smoke/example (`example-entitlements-basic`) and package documentation. The example does **not** import `@kir-str/llm-gateway` — it keeps the dependency direction clean while documenting where `scope` comes from (trusted server context / `TurnContext.meta`).

- [ ] **Step 1: Write the package README**

Create `packages/entitlements/README.md`:

```markdown
# @kir-str/entitlements

Server-bound scope chokepoint for project-owned data/tool access. Runtime-agnostic, zero dependencies, standalone (does not depend on `@kir-str/llm-gateway`).

## Why

The model must never choose which data scope it can reach. `bindScope` captures a trusted, server-derived scope in a closure; the scope is **not** an argument of `access`, so model-controlled values (`input`, `output`, `structured`, tool arguments) structurally cannot override it.

## Usage

```ts
import { bindScope, EntitlementsDenied } from '@kir-str/entitlements';

type Scope = { tenantId: string; allowedDocs: readonly string[] };
type Resource = { kind: 'doc'; id: string };

// On the server boundary of a turn, resolve scope from a TRUSTED source
// (session / auth middleware / TurnContext.meta) — never from the model.
const ent = bindScope<Scope, Resource, string>(scope, {
  canAccess: (s, r) => r.kind === 'doc' && s.allowedDocs.includes(r.id),
  scopeLabel: (s) => s.tenantId, // safe label for audit; the raw scope is never audited
  audit: mySink,
});

const doc = await ent.access({ kind: 'doc', id: 'doc-1' }, 'read', () => getDoc('doc-1'));
```

`access` runs the thunk only after `canAccess` allows. Denied access throws `EntitlementsDenied` (deny-by-default; a throwing `canAccess` also denies, fail-closed).

## Security & hygiene

- The raw `scope` never appears in audit entries — only `scopeLabel`. `EntitlementsDenied` carries no `resource` and its message is a fixed `Access denied`.
- `resource` is project-defined; **masking `resource` in audit is the responsibility of your `AuditSink`** — the package does not guess what is sensitive.
- `EntitlementsDenied.cause` (from a throwing `canAccess`) is **not** sanitized by the package; the package only guarantees it never adds `scope`/`resource` itself.
- Audit is best-effort: a sink failure never changes the allow/deny decision.

## v1 scope

One primitive (`bindScope`), project-defined `Scope`/`Resource`/`Operation` and predicate. **Not** an authorization framework: no RBAC/ABAC, no claims/capabilities matcher, no tenant/section concepts in the API. See `docs/superpowers/specs/2026-07-10-llm-gateway-entitlements.md`.
```

- [ ] **Step 2: Write the example manifest and tsconfig**

Create `examples/entitlements-basic/package.json`:

```json
{
  "name": "example-entitlements-basic",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types run.ts"
  },
  "dependencies": {
    "@kir-str/entitlements": "workspace:*"
  }
}
```

Create `examples/entitlements-basic/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["run.ts"]
}
```

- [ ] **Step 3: Write the runnable example**

Create `examples/entitlements-basic/run.ts`:

```ts
import { bindScope, EntitlementsDenied } from '@kir-str/entitlements';
import type { AuditEntry } from '@kir-str/entitlements';

// Trusted server context. In a real app this comes from the session / auth
// middleware / TurnContext.meta — NEVER from the model's input or output.
type Scope = { tenantId: string; allowedDocs: readonly string[] };
type Resource = { kind: 'doc'; id: string };

// A fake project-owned data source. The chokepoint wraps every call to it.
async function fakeGetDoc(id: string): Promise<string> {
  return `<<contents of ${id}>>`;
}

const audit = {
  record(e: AuditEntry<Resource, string>) {
    const reason = e.reason ? ` (${e.reason})` : '';
    console.log(`[audit] ${e.decision} ${e.operation} ${e.resource.id} tenant=${e.scopeLabel ?? '-'}${reason}`);
  },
};

function guardedFor(scope: Scope) {
  return bindScope<Scope, Resource, string>(scope, {
    canAccess: (s, resource) => resource.kind === 'doc' && s.allowedDocs.includes(resource.id),
    scopeLabel: (s) => s.tenantId,
    audit,
  });
}

const scope: Scope = { tenantId: 't-42', allowedDocs: ['doc-1'] };
const ent = guardedFor(scope);

// Allowed: doc-1 is in the server-bound scope.
const doc = await ent.access({ kind: 'doc', id: 'doc-1' }, 'read', () => fakeGetDoc('doc-1'));
console.log('got:', doc);

// Denied: doc-2 is not in scope. Even if the model asked for it, the scope
// came from the server closure and cannot be overridden.
try {
  await ent.access({ kind: 'doc', id: 'doc-2' }, 'read', () => fakeGetDoc('doc-2'));
} catch (err) {
  if (err instanceof EntitlementsDenied) {
    console.log('denied as expected:', err.reason);
  } else {
    throw err;
  }
}
```

- [ ] **Step 4: Link and run the example end-to-end**

Run: `pnpm install`
Then run: `pnpm --filter example-entitlements-basic start`
Expected output (order):

```
[audit] allow read doc-1 tenant=t-42
got: <<contents of doc-1>>
[audit] deny read doc-2 tenant=t-42 (policy_denied)
denied as expected: policy_denied
```

- [ ] **Step 5: Typecheck the example**

Run: `pnpm --filter example-entitlements-basic exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/entitlements/README.md examples/entitlements-basic/package.json examples/entitlements-basic/tsconfig.json examples/entitlements-basic/run.ts pnpm-lock.yaml
git commit -m "docs(entitlements): package README + runnable examples/entitlements-basic"
```

---

### Task 7: Green gate (typecheck / lint / format / build / test across the workspace)

**Files:**
- Modify: any files needing formatting/lint fixes surfaced by the gate (no functional changes).

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: a fully green workspace gate, matching the project's per-subproject "green gate" convention.

- [ ] **Step 1: Format**

Run: `pnpm exec prettier --write "packages/entitlements/**/*.{ts,json,md}" "examples/entitlements-basic/**/*.{ts,json}"`
Then run: `pnpm format:check`
Expected: prettier reports all files formatted.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no eslint errors. (If `no-unused-vars` fires on an unused generic or import, remove the unused symbol — do not disable the rule.)

- [ ] **Step 3: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: no errors in any package.

- [ ] **Step 4: Build**

Run: `pnpm --filter @kir-str/entitlements build`
Expected: `packages/entitlements/dist/` contains `index.js` + `index.d.ts` (and `entitlements`, `errors`, `types` outputs). No `node:*` and no `@kir-str/llm-gateway` references in `dist`.

- [ ] **Step 5: Full test run**

Run: `pnpm test`
Expected: all packages green, including the new `@kir-str/entitlements` suite.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(entitlements): green gate — format, lint, typecheck, build, tests"
```

---

## Self-Review

**1. Spec coverage:**

- §1 goal / server-bound chokepoint → Tasks 2–4 (`bindScope`/`access`). ✓
- §2 anti-goals (no RBAC/ABAC, no gateway dep, no `node:*`, no `guardAccess`, no `auditFailureMode`, no `redactResource`) → Global Constraints + Task 5 guard; nothing in the plan introduces them. ✓
- §3 public API (`bindScope`, `Entitlements`, `EntitlementsPolicy`, `AuditSink`, `AuditEntry`, `EntitlementsDenied` signature) → Task 1 (types + error) + Task 2 (`bindScope`). ✓
- §4 lifecycle (allow before thunk; deny paths; thunk passthrough) → Tasks 2–4. ✓
- §5 error handling (`EntitlementsDenied` shape, generic message, no resource, cause not sanitized) → Task 1 test + README (Task 6). ✓
- §6 secret hygiene (raw scope never audited; scopeLabel; best-effort audit) → Task 4 tests. ✓
- §7 packaging (name/version/exports/zero-deps/tsconfig) → Task 1. ✓
- §8 tests (deny-by-default, allow, async canAccess, canAccess-throw, thunk-throw, audit hygiene, best-effort, ordering, import-zone) → Tasks 2–5. ✓
- §9 example consumer → Task 6. ✓
- §10 invariants → Global Constraints + Task 5. ✓
- §11 out-of-scope → nothing in the plan builds these. ✓

**2. Placeholder scan:** No TBD/TODO; every code and test step contains complete code; every command has an expected result. ✓

**3. Type consistency:** `bindScope<S, R = unknown, O = string>`, `access<T>(resource, operation, thunk)`, `EntitlementsPolicy.canAccess(scope, resource, operation)`, `AuditEntry` field names (`decision`/`operation`/`resource`/`scopeLabel`/`reason`), and `EntitlementsDenied(reason, operation, { cause })` are used identically across Tasks 1–6. The final `entitlements.ts` in Task 4 matches the signatures declared in Task 1's Interfaces block. ✓
