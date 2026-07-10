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
