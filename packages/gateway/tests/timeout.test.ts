import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { LlmResponse, TelemetrySink, TelemetryEvent } from '../src/core/types.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const ok: LlmResponse = {
  text: 'hi',
  structured: { answer: 'a', confidence: 0.9 },
  usage: { inputTokens: 1, outputTokens: 1 },
};
const nullSink: TelemetrySink = { event() {} };
const clone = () => structuredClone(neutralConfig);
const hang = () => new Promise<LlmResponse>(() => {}); // never resolves

describe('core-managed timeout', () => {
  it('opt-in: no timeout config -> call made without a signal, behavior unchanged', async () => {
    const { caller, signals } = createFakeLlm([ok]);
    const gw = createGateway(neutralConfig, {
      llm: caller,
      telemetry: nullSink,
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('delivered');
    expect(signals[0]).toBeUndefined();
  });

  it('times out a hanging call -> failed/upstream_unavailable, signal aborted, errorCode timeout', async () => {
    const cfg = clone();
    cfg.llm = { timeout_ms: 10 };
    const events: TelemetryEvent[] = [];
    const { caller, calls, signals } = createFakeLlm([hang]);
    const gw = createGateway(cfg, {
      llm: caller,
      telemetry: { event: (e) => events.push(e) },
      idGenerator: () => 't',
    });
    const r = await gw.runTurn('hello');
    expect(r).toMatchObject({ outcome: 'failed', degradeReason: 'upstream_unavailable' });
    expect(r.text).toBe('Service temporarily unavailable. Code: t');
    expect(calls.length).toBe(1); // not retried
    expect(signals[0]?.aborted).toBe(true); // cooperative cancellation offered
    const llmCall = events.find((e) => e.event === 'llm_call');
    expect(llmCall?.data.errorCode).toBe('timeout');
    expect(llmCall?.data.costUsd).toBe(0);
  });

  it('does not retry a timeout even with a transport retry policy', async () => {
    const cfg = clone(); // neutralConfig has llm_transport_error retry max_attempts 2
    cfg.llm = { timeout_ms: 10 };
    const { caller, calls } = createFakeLlm([hang, ok, ok, ok]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('failed');
    expect(calls.length).toBe(1);
  });

  it('per-tier timeout overrides the global default', async () => {
    // A 100ms call would pass the 5000ms global but trip the 10ms tier override -> failed.
    // The outcome (failed vs delivered) is what proves which timeout was applied.
    const cfg = clone();
    cfg.llm = { timeout_ms: 5000 };
    cfg.models.expensive!.timeout_ms = 10; // main scenario uses `expensive`
    const slow = () => new Promise<LlmResponse>((r) => setTimeout(() => r(ok), 100));
    const { caller, calls } = createFakeLlm([slow]);
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('hello');
    expect(r.outcome).toBe('failed'); // proves the 10ms tier timeout applied, not the 5000ms global
    expect(calls.length).toBe(1);
  });
});
