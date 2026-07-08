import type { TelemetrySink } from './types.js';

export function makeEmitter(sink: TelemetrySink, configVersion: string, traceId: string) {
  return (event: string, data: Record<string, unknown>): void => {
    try {
      sink.event({ event, traceId, configVersion, data });
    } catch {
      // fire-and-forget: sink errors never fail the turn
    }
  };
}
