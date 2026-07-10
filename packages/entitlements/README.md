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
