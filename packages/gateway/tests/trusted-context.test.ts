import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { LlmResponse, TelemetrySink } from '../src/core/types.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

// Security invariant: trusted server context (`meta`) is never forwarded into the model
// request. The model has no channel through which it could select a data scope. See the
// package README ("Trusted context and data-scope isolation").

const nullSink: TelemetrySink = { event() {} };
const ok: LlmResponse = {
  text: 'hi',
  structured: { answer: 'a', confidence: 0.9 },
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe('trusted context boundary: meta never reaches the LLM request', () => {
  it('does not forward meta into any LlmRequest (input / whole req)', async () => {
    const SENTINEL = 'SECRET-SECTION-a1b2c3';
    const { caller, calls } = createFakeLlm([ok]);
    const gw = createGateway(neutralConfig, {
      llm: caller,
      telemetry: nullSink,
      idGenerator: () => 't',
    });

    const r = await gw.runTurn('what is the weather today?', { sectionId: SENTINEL, userId: 'u1' });

    expect(r.outcome).toBe('delivered');
    expect(calls.length).toBeGreaterThan(0); // the turn actually reached the LLM
    for (const req of calls) {
      expect(JSON.stringify(req)).not.toContain(SENTINEL);
      expect(req.input).not.toContain(SENTINEL);
    }
  });

  it('keeps meta out of the request across a correction retry (req.correction stays clean)', async () => {
    const SENTINEL = 'SECRET-SECTION-d4e5f6';
    // missing `confidence` -> structured validation fails -> one correction retry
    const bad: LlmResponse = {
      text: 'x',
      structured: { answer: 'a' },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { caller, calls } = createFakeLlm([bad, ok]);
    const gw = createGateway(neutralConfig, {
      llm: caller,
      telemetry: nullSink,
      idGenerator: () => 't',
    });

    await gw.runTurn('a normal question', { sectionId: SENTINEL });

    expect(calls.length).toBe(2); // initial + 1 correction
    for (const req of calls) {
      expect(JSON.stringify(req)).not.toContain(SENTINEL);
    }
  });
});
