export type NormalizeResult = { text: string; rulesApplied: string[]; reject?: { code: string } };

export function normalize(raw: string, maxInputChars: number | undefined): NormalizeResult {
  const text = raw.trim();
  const rulesApplied = ['trim'];
  if (text.length === 0) return { text, rulesApplied, reject: { code: 'E_NORMALIZE_EMPTY' } };
  if (maxInputChars !== undefined) {
    rulesApplied.push('length_cap');
    if (text.length > maxInputChars)
      return { text, rulesApplied, reject: { code: 'E_NORMALIZE_TOO_LONG' } };
  }
  return { text, rulesApplied };
}
