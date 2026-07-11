// `ajv` and `ajv-formats` ship CJS default exports that don't type-check as
// default imports under moduleResolution NodeNext + verbatimModuleSyntax
// (both a known ecosystem interop gap, not a shape issue) — use the named
// export for Ajv and unwrap the `.default` for the formats plugin instead.
import { Ajv } from 'ajv';
import * as ajvFormatsNs from 'ajv-formats';

const addFormats = (ajvFormatsNs as unknown as { default: (ajv: Ajv) => Ajv }).default;

export type ModelTier = {
  model: string;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
};
export type PatternRule = {
  id: string;
  kind: 'substring' | 'regex';
  pattern: string;
  case_sensitive?: boolean;
  severity: 'hard' | 'soft';
};
export type GuardConfig = {
  name: string;
  on_error?: 'reject' | 'degrade';
  timeout_ms?: number;
  reject_template?: string;
  route?: string;
  [k: string]: unknown; // guard-specific keys (patterns, rules, mask, per_day, ...)
};
export type PolicyRule =
  | { id: string; kind: 'regex_deny' | 'regex_require'; pattern: string; severity: 'hard' | 'soft' }
  | { id: string; kind: 'json_schema'; schema: object; severity: 'hard' | 'soft' };
export type ScenarioConfig =
  | { kind: 'llm'; model: string; structured_output?: string }
  | { kind: 'stub'; template: string }
  | { kind: 'custom'; handler: string };
export type RetryRule = {
  trigger: 'llm_transport_error' | 'structured_parse_failed' | 'output_guard_rejected';
  max_attempts: number;
  backoff_ms?: number;
  correction_prompt?: string;
  escalate_to_model?: string;
};
export type GatewayConfig = {
  version: string;
  models: Record<string, ModelTier>;
  llm?: { timeout_ms?: number };
  normalize?: { max_input_chars?: number };
  guards?: { input?: GuardConfig[]; output?: GuardConfig[] };
  limits?: {
    per_request?: { max_cost_usd?: number };
    prices?: Record<string, { input: number; output: number }>;
  };
  routing: {
    rules: Array<{ when?: { flags_any: string[] }; scenario?: string; default?: string }>;
  };
  scenarios: Record<string, ScenarioConfig>;
  structured_output?: Record<string, { schema: object }>;
  retry?: RetryRule[];
  templates: Record<string, string>;
};

const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'models', 'routing', 'scenarios', 'templates'],
  properties: {
    version: { type: 'string' },
    models: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { timeout_ms: { type: 'integer', minimum: 1 } },
      },
    },
    llm: {
      type: 'object',
      additionalProperties: false,
      properties: { timeout_ms: { type: 'integer', minimum: 1 } },
    },
    normalize: {
      type: 'object',
      additionalProperties: false,
      properties: { max_input_chars: { type: 'number' } },
    },
    guards: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'array', items: { $ref: '#/$defs/guardConfig' } },
        output: { type: 'array', items: { $ref: '#/$defs/guardConfig' } },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        per_request: {
          type: 'object',
          additionalProperties: false,
          properties: { max_cost_usd: { type: 'number' } },
        },
        prices: { type: 'object' },
      },
    },
    routing: {
      type: 'object',
      required: ['rules'],
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              when: {
                type: 'object',
                additionalProperties: false,
                required: ['flags_any'],
                properties: { flags_any: { type: 'array', items: { type: 'string' } } },
              },
              scenario: { type: 'string' },
              default: { type: 'string' },
            },
          },
        },
      },
    },
    scenarios: { type: 'object' },
    structured_output: { type: 'object' },
    retry: { type: 'array' },
    templates: { type: 'object', additionalProperties: { type: 'string' } },
  },
  $defs: {
    guardConfig: {
      type: 'object',
      required: ['name'],
      // additionalProperties intentionally OPEN: guard-specific keys (patterns, rules, mask, per_day, ...)
      properties: {
        name: { type: 'string' },
        on_error: { enum: ['reject', 'degrade'] },
        timeout_ms: { type: 'integer', minimum: 1 },
        reject_template: { type: 'string' },
        route: { type: 'string' },
      },
      allOf: [
        {
          if: { required: ['name'], properties: { name: { const: 'limits' } } },
          then: {
            properties: {
              per_day: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hard_cap_usd: { type: 'number', minimum: 0 },
                  soft_warning_usd: { type: 'number', minimum: 0 },
                },
              },
            },
          },
        },
        {
          if: { required: ['name'], properties: { name: { const: 'judge' } } },
          then: {
            required: ['name', 'model', 'criteria'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              model: { type: 'string' },
              criteria: { type: 'string' },
              timeout_ms: { type: 'integer', minimum: 1 },
              on_error: { enum: ['reject', 'degrade'] },
              reject_template: { type: 'string' },
            },
          },
        },
      ],
    },
  },
} as const;

const validate = ajv.compile(schema);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function validateConfig(config: unknown): asserts config is GatewayConfig {
  if (!validate(config)) {
    const detail = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw new ConfigError(`Invalid gateway config: ${detail}`);
  }
}
