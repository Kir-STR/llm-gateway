import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { Guard, GatewayConfig, TelemetryEvent, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';
import { createFakeLlm } from './fixtures/fake-llm.js';

function run(cfg: GatewayConfig, guards: Guard[]) {
  const events: TelemetryEvent[] = [];
  const ok: LlmResponse = { text: 'hi', structured: { answer: 'a', confidence: 0.9 }, usage: { inputTokens: 1, outputTokens: 1 } };
  const { caller } = createFakeLlm([ok]);
  const gw = createGateway(cfg, { llm: caller, telemetry: { event: (e) => events.push(e) }, guards, idGenerator: () => 't' });
  return { events, gw };
}

const SECRET = 'raw-evidence-secret@x.com';

describe('evidence policy at the emit boundary', () => {
  it('a custom guard defaults to safe: string evidence is redacted', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'custom_ev' } as never);
    const guard: Guard = { name: 'custom_ev', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { flag: true, note: SECRET } }) };
    const { events, gw } = run(cfg, [guard]);
    await gw.runTurn('q');
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'custom_ev');
    expect(JSON.stringify(ev?.data.evidence)).not.toContain(SECRET);
    expect(JSON.stringify(ev?.data.evidence)).toContain('[omitted:string]');
    expect((ev?.data.evidence as { flag?: boolean }).flag).toBe(true);
  });

  it('a built-in guard defaults to full (evidence passes through)', async () => {
    const { events, gw } = run(structuredClone(neutralConfig) as GatewayConfig, []);
    await gw.runTurn('contact me at a@b.com'); // triggers built-in pii evidence {email,phone}
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'pii');
    expect((ev?.data.evidence as { email?: boolean }).email).toBe(true); // booleans pass under full
  });

  it('config evidence:omit removes a custom guard evidence', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.guards!.output!.push({ name: 'custom_ev', evidence: 'omit' } as never);
    const guard: Guard = { name: 'custom_ev', phase: 'output', deterministic: true, run: () => ({ outcome: 'PASS', evidence: { note: SECRET } }) };
    const { events, gw } = run(cfg, [guard]);
    await gw.runTurn('q');
    const ev = events.find((e) => e.event === 'guard_result' && (e.data as { guard?: string }).guard === 'custom_ev');
    expect(ev?.data.evidence).toBeUndefined();
  });
});
