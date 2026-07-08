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
});
