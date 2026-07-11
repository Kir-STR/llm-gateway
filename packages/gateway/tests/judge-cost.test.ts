import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/index.js';
import type { GatewayConfig, LlmResponse } from '../src/index.js';
import { neutralConfig } from './fixtures/config.js';

const nullSink = { event() {} };
const scenarioOk: LlmResponse = {
  text: 'the answer',
  structured: { answer: 'a', confidence: 0.9 },
  usage: { inputTokens: 1, outputTokens: 1 },
};

function splitLlm(scenario: LlmResponse, judge: LlmResponse) {
  const calls: { isJudge: boolean }[] = [];
  return {
    calls,
    caller: {
      async call(req: { toolSchema?: object }): Promise<LlmResponse> {
        const isJudge = JSON.stringify(req.toolSchema ?? {}).includes('decision');
        calls.push({ isJudge });
        return isJudge ? judge : scenario;
      },
    },
  };
}

describe('judge cost-cap pre-check', () => {
  it('rejects (and does NOT call the judge LLM) when the worst-case judge cost busts the per-request cap', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    // Dedicated tier for the judge with a large max_tokens so its worst-case cost is far bigger
    // than the scenario's worst-case cost — this gives a robust margin: a cap can sit above the
    // scenario's worst case (scenario passes its own pre-check) while still being far below the
    // judge's worst case (judge pre-check busts).
    cfg.models = {
      ...cfg.models,
      judge_big: { model: 'model-expensive', max_tokens: 100_000, temperature: 0.3 },
    };
    cfg.limits = { ...(cfg.limits ?? {}), per_request: { max_cost_usd: 0.05 } } as never;
    cfg.guards = {
      ...cfg.guards,
      output: [
        ...(cfg.guards?.output ?? []),
        { name: 'judge', model: 'judge_big', criteria: 'x', timeout_ms: 5000 } as never,
      ],
    };
    const { caller, calls } = splitLlm(scenarioOk, {
      structured: { decision: 'pass' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('question');
    // scenario runs (its own worst-case check passes) but the judge LLM must be skipped
    expect(calls.some((c) => c.isJudge)).toBe(false);
    expect(calls.some((c) => !c.isJudge)).toBe(true);
    expect(r.outcome).toBe('rejected');
  });

  it('does not trigger main-model regeneration when the judge cost-cap pre-check busts (no escalated second scenario call)', async () => {
    const cfg = structuredClone(neutralConfig) as GatewayConfig;
    cfg.models = {
      ...cfg.models,
      judge_big: { model: 'model-expensive', max_tokens: 100_000, temperature: 0.3 },
    };
    cfg.limits = { ...(cfg.limits ?? {}), per_request: { max_cost_usd: 0.05 } } as never;
    cfg.guards = {
      ...cfg.guards,
      output: [
        ...(cfg.guards?.output ?? []),
        { name: 'judge', model: 'judge_big', criteria: 'x', timeout_ms: 5000 } as never,
      ],
    };
    let scenarioCalls = 0;
    const caller = {
      async call(req: { toolSchema?: object }): Promise<LlmResponse> {
        const isJudge = JSON.stringify(req.toolSchema ?? {}).includes('decision');
        if (isJudge) throw new Error('judge LLM must not be called when the cap pre-check busts');
        scenarioCalls++;
        if (scenarioCalls > 1) throw new Error('main-model must not be called a second time (no regeneration)');
        return scenarioOk;
      },
    };
    const gw = createGateway(cfg, { llm: caller, telemetry: nullSink, idGenerator: () => 't' });
    const r = await gw.runTurn('question');
    expect(scenarioCalls).toBe(1);
    expect(r.outcome).toBe('rejected');
  });
});
