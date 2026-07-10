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
