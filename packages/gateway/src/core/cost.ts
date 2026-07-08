export type Prices = Record<string, { input: number; output: number }>;
export type Usage = {
  inputTokens: number; outputTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number;
};

function priceOf(model: string, prices: Prices): { input: number; output: number } {
  const p = prices[model];
  if (!p) throw new Error(`No price entry for model "${model}"`);
  return p;
}

export function actualCostUsd(model: string, usage: Usage, prices: Prices): number {
  const p = priceOf(model, prices);
  const cacheRead = (usage.cacheReadTokens ?? 0) * (p.input * 0.1);
  const cacheWrite = (usage.cacheWriteTokens ?? 0) * (p.input * 1.25);
  return (usage.inputTokens * p.input + usage.outputTokens * p.output + cacheRead + cacheWrite) / 1_000_000;
}

export function worstCaseCostUsd(
  model: string, inputChars: number, maxOutputTokens: number, prices: Prices,
): number {
  const p = priceOf(model, prices);
  const inTok = Math.ceil(inputChars / 4);
  return (inTok * p.input + maxOutputTokens * p.output) / 1_000_000;
}
