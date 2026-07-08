import type {
  Gateway,
  GatewayDeps,
  TurnContext,
  TurnResult,
  LimitsStore,
  DailyState,
  LlmRequest,
  LlmResponse,
  ScenarioResult,
} from './types.js';
import { LlmCallError } from './types.js';
import type { GatewayConfig, GuardConfig, ScenarioConfig } from './config-schema.js';
import { validateConfig, ConfigError } from './config-schema.js';
import { EVENTS } from './telemetry-events.js';
import { makeEmitter } from './emit.js';
import { normalize } from './normalize.js';
import { runGuards, type GuardEntry } from './guards-runner.js';
import { aggregateInput } from './aggregate.js';
import { selectScenario } from './router.js';
import { makeStructuredValidator, type StructuredResult } from './structured.js';
import { worstCaseCostUsd, actualCostUsd } from './cost.js';
import { renderNamed } from './templates.js';
import { findRetryRule, backoffMs } from './retry.js';
import { createInjectionGuard } from '../guards/injection.js';
import { createPiiGuard } from '../guards/pii.js';
import { createLimitsGuard } from '../guards/limits.js';
import { createPolicyGuard } from '../guards/policy.js';

export function createMemoryLimitsStore(): LimitsStore {
  let state: DailyState | null = null;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
  };
}

