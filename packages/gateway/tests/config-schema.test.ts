import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigError } from '../src/core/config-schema.js';

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
