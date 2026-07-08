import type { PatternRule } from './config-schema.js';

export type PatternHit = { id: string; severity: 'hard' | 'soft' };

export function matchPatterns(rules: PatternRule[], text: string): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const rule of rules) {
    if (matchesRule(rule, text)) hits.push({ id: rule.id, severity: rule.severity });
  }
  return hits;
}

function matchesRule(rule: PatternRule, text: string): boolean {
  if (rule.kind === 'substring') {
    const cs = rule.case_sensitive ?? false;
    return cs ? text.includes(rule.pattern) : text.toLowerCase().includes(rule.pattern.toLowerCase());
  }
  const flags = rule.case_sensitive ? '' : 'i';
  return new RegExp(rule.pattern, flags).test(text);
}