const DEFAULTS: Record<string, { onError: 'reject' | 'degrade'; template: string }> = {
  injection: { onError: 'reject', template: 'injection_reject' },
  pii: { onError: 'reject', template: 'pii_detected' },
  limits: { onError: 'reject', template: 'degrade' },
  policy: { onError: 'degrade', template: 'policy_reject' },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

class BudgetExceeded extends Error {}
class TransportExhausted extends Error {}

// Referential integrity of config-declared cross-references — runs at init so runTurn never throws on them.
function assertReferentialIntegrity(config: GatewayConfig, deps: GatewayDeps): void {
  const scenarios = new Set(Object.keys(config.scenarios));
  const models = new Set(Object.keys(config.models));
  const templates = new Set(Object.keys(config.templates));
  const structured = new Set(Object.keys(config.structured_output ?? {}));
  const need = (ok: boolean, msg: string) => {
    if (!ok) throw new ConfigError(msg);
  };

  for (const key of ['normalize_reject', 'degrade', 'llm_fail', 'parse_fail', 'policy_reject']) {
    need(templates.has(key), `templates."${key}" is required by the pipeline`);
  }
  for (const rule of config.routing.rules) {
    if (rule.scenario)
      need(scenarios.has(rule.scenario), `routing targets unknown scenario "${rule.scenario}"`);
    if (rule.default)
      need(
        scenarios.has(rule.default),
        `routing default targets unknown scenario "${rule.default}"`,
      );
  }
  need(
    config.routing.rules.some((r) => r.default !== undefined),
    'routing.rules must include a rule with "default"',
  );
  for (const g of [...(config.guards?.input ?? []), ...(config.guards?.output ?? [])]) {
    if (typeof g.route === 'string')
      need(scenarios.has(g.route), `guard "${g.name}" route targets unknown scenario "${g.route}"`);
    if (typeof g.reject_template === 'string')
      need(
        templates.has(g.reject_template),
        `guard "${g.name}" reject_template "${g.reject_template}" is undefined`,
      );
    const effective =
      typeof g.reject_template === 'string' ? g.reject_template : DEFAULTS[g.name]?.template;
    if (effective !== undefined)
      need(
        templates.has(effective),
        `guard "${g.name}" effective reject template "${effective}" is undefined`,
      );
  }
  for (const [name, sc] of Object.entries(config.scenarios)) {
    if (sc.kind === 'llm') {
      need(models.has(sc.model), `scenario "${name}" references unknown model tier "${sc.model}"`);
      if (sc.structured_output)
        need(
          structured.has(sc.structured_output),
          `scenario "${name}" references unknown structured_output "${sc.structured_output}"`,
        );
    } else if (sc.kind === 'stub') {
      need(
        templates.has(sc.template),
        `scenario "${name}" references unknown template "${sc.template}"`,
      );
    } else {
      need(
        !!deps.customScenarios?.[sc.handler],
        `scenario "${name}" references custom handler "${sc.handler}" absent from deps.customScenarios`,
      );
    }
  }
  for (const r of config.retry ?? []) {
    if (r.escalate_to_model)
      need(
        models.has(r.escalate_to_model),
        `retry escalate_to_model "${r.escalate_to_model}" is not a known model tier`,
      );
  }

  // Every model tier reachable by an llm scenario or a retry escalation must have a price entry,
  // else actualCostUsd/worstCaseCostUsd throw mid-call (after the call is billed) instead of at init.
  const usedTiers = new Set<string>();
  for (const sc of Object.values(config.scenarios)) {
    if (sc.kind === 'llm') usedTiers.add(sc.model);
  }
  for (const r of config.retry ?? []) {
    if (r.escalate_to_model) usedTiers.add(r.escalate_to_model);
  }
  for (const tierKey of usedTiers) {
    const modelName = config.models[tierKey]?.model;
    need(
      !!modelName && !!config.limits?.prices?.[modelName],
      `limits.prices must include an entry for model "${modelName}" (tier "${tierKey}") used by an llm scenario or retry escalation`,
    );
  }
}

export function createGateway(config: GatewayConfig, deps: GatewayDeps): Gateway {
  validateConfig(config);
  assertReferentialIntegrity(config, deps);

  const store = deps.limitsStore ?? createMemoryLimitsStore();
  const idGen = deps.idGenerator ?? (() => globalThis.crypto.randomUUID());
  const prices = config.limits?.prices ?? {};
  const perRequestCap = config.limits?.per_request?.max_cost_usd;

  // soft/hard thresholds from the limits guard config (facade owns increment + soft emission)
  const limitsCfg = (config.guards?.input ?? []).find((g) => g.name === 'limits');
  const perDay =
    (limitsCfg?.per_day as { soft_warning_usd?: number; hard_cap_usd?: number } | undefined) ?? {};
  const softCapUsd = perDay.soft_warning_usd;
  const hardCapForEvent = perDay.hard_cap_usd ?? softCapUsd;

  const structuredValidators = new Map<string, (v: unknown) => StructuredResult>();
  for (const [key, so] of Object.entries(config.structured_output ?? {})) {
    structuredValidators.set(key, makeStructuredValidator(so.schema));
  }

  const inputEntries = buildEntries(config.guards?.input ?? [], 'input');
  const outputEntries = buildEntries(config.guards?.output ?? [], 'output');

  function buildEntries(cfgs: GuardConfig[], phase: 'input' | 'output'): GuardEntry[] {
    const entries = cfgs.map((cfg) => {
      const def = DEFAULTS[cfg.name];
      let guard;
      if (cfg.name === 'injection') guard = createInjectionGuard(cfg);
      else if (cfg.name === 'pii') guard = createPiiGuard(cfg);
      else if (cfg.name === 'limits') guard = createLimitsGuard(cfg, { store });
      else if (cfg.name === 'policy') guard = createPolicyGuard(cfg);
      else {
        const custom = (deps.guards ?? []).find((g) => g.name === cfg.name && g.phase === phase);
        if (!custom)
          throw new ConfigError(
            `Unknown guard "${cfg.name}" (${phase}); not built-in and not in deps.guards`,
          );
        guard = custom;
      }
      const onError = (cfg.on_error ?? def?.onError ?? 'degrade') as 'reject' | 'degrade';
      const rejectTemplate =
        (cfg.reject_template as string | undefined) ?? def?.template ?? 'degrade';
      return { guard, onError, rejectTemplate };
    });
    const transformers = entries.filter((e) => e.guard.transforms === true);
    if (transformers.length > 1)
      throw new ConfigError(`More than one transforming guard in ${phase} phase`);
    return entries;
  }

  async function runTurn(input: string, meta: Record<string, unknown> = {}): Promise<TurnResult> {
    const traceId = idGen();
    const emit = makeEmitter(deps.telemetry, config.version, traceId);
    const startedAt = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, llmCalls: 0 };

    emit(EVENTS.turnStarted, { inputLen: input.length });

    // helpers that capture per-turn state
    const finish = (
      outcome: TurnResult['outcome'],
      kind: TurnResult['kind'],
      text: string,
      scenario: string,
      flags: string[],
      degradeReason?: TurnResult['degradeReason'],
      structured?: unknown,
    ): TurnResult => {
      emit(EVENTS.delivery, { kind, scenario, textLen: text.length });
      emit(EVENTS.turnCompleted, {
        outcome,
        scenario,
        flags,
        totalLatencyMs: Date.now() - startedAt,
        totalCostUsd: usage.costUsd,
        degradeReason,
      });
      const result: TurnResult = {
        traceId,
        outcome,
        kind,
        text,
        scenario,
        flags,
        usage: { ...usage },
      };
      if (structured !== undefined) result.structured = structured;
      if (degradeReason !== undefined) result.degradeReason = degradeReason;
      return result;
    };
    const stub = (
      templateKey: string,
      outcome: TurnResult['outcome'],
      scenario: string,
      flags: string[],
      degradeReason?: TurnResult['degradeReason'],
    ) =>
      finish(
        outcome,
        'stub',
        renderNamed(config.templates, templateKey, traceId),
        scenario,
        flags,
        degradeReason,
      );

    // 1) normalize
    const norm = normalize(input, config.normalize?.max_input_chars);
    if (norm.reject) {
      emit(EVENTS.normalize, {
        outcome: 'REJECT',
        code: norm.reject.code,
        rulesApplied: norm.rulesApplied,
      });
      return stub('normalize_reject', 'rejected', 'normalize', []);
    }
    emit(EVENTS.normalize, { outcome: 'PASS', rulesApplied: norm.rulesApplied });

    const ctx: TurnContext = { traceId, input: { raw: input, text: norm.text }, meta };

    // 2) input guards
    const inResults = await runGuards(inputEntries, ctx);
    for (const r of inResults) {
      emit(EVENTS.guardResult, {
        guard: r.name,
        phase: 'input',
        outcome: r.verdict.outcome,
        code: r.verdict.code,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        errored: r.errored,
        evidence: r.verdict.evidence,
      });
    }
    const agg = aggregateInput(
      inResults.map((r) => ({
        name: r.name,
        verdict: r.verdict,
        rejectTemplate: r.rejectTemplate,
      })),
    );
    emit(EVENTS.guardsAggregated, {
      decision: agg.decision,
      flags: agg.flags,
      forcedRoute: agg.forcedRoute,
      rejectCode: agg.rejectCode,
    });

    if (agg.decision === 'reject') {
      const degradeReason =
        agg.rejectCode === 'E_COST_CAP'
          ? 'cost_cap'
          : agg.rejectCode === 'E_GUARD_ERROR'
            ? 'guard_error'
            : undefined;
      if (agg.rejectCode === 'E_COST_CAP') {
        const ev = (inResults.find((r) => r.verdict.code === 'E_COST_CAP')?.verdict.evidence ??
          {}) as { dailyCostUsd?: number; capUsd?: number };
        emit(EVENTS.costCap, {
          state: 'hard',
          dailyCostUsd: ev.dailyCostUsd ?? 0,
          capUsd: ev.capUsd ?? 0,
        });
      }
      return stub(
        agg.rejectTemplate ?? 'degrade',
        'rejected',
        'guard_reject',
        agg.flags,
        degradeReason,
      );
    }

    if (agg.transform !== undefined) ctx.input.text = agg.transform;

    // 3) route
    const route = selectScenario(config.routing, agg.flags, agg.forcedRoute);
    emit(EVENTS.routeDecision, { scenario: route.scenario, matchedRule: route.matchedRule });
    const scenario = config.scenarios[route.scenario] as ScenarioConfig | undefined;
    // config-declared routes are validated in createGateway; an unknown route here can only come
    // from a custom guard's dynamic route → graceful failure, never a throw (runTurn must not throw)
    if (!scenario) return stub('degrade', 'failed', route.scenario, agg.flags);

    // 4) stub scenario
    if (scenario.kind === 'stub') {
      return stub(scenario.template, 'delivered', route.scenario, agg.flags);
    }

    // 5) custom scenario
    if (scenario.kind === 'custom') {
      const handler = deps.customScenarios?.[scenario.handler];
      if (!handler) return stub('degrade', 'failed', route.scenario, agg.flags); // validated at init; defensive, non-throwing
      let res: ScenarioResult;
      try {
        res = await handler(ctx);
      } catch {
        return stub('llm_fail', 'failed', route.scenario, agg.flags, 'upstream_unavailable');
      }
      ctx.output = { text: res.text, structured: res.structured };
      return await outputStage(ctx, route.scenario, 'custom', agg.flags);
    }

    // 6) llm scenario — increment counter after each real call, emit soft cost_cap on crossing
    const incrementDaily = async (cost: number): Promise<void> => {
      const today = utcDate(new Date());
      let state: DailyState | null = null;
      try {
        state = await store.load();
      } catch {
        state = null;
      }
      const base =
        state && state.date === today ? state : { date: today, costUsd: 0, requestCount: 0 };
      const prev = base.costUsd;
      const next: DailyState = {
        date: today,
        costUsd: prev + cost,
        requestCount: base.requestCount + 1,
      };
      try {
        await store.save(next);
      } catch {
        /* ignore persistence errors */
      }
      if (softCapUsd !== undefined && prev < softCapUsd && next.costUsd >= softCapUsd) {
        emit(EVENTS.costCap, {
          state: 'soft',
          dailyCostUsd: next.costUsd,
          capUsd: hardCapForEvent ?? softCapUsd,
        });
      }
    };

    // one transport-retried LLM call; increments the daily counter on success
    const doLlmCall = async (
      modelRef: string,
      correction: string | undefined,
      attemptLabelBase: number,
    ): Promise<LlmResponse> => {
      const tier = config.models[modelRef];
      if (!tier) throw new ConfigError(`Scenario references unknown model tier "${modelRef}"`);
      const model = tier.model;
      if (perRequestCap !== undefined) {
        const wc = worstCaseCostUsd(model, ctx.input.text.length, tier.max_tokens ?? 0, prices);
        if (wc > perRequestCap) throw new BudgetExceeded();
      }
      const req: LlmRequest = { modelRef, model, input: ctx.input.text };
      if (tier.max_tokens !== undefined) req.maxTokens = tier.max_tokens;
      if (tier.temperature !== undefined) req.temperature = tier.temperature;
      if (correction !== undefined) req.correction = correction;
      if (scenario.kind === 'llm' && scenario.structured_output) {
        const schema = config.structured_output?.[scenario.structured_output]?.schema;
        if (schema !== undefined) req.toolSchema = schema;
      }

      const rule = findRetryRule(config.retry, 'llm_transport_error');
      const maxRetries = rule?.max_attempts ?? 0;
      let attempt = 0;
      while (true) {
        attempt++;
        const t0 = Date.now();
        try {
          const resp = await deps.llm.call(req);
          const cost = actualCostUsd(model, resp.usage, prices);
          emit(EVENTS.llmCall, {
            modelRef,
            model,
            attempt: attemptLabelBase + attempt,
            inTokens: resp.usage.inputTokens,
            outTokens: resp.usage.outputTokens,
            cacheReadTokens: resp.usage.cacheReadTokens,
            cacheWriteTokens: resp.usage.cacheWriteTokens,
            latencyMs: Date.now() - t0,
            outcome: 'ok',
            costUsd: cost,
          });
          usage.inputTokens += resp.usage.inputTokens;
          usage.outputTokens += resp.usage.outputTokens;
          usage.costUsd += cost;
          usage.llmCalls += 1;
          await incrementDaily(cost);
          return resp;
        } catch (err) {
          const code = err instanceof LlmCallError ? err.code : 'unknown';
          emit(EVENTS.llmCall, {
            modelRef,
            model,
            attempt: attemptLabelBase + attempt,
            inTokens: 0,
            outTokens: 0,
            latencyMs: Date.now() - t0,
            outcome: 'error',
            errorCode: code,
            costUsd: 0,
          });
          const retryable = err instanceof LlmCallError && err.retryable;
          if (retryable && attempt <= maxRetries) {
            emit(EVENTS.retry, {
              trigger: 'llm_transport_error',
              attempt,
              maxAttempts: maxRetries,
            });
            await sleep(backoffMs(rule?.backoff_ms ?? 250, attempt));
            continue;
          }
          throw new TransportExhausted();
        }
      }
    };

    // resolve structured output with its own correction retry
    const resolveStructured = async (
      first: LlmResponse,
      modelRef: string,
    ): Promise<{ resp: LlmResponse; value: unknown } | { failed: true }> => {
      if (scenario.kind !== 'llm' || !scenario.structured_output)
        return { resp: first, value: undefined };
      const validate = structuredValidators.get(scenario.structured_output)!;
      const rule = findRetryRule(config.retry, 'structured_parse_failed');
      const maxRetries = rule?.max_attempts ?? 0;
      let resp = first;
      let attempt = 0;
      while (true) {
        const parsed = validate(resp.structured);
        emit(EVENTS.structuredParse, {
          valid: parsed.valid,
          attempt,
          code: parsed.valid ? undefined : 'E_SCHEMA',
          detail: parsed.detail,
        });
        if (parsed.valid) return { resp, value: parsed.value };
        if (attempt < maxRetries) {
          attempt++;
          emit(EVENTS.retry, {
            trigger: 'structured_parse_failed',
            attempt,
            maxAttempts: maxRetries,
          });
          try {
            resp = await doLlmCall(modelRef, rule?.correction_prompt, attempt);
          } catch {
            return { failed: true };
          }
          continue;
        }
        return { failed: true };
      }
    };

    // output-guard stage, shared by llm and custom scenarios; retries the llm generation on hard reject
    async function outputStage(
      c: TurnContext,
      scenarioName: string,
      kind: 'llm' | 'custom',
      flags: string[],
    ): Promise<TurnResult> {
      const outRule = findRetryRule(config.retry, 'output_guard_rejected');
      const outMax = outRule?.max_attempts ?? 0;
      let outAttempt = 0;
      // `scenario` is narrowed to non-undefined at the outer `if (!scenario) return` above, but
      // TS does not propagate that narrowing into a hoisted function declaration's body — assert it here.
      let modelRef = scenario!.kind === 'llm' ? scenario!.model : '';

      while (true) {
        const outResults = await runGuards(outputEntries, c);
        for (const r of outResults) {
          emit(EVENTS.guardResult, {
            guard: r.name,
            phase: 'output',
            outcome: r.verdict.outcome,
            code: r.verdict.code,
            durationMs: r.durationMs,
            timedOut: r.timedOut,
            errored: r.errored,
            evidence: r.verdict.evidence,
          });
        }
        const outAgg = aggregateInput(
          outResults.map((r) => ({
            name: r.name,
            verdict: r.verdict,
            rejectTemplate: r.rejectTemplate,
          })),
        );
        const mergedFlags = [...flags, ...outAgg.flags];

        if (outAgg.decision !== 'reject') {
          return finish(
            'delivered',
            kind,
            c.output?.text ?? '',
            scenarioName,
            mergedFlags,
            undefined,
            c.output?.structured,
          );
        }
        // hard output reject → retry the generation with correction (llm only), else stub policy_reject
        if (kind === 'llm' && outAttempt < outMax) {
          outAttempt++;
          if (outRule?.escalate_to_model) modelRef = outRule.escalate_to_model;
          emit(EVENTS.retry, {
            trigger: 'output_guard_rejected',
            attempt: outAttempt,
            maxAttempts: outMax,
            escalatedTo: outRule?.escalate_to_model,
          });
          let resp: LlmResponse;
          try {
            resp = await doLlmCall(modelRef, outRule?.correction_prompt, 100 + outAttempt);
          } catch (err) {
            if (err instanceof BudgetExceeded)
              return stub('degrade', 'rejected', scenarioName, mergedFlags, 'cost_cap');
            return stub('llm_fail', 'failed', scenarioName, mergedFlags, 'upstream_unavailable');
          }
          const s = await resolveStructured(resp, modelRef);
          if ('failed' in s) return stub('parse_fail', 'failed', scenarioName, mergedFlags);
          c.output = { text: resp.text ?? '', structured: s.value };
          continue;
        }
        return stub('policy_reject', 'rejected', scenarioName, mergedFlags);
      }
    }

    // llm scenario entry
    let firstResp: LlmResponse;
    try {
      firstResp = await doLlmCall(scenario.model, undefined, 0);
    } catch (err) {
      if (err instanceof BudgetExceeded)
        return stub('degrade', 'rejected', route.scenario, agg.flags, 'cost_cap');
      return stub('llm_fail', 'failed', route.scenario, agg.flags, 'upstream_unavailable');
    }
    const structuredResult = await resolveStructured(firstResp, scenario.model);
    if ('failed' in structuredResult)
      return stub('parse_fail', 'failed', route.scenario, agg.flags);
    ctx.output = { text: structuredResult.resp.text ?? '', structured: structuredResult.value };
    return await outputStage(ctx, route.scenario, 'llm', agg.flags);
  }

  async function close(): Promise<void> {
    // in-memory store persists per turn; nothing to flush for the default sink
  }

  return { runTurn, close };
}
