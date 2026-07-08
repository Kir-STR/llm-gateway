import { describe, it, expect } from 'vitest';
import { createPiiGuard } from '../src/guards/pii.js';
import type { TurnContext } from '../src/core/types.js';

const ctx = (text: string): TurnContext => ({ traceId: 't', input: { raw: text, text }, meta: {} });
const cfg = {
  name: 'pii',
  on_error: 'reject' as const,
  rules: ['ru_phone', 'email'],
  mask: { ru_phone: '[PHONE_MASKED]', email: '[EMAIL_MASKED]' },
  route: 'pii_short_circuit',
};

describe('pii guard', () => {
  it('declares transforms true and input phase', () => {
    const g = createPiiGuard(cfg);
    expect(g.transforms).toBe(true);
    expect(g.phase).toBe('input');
  });
  it('masks email and phone, PASSes with transform + route, boolean evidence only', async () => {
    const v = await createPiiGuard(cfg).run(ctx('mail a@b.com call +7 999 123-45-67'));
    expect(v.outcome).toBe('PASS');
    expect(v.route).toBe('pii_short_circuit');
    expect(v.transform).toBe('mail [EMAIL_MASKED] call [PHONE_MASKED]');
    expect(v.evidence).toEqual({ email: true, phone: true });
  });
  it('PASSes without transform when no PII present', async () => {
    const v = await createPiiGuard(cfg).run(ctx('nothing to see'));
    expect(v.outcome).toBe('PASS');
    expect(v.transform).toBeUndefined();
    expect(v.evidence).toEqual({ email: false, phone: false });
  });
  it('never leaks raw values into evidence', async () => {
    const v = await createPiiGuard(cfg).run(ctx('a@b.com'));
    expect(JSON.stringify(v.evidence)).not.toContain('a@b.com');
  });
});
