import type { TelemetryEvent, TelemetrySink } from './core/types.js';
import { EVENTS } from './core/telemetry-events.js';

export interface LangfuseTraceLike {
  generation(body: {
    name?: string;
    model?: string;
    usageDetails?: Record<string, number>;
    costDetails?: Record<string, number>;
    startTime?: Date;
    endTime?: Date;
    metadata?: Record<string, unknown>;
  }): unknown;
  update(body: { metadata?: Record<string, unknown> }): unknown;
}

export interface LangfuseClientLike {
  trace(body: {
    id?: string;
    name?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseTraceLike;
}

export interface LangfuseSinkOptions {
  now?: () => Date;
  traceName?: string;
  generationName?: string;
}

// emit.ts wraps sink.event() in try/catch, but event() is synchronous — it only catches
// synchronous throws. If a client method returns a rejecting promise it would be an unhandled
// rejection. callClient swallows both: sync throw and async reject.
function callClient<T>(fn: () => T): T | undefined {
  try {
    const r = fn();
    if (r != null && typeof (r as { then?: unknown }).then === 'function') {
      (r as unknown as Promise<unknown>).catch(() => {});
    }
    return r;
  } catch {
    return undefined;
  }
}

export function createLangfuseSink(
  client: LangfuseClientLike,
  options: LangfuseSinkOptions = {},
): TelemetrySink {
  const traceName = options.traceName ?? 'llm-gateway turn';
  const open = new Map<string, LangfuseTraceLike>();

  function getOrCreate(traceId: string): LangfuseTraceLike | undefined {
    const existing = open.get(traceId);
    if (existing) return existing;
    const created = callClient(() => client.trace({ id: traceId, name: traceName }));
    if (created) open.set(traceId, created);
    return created;
  }

  return {
    event(e: TelemetryEvent): void {
      if (e.event !== EVENTS.turnStarted && e.event !== EVENTS.turnCompleted) {
        return; // v1 core events; llm_call added in Task 2, all others ignored
      }
      const trace = getOrCreate(e.traceId);
      if (!trace) return;
      const d = e.data;

      if (e.event === EVENTS.turnStarted) {
        callClient(() =>
          trace.update({ metadata: { inputLen: d.inputLen, configVersion: e.configVersion } }),
        );
        return;
      }

      // turn_completed
      callClient(() =>
        trace.update({
          metadata: {
            outcome: d.outcome,
            scenario: d.scenario,
            flags: d.flags,
            degradeReason: d.degradeReason,
            totalLatencyMs: d.totalLatencyMs,
            totalCostUsd: d.totalCostUsd,
          },
        }),
      );
      open.delete(e.traceId);
    },
  };
}
