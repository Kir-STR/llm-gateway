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
