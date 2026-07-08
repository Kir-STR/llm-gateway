import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlSink } from '../../src/node/jsonl-sink.js';

describe('createJsonlSink', () => {
  it('appends a JSONL line with flattened data and ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'));
    const sink = createJsonlSink(dir, () => new Date('2026-07-08T00:00:00Z'));
    sink.event({
      event: 'turn_started',
      traceId: 't1',
      configVersion: '1.0.0',
      data: { inputLen: 3 },
    });
    const file = join(dir, readdirSync(dir)[0]!);
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(line).toMatchObject({
      event: 'turn_started',
      traceId: 't1',
      configVersion: '1.0.0',
      inputLen: 3,
    });
    expect(typeof line.ts).toBe('string');
  });
  it('does not throw when the directory is invalid', () => {
    const sink = createJsonlSink('/nonexistent/dir/telemetry');
    expect(() =>
      sink.event({ event: 'x', traceId: 't', configVersion: '1', data: {} }),
    ).not.toThrow();
  });
});
