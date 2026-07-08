import { describe, it, expect } from 'vitest';
import { selectScenario } from '../src/core/router.js';

const routing = {
  rules: [{ when: { flags_any: ['injection'] }, scenario: 'cautious' }, { default: 'main' }],
};

describe('selectScenario', () => {
  it('honors a forced route above rules', () => {
    expect(selectScenario(routing, ['injection'], 'pii_short_circuit')).toEqual({
      scenario: 'pii_short_circuit',
      matchedRule: 'forced',
    });
  });
  it('matches the first flag rule', () => {
    expect(selectScenario(routing, ['injection'])).toEqual({
      scenario: 'cautious',
      matchedRule: 'rule[0]',
    });
  });
  it('falls back to default', () => {
    expect(selectScenario(routing, [])).toEqual({ scenario: 'main', matchedRule: 'default' });
  });
});
