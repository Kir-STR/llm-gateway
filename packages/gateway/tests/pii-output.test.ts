import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };

describe('phase-aware pii (output)', () => {
  it('masks the delivered output text when pii is configured in guards.output', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'pii' } as never);
    const ok: LlmResponse = {
      text: 'reach me at leak@secret.com',
      structured: { answer: 'a', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('q');
    expect(r.outcome).toBe('delivered');
    expect(r.text).not.toContain('leak@secret.com');
    expect(r.text).toContain('[EMAIL_MASKED]');
  });

  it('rejects a route on an output-phase pii guard at init', () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'pii', route: 'somewhere' } as never);
    const { caller } = createFakeLlm([]);
    expect(() =>
      createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' }),
    ).toThrow(/route/i);
  });
});
