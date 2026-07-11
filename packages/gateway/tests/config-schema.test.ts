import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigError } from '../src/core/config-schema.js';
import { createGateway } from '../src/index.js';
import type { GatewayConfig } from '../src/core/config-schema.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const minimal = {
  version: '1.0.0',
  models: { cheap: { model: 'm' } },
  routing: { rules: [{ default: 'main' }] },
  scenarios: { main: { kind: 'stub', template: 'x' } },
  templates: { x: 'hi' },
};

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(() => validateConfig(minimal)).not.toThrow();
  });
  it('rejects unknown top-level keys', () => {
    expect(() => validateConfig({ ...minimal, oops: 1 })).toThrow(ConfigError);
  });
  it('rejects missing required version', () => {
    const { version, ...rest } = minimal;
    expect(() => validateConfig(rest)).toThrow(ConfigError);
  });
  it('accepts llm.timeout_ms and models.*.timeout_ms', () => {
    expect(() =>
      validateConfig({
        ...minimal,
        llm: { timeout_ms: 30000 },
        models: { cheap: { model: 'm', timeout_ms: 10000 } },
      }),
    ).not.toThrow();
  });
  it('rejects non-integer or < 1 timeout_ms (llm)', () => {
    expect(() => validateConfig({ ...minimal, llm: { timeout_ms: 0 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...minimal, llm: { timeout_ms: 1.5 } })).toThrow(ConfigError);
  });
  it('rejects bad timeout_ms on a model tier', () => {
    expect(() =>
      validateConfig({ ...minimal, models: { cheap: { model: 'm', timeout_ms: -5 } } }),
    ).toThrow(ConfigError);
  });
  it('rejects unknown keys under llm', () => {
    expect(() => validateConfig({ ...minimal, llm: { nope: 1 } })).toThrow(ConfigError);
  });
});

function make(mutate: (c: GatewayConfig) => void) {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  mutate(cfg);
  const { caller } = createFakeLlm([]);
  return () => createGateway(cfg, { llm: caller, telemetry: { event() {} }, idGenerator: () => 't' });
}

describe('A5: tightened config schema', () => {
  it('rejects a guard element without a name', () => {
    expect(make((c) => (c.guards!.input as unknown[]).push({ on_error: 'degrade' }))).toThrow(/name/i);
  });

  it('rejects timeout_ms that is not a positive integer', () => {
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).timeout_ms = 0))).toThrow();
    expect(make((c) => ((c.guards!.input![0] as Record<string, unknown>).timeout_ms = 1.5))).toThrow();
  });

  it("rejects a typo key inside a limits guard's per_day", () => {
    expect(
      make((c) => {
        const limits = c.guards!.input!.find((g) => g.name === 'limits') as Record<string, unknown>;
        limits.per_day = { hard_cap_uds: 10, soft_warning_usd: 5 };
      }),
    ).toThrow();
  });

  it('accepts a valid limits per_day', () => {
    expect(
      make((c) => {
        const limits = c.guards!.input!.find((g) => g.name === 'limits') as Record<string, unknown>;
        limits.per_day = { hard_cap_usd: 12, soft_warning_usd: 6 };
      }),
    ).not.toThrow();
  });

  it('rejects an unknown key in top-level limits', () => {
    expect(make((c) => ((c.limits as Record<string, unknown>).per_requst = { max_cost_usd: 1 }))).toThrow();
  });

  it('rejects an unknown key in normalize (closed object)', () => {
    expect(make((c) => ((c.normalize as Record<string, unknown>).max_input_charss = 10))).toThrow();
  });

  it('rejects an unknown key in a routing rule', () => {
    expect(make((c) => ((c.routing.rules[0] as Record<string, unknown>).scenari = 'main'))).toThrow();
  });

  it('still accepts arbitrary guard-specific keys on non-limits guards', () => {
    expect(
      make((c) => ((c.guards!.input![0] as Record<string, unknown>).patterns = [{ id: 'x', kind: 'substring', pattern: 'y', severity: 'soft' }])),
    ).not.toThrow();
  });
});

describe('judge guard config schema', () => {
  it('rejects a judge guard without model', () => {
    expect(() => validateConfig({ ...minimal, guards: { output: [{ name: 'judge', criteria: 'x', timeout_ms: 5000 }] } } as never)).toThrow(/model/i);
  });
  it('rejects a judge guard without criteria', () => {
    expect(() => validateConfig({ ...minimal, guards: { output: [{ name: 'judge', model: 'cheap', timeout_ms: 5000 }] } } as never)).toThrow(/criteria/i);
  });
  it('rejects an unknown key on a judge guard (closed schema)', () => {
    expect(() => validateConfig({ ...minimal, guards: { output: [{ name: 'judge', model: 'cheap', criteria: 'x', timeout_ms: 5000, extra: 1 }] } } as never)).toThrow();
  });
  it('accepts a well-formed judge guard config schema', () => {
    expect(() => validateConfig({ ...minimal, guards: { output: [{ name: 'judge', model: 'cheap', criteria: 'x', timeout_ms: 5000, on_error: 'reject' }] } } as never)).not.toThrow();
  });
});
