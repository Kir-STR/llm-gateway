import { describe, it, expect } from 'vitest';
import { createLangfuseSink } from '../src/langfuse.js';
import type { LangfuseClientLike, LangfuseTraceLike } from '../src/langfuse.js';
import type { TelemetryEvent } from '../src/core/types.js';

type Call = { method: 'trace' | 'generation' | 'update'; body: Record<string, unknown> };

function fakeClient() {
  const calls: Call[] = [];
  const client: LangfuseClientLike = {
    trace(body) {
      calls.push({ method: 'trace', body: body as Record<string, unknown> });
      const handle: LangfuseTraceLike = {
        generation(b) {
          calls.push({ method: 'generation', body: b as Record<string, unknown> });
          return undefined;
        },
        update(b) {
          calls.push({ method: 'update', body: b as Record<string, unknown> });
          return undefined;
        },
      };
      return handle;
    },
  };
  return { client, calls };
}

function ev(event: string, traceId: string, data: Record<string, unknown>): TelemetryEvent {
  return { event, traceId, configVersion: '1.0.0', data };
}

describe('createLangfuseSink — trace lifecycle', () => {
  it('creates a trace exactly once per traceId', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client);
    sink.event(ev('turn_started', 't1', { inputLen: 5 }));
    sink.event(ev('turn_completed', 't1', { outcome: 'delivered' }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(1);
  });

  it('turn_started updates the trace with inputLen + configVersion metadata', () => {
    const { client, calls } = fakeClient();
    createLangfuseSink(client).event(ev('turn_started', 't1', { inputLen: 42 }));
    const update = calls.find((c) => c.method === 'update');
    expect(update?.body).toEqual({ metadata: { inputLen: 42, configVersion: '1.0.0' } });
  });

  it('turn_completed updates the trace with the outcome then evicts (next event makes a new trace)', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client);
    sink.event(ev('turn_started', 't1', { inputLen: 1 }));
    sink.event(
      ev('turn_completed', 't1', {
        outcome: 'delivered',
        scenario: 'llm',
        flags: [],
        totalLatencyMs: 10,
        totalCostUsd: 0.01,
      }),
    );
    // evicted -> a further event with the same traceId creates a SECOND trace
    sink.event(ev('turn_started', 't1', { inputLen: 2 }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(2);
  });

  it('ignores non-core events (no client calls)', () => {
    const { client, calls } = fakeClient();
    createLangfuseSink(client).event(
      ev('guard_result', 't1', { guard: 'pii', phase: 'input', outcome: 'PASS', durationMs: 1 }),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('createLangfuseSink — llm_call generation', () => {
  const fixedNow = new Date('2026-07-10T12:00:00.000Z');

  it('maps llm_call to a generation with usageDetails, costDetails, model and deterministic timestamps', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(ev('turn_started', 't1', { inputLen: 3 }));
    sink.event(
      ev('llm_call', 't1', {
        modelRef: 'primary',
        model: 'claude-x',
        attempt: 1,
        inTokens: 100,
        outTokens: 40,
        latencyMs: 250,
        outcome: 'ok',
        costUsd: 0.0021,
      }),
    );
    const gen = calls.find((c) => c.method === 'generation');
    expect(gen).toBeDefined();
    expect(gen!.body).toMatchObject({
      name: 'llm call',
      model: 'claude-x',
      usageDetails: { input: 100, output: 40 },
      costDetails: { total: 0.0021 },
      startTime: new Date(fixedNow.getTime() - 250),
      endTime: fixedNow,
      metadata: { modelRef: 'primary', attempt: 1, outcome: 'ok' },
    });
  });

  it('includes cache token counts in usageDetails when present', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(
      ev('llm_call', 't1', {
        model: 'm',
        inTokens: 10,
        outTokens: 2,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        latencyMs: 5,
        outcome: 'ok',
        costUsd: 0,
      }),
    );
    const gen = calls.find((c) => c.method === 'generation');
    expect(gen!.body.usageDetails).toEqual({ input: 10, output: 2, cache_read: 7, cache_write: 3 });
  });

  it('emits one generation per llm_call under a single trace', () => {
    const { client, calls } = fakeClient();
    const sink = createLangfuseSink(client, { now: () => fixedNow });
    sink.event(ev('llm_call', 't1', { model: 'm', inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok', costUsd: 0 }));
    sink.event(ev('llm_call', 't1', { model: 'm', inTokens: 1, outTokens: 1, latencyMs: 1, outcome: 'ok', costUsd: 0 }));
    expect(calls.filter((c) => c.method === 'trace')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'generation')).toHaveLength(2);
  });
});
