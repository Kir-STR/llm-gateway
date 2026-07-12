import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };
function gw(cfg: GatewayConfig, guards?: Guard[]) {
  const { caller } = createFakeLlm([]);
  const deps = { llm: caller, telemetry: nullSink, idGenerator: () => 't' } as const;
  return () => createGateway(cfg, guards ? { ...deps, guards } : deps);
}
function withInputGuard(cfgEntry: Record<string, unknown>): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  cfg.guards!.input!.push(cfgEntry as never);
  return cfg;
}
const passGuard = (over: Partial<Guard>): Guard => ({
  name: 'test',
  phase: 'input',
  deterministic: true,
  run: () => ({ outcome: 'PASS' }),
  ...over,
});

describe('A1: non-deterministic guard requires a positive timeout', () => {
  it('throws when deterministic:false and no timeout', () => {
    const cfg = withInputGuard({ name: 'test' });
    expect(gw(cfg, [passGuard({ deterministic: false })])).toThrow(/deterministic|timeout/i);
  });
  it('throws when deterministic:false and timeoutMs is 0 (injected, bypasses schema)', () => {
    const cfg = withInputGuard({ name: 'test' });
    expect(gw(cfg, [passGuard({ deterministic: false, timeoutMs: 0 })])).toThrow(/timeout/i);
  });
  it('accepts deterministic:false with a positive timeoutMs', () => {
    const cfg = withInputGuard({ name: 'test' });
    expect(gw(cfg, [passGuard({ deterministic: false, timeoutMs: 5000 })])).not.toThrow();
  });
});

describe('A2: config section must match the guard phase', () => {
  it('throws when a built-in input guard (injection) is placed in guards.output', () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'injection' } as never);
    expect(gw(cfg)).toThrow(/phase/i);
  });
});

describe('A3: custom-guard config overlay', () => {
  it('throws when a custom guard config carries a route', () => {
    const cfg = withInputGuard({ name: 'test', route: 'main' });
    expect(gw(cfg, [passGuard({})])).toThrow(/route/i);
  });
  it('applies cfg.timeout_ms to an effective guard WITHOUT mutating the injected guard', () => {
    const injected = passGuard({ deterministic: false });
    const cfg = withInputGuard({ name: 'test', timeout_ms: 1234 });
    expect(gw(cfg, [injected])).not.toThrow(); // effective timeout satisfies A1
    expect(injected.timeoutMs).toBeUndefined(); // injected object left untouched
  });
});
