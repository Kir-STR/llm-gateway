import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };

// A custom output guard that masks a token in the model's output text.
const maskingOutputGuard: Guard = {
  name: 'output_masker',
  phase: 'output',
  deterministic: true,
  transforms: true,
  run: (ctx) => {
    const text = ctx.output?.text ?? '';
    if (!text.includes('SECRET')) return { outcome: 'PASS' };
    return { outcome: 'PASS', transform: text.replace(/SECRET/g, '[MASKED]') };
  },
};

function configWithMaskingOutput(): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  cfg.guards!.output!.push({ name: 'output_masker' } as never);
  return cfg;
}

describe('A4: output-phase transform is applied to delivered text', () => {
  it('delivers the transformed text, not the raw model output', async () => {
    const ok: LlmResponse = {
      text: 'here is a SECRET value',
      structured: { answer: 'a', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(configWithMaskingOutput(), {
      llm: caller,
      telemetry: nullSink,
      guards: [maskingOutputGuard],
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('question');
    expect(r.outcome).toBe('delivered');
    expect(r.text).toBe('here is a [MASKED] value');
  });

  it('does NOT mask output.structured (documented v1 limitation)', async () => {
    const ok: LlmResponse = {
      text: 'clean text',
      structured: { answer: 'contains SECRET', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(configWithMaskingOutput(), {
      llm: caller,
      telemetry: nullSink,
      guards: [maskingOutputGuard],
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('question');
    // structured is delivered as-is — transform only covers text (known limitation).
    expect(JSON.stringify(r.structured)).toContain('SECRET');
  });
});
