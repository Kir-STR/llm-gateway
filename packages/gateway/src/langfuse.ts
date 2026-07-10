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
  const now = options.now ?? ((): Date => new Date());
  const traceName = options.traceName ?? 'llm-gateway turn';
  const generationName = options.generationName ?? 'llm call';
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
      if (
        e.event !== EVENTS.turnStarted &&
        e.event !== EVENTS.llmCall &&
        e.event !== EVENTS.turnCompleted
      ) {
        return; // v1: only the three core events; all others ignored
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

      if (e.event === EVENTS.llmCall) {
        const endTime = now();
        const latencyMs = typeof d.latencyMs === 'number' ? d.latencyMs : 0;
        const usageDetails: Record<string, number> = {};
        if (typeof d.inTokens === 'number') usageDetails.input = d.inTokens;
        if (typeof d.outTokens === 'number') usageDetails.output = d.outTokens;
        if (typeof d.cacheReadTokens === 'number') usageDetails.cache_read = d.cacheReadTokens;
        if (typeof d.cacheWriteTokens === 'number') usageDetails.cache_write = d.cacheWriteTokens;
        const body: Parameters<LangfuseTraceLike['generation']>[0] = {
          name: generationName,
          usageDetails,
          startTime: new Date(endTime.getTime() - latencyMs),
          endTime,
          metadata: {
            modelRef: d.modelRef,
            attempt: d.attempt,
            outcome: d.outcome,
            errorCode: d.errorCode,
          },
        };
        if (typeof d.model === 'string') body.model = d.model;
        if (typeof d.costUsd === 'number') body.costDetails = { total: d.costUsd };
        callClient(() => trace.generation(body));
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
