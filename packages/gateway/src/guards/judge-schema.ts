import { makeStructuredValidator, type StructuredResult } from '../core/structured.js';

// Core-owned verdict schema — the judge mechanism is fixed by the core, not the config.
export const JUDGE_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision'],
  properties: {
    decision: { enum: ['pass', 'degrade', 'reject'] },
    reason: { type: 'string' },
  },
} as const;

export const validateJudgeVerdict: (value: unknown) => StructuredResult =
  makeStructuredValidator(JUDGE_VERDICT_SCHEMA as object);
