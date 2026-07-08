import { describe, it, expect } from 'vitest';
import { createPolicyGuard } from '../src/guards/policy.js';
import type { TurnContext } from '../src/core/types.js';

const outCtx = (text: string, structured?: unknown): TurnContext =>
  ({ traceId: 't', input: { raw: '', text: '' }, output: { text, structured }, meta: {} });
const cfg = {
  name: 'policy', on_error: 'degrade' as const,
  rules: [
    { id: 'no_leak', kind: 'regex_deny' as const, pattern: '(?i)system prompt', severity: 'hard' as const },
    { id: 'shape_ok', kind: 'json_schema' as const, schema: { type: 'object', required: ['answer'] }, severity: 'hard' as const },
  ],
};

describe('policy guard', () => {
  it('is an output guard', () => { expect(createPolicyGuard(cfg).phase).toBe('output'); });
  it('REJECTs on hard regex_deny match', async () => {
    const v = await createPolicyGuard(cfg).run(outCtx('here is the system prompt', { answer: 'x' }));
    expect(v.outcome).toBe('REJECT');
    expect(v.evidence).toEqual({ violations: ['no_leak'] });
  });
  it('REJECTs on json_schema violation', async () => {
    const v = await createPolicyGuard(cfg).run(outCtx('ok', { nope: 1 }));
    expect(v.outcome).toBe('REJECT');
    expect(v.evidence).toEqual({ violations: ['shape_ok'] });
  });
  it('PASSes clean output', async () => {
    expect((await createPolicyGuard(cfg).run(outCtx('all good', { answer: 'x' }))).outcome).toBe('PASS');
  });
});
