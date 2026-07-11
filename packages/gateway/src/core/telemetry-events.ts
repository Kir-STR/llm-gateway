export const EVENTS = {
  turnStarted: 'turn_started',
  normalize: 'normalize',
  guardResult: 'guard_result',
  guardsAggregated: 'guards_aggregated',
  routeDecision: 'route_decision',
  llmCall: 'llm_call',
  structuredParse: 'structured_parse',
  retry: 'retry',
  costCap: 'cost_cap',
  delivery: 'delivery',
  turnCompleted: 'turn_completed',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// data shapes — informational contract for emit call sites (not runtime-enforced)
export type TurnStartedData = { inputLen: number };
export type NormalizeData = { outcome: string; code?: string; rulesApplied: string[] };
export type GuardResultData = {
  guard: string;
  phase: 'input' | 'output';
  outcome: string;
  code?: string;
  durationMs: number;
  timedOut: boolean;
  errored: boolean;
  evidence?: unknown;
};
export type GuardsAggregatedData = {
  decision: string;
  flags: string[];
  forcedRoute?: string;
  rejectCode?: string;
};
export type RouteDecisionData = { scenario: string; matchedRule: string };
export type LlmCallData = {
  purpose: 'scenario' | 'judge';
  modelRef: string;
  model: string;
  attempt: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs: number;
  outcome: string;
  errorCode?: string;
  costUsd: number;
};
export type StructuredParseData = {
  valid: boolean;
  attempt: number;
  code?: string;
  detail?: string;
};
export type RetryData = {
  trigger: string;
  attempt: number;
  maxAttempts: number;
  escalatedTo?: string;
};
export type CostCapData = { state: 'soft' | 'hard'; dailyCostUsd: number; capUsd: number };
export type DeliveryData = { kind: string; scenario: string; textLen: number };
export type TurnCompletedData = {
  outcome: string;
  scenario: string;
  flags: string[];
  totalLatencyMs: number;
  totalCostUsd: number;
  degradeReason?: string;
};
