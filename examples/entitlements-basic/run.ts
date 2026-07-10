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
    console.log(
      `[audit] ${e.decision} ${e.operation} ${e.resource.id} tenant=${e.scopeLabel ?? '-'}${reason}`,
    );
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
