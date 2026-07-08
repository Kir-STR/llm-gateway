import type { GatewayConfig } from '../../src/core/config-schema.js';

export const neutralConfig: GatewayConfig = {
  version: '1.0.0',
  models: {
    cheap: { model: 'model-cheap', max_tokens: 1024, temperature: 0.3 },
    expensive: { model: 'model-expensive', max_tokens: 2500, temperature: 0.3 },
  },
  normalize: { max_input_chars: 4000 },
  guards: {
    input: [
      {
        name: 'injection',
        on_error: 'reject',
        timeout_ms: 50,
        patterns: [
          {
            id: 'ignore_prev',
            kind: 'substring',
            pattern: 'ignore previous',
            case_sensitive: false,
            severity: 'hard',
          },
        ],
      },
      {
        name: 'pii',
        on_error: 'reject',
        rules: ['ru_phone', 'email'],
        mask: { ru_phone: '[PHONE_MASKED]', email: '[EMAIL_MASKED]' },
        route: 'pii_short_circuit',
      },
      { name: 'limits', on_error: 'reject', per_day: { hard_cap_usd: 10, soft_warning_usd: 5 } },
    ],
    output: [
      {
        name: 'policy',
        on_error: 'degrade',
        rules: [
          { id: 'no_leak', kind: 'regex_deny', pattern: '(?i)system prompt', severity: 'hard' },
        ],
      },
    ],
  },
  limits: {
    per_request: { max_cost_usd: 0.15 },
    prices: {
      'model-cheap': { input: 1.0, output: 5.0 },
      'model-expensive': { input: 3.0, output: 15.0 },
    },
  },
  routing: {
    rules: [{ when: { flags_any: ['injection'] }, scenario: 'cautious' }, { default: 'main' }],
  },
  scenarios: {
    main: { kind: 'llm', model: 'expensive', structured_output: 'answer_v1' },
    cautious: { kind: 'llm', model: 'cheap' },
    pii_short_circuit: { kind: 'stub', template: 'pii_detected' },
  },
  structured_output: {
    answer_v1: {
      schema: {
        type: 'object',
        required: ['answer', 'confidence'],
        properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
      },
    },
  },
  retry: [
    { trigger: 'llm_transport_error', max_attempts: 2, backoff_ms: 250 },
    {
      trigger: 'structured_parse_failed',
      max_attempts: 1,
      correction_prompt: 'Reply strictly via the tool.',
    },
    {
      trigger: 'output_guard_rejected',
      max_attempts: 1,
      correction_prompt: 'Follow the policy strictly.',
      escalate_to_model: 'expensive',
    },
  ],
  templates: {
    llm_fail: 'Service temporarily unavailable. Code: {{trace_id_short}}',
    parse_fail: 'Could not process the reply. Code: {{trace_id_short}}',
    policy_reject: 'I cannot answer that directly. Code: {{trace_id_short}}',
    injection_reject: 'The request contains elements I cannot process.',
    normalize_reject: 'The message is too long or empty.',
    pii_detected: 'I do not store personal data.',
    degrade: 'Service is degraded, please try again later. Code: {{trace_id_short}}',
  },
};
