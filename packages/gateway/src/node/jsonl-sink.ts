import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TelemetrySink, TelemetryEvent } from '../core/types.js';

export function createJsonlSink(dir: string, now: () => Date = () => new Date()): TelemetrySink {
  return {
    event(e: TelemetryEvent): void {
      try {
        const ts = now().toISOString();
        const file = join(dir, `telemetry-${ts.slice(0, 10)}.jsonl`);
        const line = JSON.stringify({
          ts,
          event: e.event,
          traceId: e.traceId,
          configVersion: e.configVersion,
          ...e.data,
        });
        appendFileSync(file, line + '\n');
      } catch {
        // fire-and-forget
      }
    },
  };
}
