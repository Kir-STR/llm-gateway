import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const nullSink = { event() {} };

// A broken output guard: throws on every run. With on_error:'reject' it yields E_GUARD_ERROR REJECT.
const brokenOutputGuard: Guard = {
  name: 'broken',
  phase: 'output',
  deterministic: true,
  run: () => {
    throw new Error('guard is broken');
  },
};

describe('output guard-error bypasses retry', () => {
  it('rejects without regenerating the main model when an output guard errors', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'broken', on_error: 'reject' } as never);
    const ok: LlmResponse = {
      text: 'answer',
      structured: { answer: 'a', confidence: 0.9 },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    // Only ONE response queued: if the code retried the generation, the fake would run dry / be called twice.
    const { caller, calls } = createFakeLlm([ok]);
    const gw = createGateway(cfg, {
      llm: caller,
      telemetry: nullSink,
      guards: [brokenOutputGuard],
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('question');
    expect(r.outcome).toBe('rejected');
    expect(calls.length).toBe(1); // the main model ran once; NO regeneration retry
  });
});
