import type { GatewayConfig } from './config-schema.js';

export type RouteResult = { scenario: string; matchedRule: string };

export function selectScenario(
  routing: GatewayConfig['routing'],
  flags: string[],
  forcedRoute?: string,
): RouteResult {
  if (forcedRoute) return { scenario: forcedRoute, matchedRule: 'forced' };
  const rules = routing.rules;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (rule.when?.flags_any?.some((f) => flags.includes(f)) && rule.scenario) {
      return { scenario: rule.scenario, matchedRule: `rule[${i}]` };
    }
  }
  const def = rules.find((r) => r.default !== undefined);
  if (def?.default) return { scenario: def.default, matchedRule: 'default' };
  throw new Error('routing has no matching rule and no default');
}
