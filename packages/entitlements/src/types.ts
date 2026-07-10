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
