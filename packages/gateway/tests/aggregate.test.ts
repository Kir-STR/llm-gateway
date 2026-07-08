import { describe, it, expect } from 'vitest';
import { aggregateInput } from '../src/core/aggregate.js';

describe('aggregateInput', () => {
  it('passes clean, no flags', () => {
    const a = aggregateInput([
      { name: 'injection', verdict: { outcome: 'PASS' }, rejectTemplate: 'x' },
    ]);
    expect(a).toEqual({ decision: 'pass', flags: [] });
  });
  it('first REJECT wins with its code and template', () => {
    const a = aggregateInput([
      {
        name: 'injection',
        verdict: { outcome: 'REJECT', code: 'E_INJECTION_DETECTED' },
        rejectTemplate: 'injection_reject',
      },
      {
        name: 'limits',
        verdict: { outcome: 'REJECT', code: 'E_COST_CAP' },
        rejectTemplate: 'degrade',
      },
    ]);
    expect(a).toEqual({
      decision: 'reject',
      flags: [],
      rejectCode: 'E_INJECTION_DETECTED',
      rejectTemplate: 'injection_reject',
    });
  });
  it('DEGRADE contributes guard-name flags; route and transform surface', () => {
    const a = aggregateInput([
      { name: 'injection', verdict: { outcome: 'DEGRADE' }, rejectTemplate: 'x' },
      {
        name: 'pii',
        verdict: { outcome: 'PASS', route: 'pii_short_circuit', transform: 'masked' },
        rejectTemplate: 'x',
      },
    ]);
    expect(a).toEqual({
      decision: 'pass',
      flags: ['injection'],
      forcedRoute: 'pii_short_circuit',
      transform: 'masked',
    });
  });
  it('maps a guard-error DEGRADE to the guard_error flag, not the guard name', () => {
    const a = aggregateInput([
      {
        name: 'my_custom',
        verdict: { outcome: 'DEGRADE', code: 'E_GUARD_ERROR' },
        rejectTemplate: 'x',
      },
    ]);
    expect(a).toEqual({ decision: 'pass', flags: ['guard_error'] });
  });
});
