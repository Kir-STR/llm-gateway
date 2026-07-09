export type Outcome = 'PASS' | 'DEGRADE' | 'REJECT';

export type Verdict = {
  outcome: Outcome;
  code?: string;
  evidence?: unknown;
  route?: string;
  transform?: string;
};

export interface TurnContext {
  traceId: string;
  input: { raw: string; text: string };
  output?: { text: string; structured?: unknown };
  meta: Readonly<Record<string, unknown>>;
}

export interface Guard {
  name: string;
  phase: 'input' | 'output';
  deterministic: boolean;
  transforms?: boolean;
  timeoutMs?: number;
  run(ctx: TurnContext): Promise<Verdict> | Verdict;
}

export type LlmRequest = {
  modelRef: string;
  model: string;
  input: string;
  correction?: string;
  maxTokens?: number;
  temperature?: number;
  toolSchema?: object;
};

export type LlmResponse = {
  text?: string;
  structured?: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
};

export interface LlmCaller {
  /**
   * Single, thin call to the provider. The core owns retry and timeout policy:
   * when a per-turn timeout is configured it races the call and aborts via `signal`
   * (see `callWithTimeout` in gateway.ts). The adapter enforces no timeout of its own —
   * a transport backstop is the injected provider client's own timeout. The adapter must
   * pass `signal` through to the provider and report provider failures as `LlmCallError`
   * (timeouts/aborts as `code: 'timeout'`, `retryable: false`; the core does not retry them).
   */
  call(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export type LlmErrorCode =
  'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'auth' | 'bad_request' | 'unknown';

export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmCallError';
  }
}

export type TelemetryEvent = {
  event: string;
  traceId: string;
  configVersion: string;
  data: Record<string, unknown>;
};

export interface TelemetrySink {
  event(e: TelemetryEvent): void;
}

export type DailyState = { date: string; costUsd: number; requestCount: number };

export interface LimitsStore {
  load(): Promise<DailyState | null>;
  save(state: DailyState): Promise<void>;
}

export type ScenarioResult = { text: string; structured?: unknown };
export type ScenarioHandler = (ctx: TurnContext) => Promise<ScenarioResult>;

export type GatewayDeps = {
  llm: LlmCaller;
  telemetry: TelemetrySink;
  guards?: Guard[];
  customScenarios?: Record<string, ScenarioHandler>;
  limitsStore?: LimitsStore;
  idGenerator?: () => string;
};

export type DegradeReason = 'upstream_unavailable' | 'cost_cap' | 'guard_error';

export type TurnResult = {
  traceId: string;
  outcome: 'delivered' | 'rejected' | 'failed';
  kind: 'llm' | 'stub' | 'custom';
  text: string;
  structured?: unknown;
  scenario: string;
  flags: string[];
  degradeReason?: DegradeReason;
  usage: { inputTokens: number; outputTokens: number; costUsd: number; llmCalls: number };
};

export interface Gateway {
  runTurn(input: string, meta?: Record<string, unknown>): Promise<TurnResult>;
  close(): Promise<void>;
}
