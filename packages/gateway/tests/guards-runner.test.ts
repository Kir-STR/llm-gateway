import { describe, it, expect } from 'vitest';
import { runGuards } from '../src/core/guards-runner.js';
import type { Guard, TurnContext } from '../src/core/types.js';

const ctx: TurnContext = { traceId: 't', input: { raw: 'x', text: 'x' }, meta: {} };
const pass: Guard = { name: 'ok', phase: 'input', deterministic: true, run: () => ({ outcome: 'PASS' }) };
const slow: Guard = { name: 'slow', phase: 'input', deterministic: true, timeoutMs: 10,
  run: () => new Promise((r) => setTimeout(() => r({ outcome: 'PASS' }), 100)) };
const boom: Guard = { name: 'boom', phase: 'input', deterministic: true, run: () => { throw new Error('x'); } };

describe('runGuards', () => {
  it('collects verdicts and marks fast guards clean', async () => {
    const [r] = await runGuards([{ guard: pass, onError: 'reject', rejectTemplate: 't' }], ctx);
    expect(r).toMatchObject({ name: 'ok', verdict: { outcome: 'PASS' }, timedOut: false, errored: false });
  });
  it('applies on_error=reject to a timed-out guard', async () => {
    const [r] = await runGuards([{ guard: slow, onError: 'reject', rejectTemplate: 't' }], ctx);
    expect(r!.verdict).toEqual({ outcome: 'REJECT', code: 'E_GUARD_ERROR' });
    expect(r!.timedOut).toBe(true);
  });
  it('applies on_error=degrade to a throwing guard', async () => {
    const [r] = await runGuards([{ guard: boom, onError: 'degrade', rejectTemplate: 't' }], ctx);
    expect(r!.verdict).toEqual({ outcome: 'DEGRADE', code: 'E_GUARD_ERROR' });
    expect(r!.errored).toBe(true);
  });
});
