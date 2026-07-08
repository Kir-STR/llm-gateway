import { describe, it, expect } from 'vitest';
import { createLimitsGuard } from '../src/guards/limits.js';
import type { TurnContext, DailyState, LimitsStore } from '../src/core/types.js';

const ctx: TurnContext = { traceId: 't', input: { raw: 'hi', text: 'hi' }, meta: {} };
const fixedNow = () => new Date('2026-07-08T10:00:00Z');
const store = (state: DailyState | null): LimitsStore => ({ load: async () => state, save: async () => {} });
const cfg = { name: 'limits', on_error: 'reject' as const, per_day: { hard_cap_usd: 10, soft_warning_usd: 5 } };

describe('limits guard', () => {
  it('PASSes below caps', async () => {
    const g = createLimitsGuard(cfg, { store: store({ date: '2026-07-08', costUsd: 1, requestCount: 3 }), now: fixedNow });
    expect((await g.run(ctx)).outcome).toBe('PASS');
  });
  it('REJECTs at hard cap with E_COST_CAP', async () => {
    const g = createLimitsGuard(cfg, { store: store({ date: '2026-07-08', costUsd: 10, requestCount: 9 }), now: fixedNow });
    const v = await g.run(ctx);
    expect(v.outcome).toBe('REJECT');
    expect(v.code).toBe('E_COST_CAP');
  });
  it('treats stale-date state as a fresh day (0 cost)', async () => {
    const g = createLimitsGuard(cfg, { store: store({ date: '2026-07-07', costUsd: 999, requestCount: 1 }), now: fixedNow });
    expect((await g.run(ctx)).outcome).toBe('PASS');
  });
  it('fails closed when the store throws', async () => {
    const bad: LimitsStore = { load: async () => { throw new Error('io'); }, save: async () => {} };
    const g = createLimitsGuard(cfg, { store: bad, now: fixedNow });
    expect((await g.run(ctx)).outcome).toBe('REJECT');
  });
});
