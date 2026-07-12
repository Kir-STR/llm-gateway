import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/index.js';
import { createJsonlSink } from '../src/node.js';
import { createLangfuseSink } from '../src/langfuse.js';
import type { Guard, GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

const EMAIL = 'victim@secret.example';
const PHONE = '+79991234567';

function cfgWith(guard?: Record<string, unknown>): GatewayConfig {
  const cfg = structuredClone(neutralConfig) as GatewayConfig;
  if (guard) cfg.guards!.output!.push(guard as never);
  return cfg;
}

describe('leakage: sentinel PII never reaches any sink', () => {
  it('jsonl sink: raw PII from the input never appears in written events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leak-'));
    try {
      const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
      const { caller } = createFakeLlm([ok]);
      const gw = createGateway(neutralConfig, { llm: caller, telemetry: createJsonlSink(dir), idGenerator: () => 't' });
      await gw.runTurn(`email ${EMAIL} phone ${PHONE}`);
      const contents = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
      expect(contents).not.toContain(EMAIL);
      expect(contents).not.toContain(PHONE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Langfuse sink: raw PII never appears in client calls', async () => {
    const calls: unknown[] = [];
    const client = { trace: () => ({ generation: (b: unknown) => { calls.push(b); return {}; }, update: (b: unknown) => { calls.push(b); return {}; } }) };
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: createLangfuseSink(client as never), idGenerator: () => 't' });
    await gw.runTurn(`email ${EMAIL} phone ${PHONE}`);
    expect(JSON.stringify(calls)).not.toContain(EMAIL);
  });

  it('custom guard evidence with raw PII is redacted under safe', async () => {
    const guard: Guard = { name: 'ev_leak', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { note: EMAIL } }) };
    const events: string[] = [];
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfgWith({ name: 'ev_leak' }), { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, guards: [guard], idGenerator: () => 't' });
    await gw.runTurn('q');
    expect(events.join('')).not.toContain(EMAIL);
  });

  it('a thrown guard Error message with raw PII never reaches telemetry', async () => {
    const guard: Guard = { name: 'ev_throw', phase: 'output', deterministic: true, run: () => { throw new Error(`boom ${EMAIL}`); } };
    const events: string[] = [];
    const ok: LlmResponse = { text: 'ok', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const { caller } = createFakeLlm([ok]);
    const gw = createGateway(cfgWith({ name: 'ev_throw', on_error: 'degrade' }), { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, guards: [guard], idGenerator: () => 't' });
    await gw.runTurn('q');
    expect(events.join('')).not.toContain(EMAIL);
  });

  it('structured_parse.detail carries the path/constraint, not the failing value', async () => {
    // structured validation fails (missing confidence) → detail must not quote the answer value
    const bad: LlmResponse = { text: 'x', structured: { answer: EMAIL }, usage: { inputTokens: 1, outputTokens: 1 } };
    const ok: LlmResponse = { text: 'x', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
    const events: string[] = [];
    const { caller } = createFakeLlm([bad, ok]);
    const gw = createGateway(neutralConfig, { llm: caller, telemetry: { event: (e) => events.push(JSON.stringify(e)) }, idGenerator: () => 't' });
    await gw.runTurn('q');
    const detailEvents = events.filter((e) => e.includes('structured_parse'));
    expect(detailEvents.join('')).not.toContain(EMAIL);
  });
});
