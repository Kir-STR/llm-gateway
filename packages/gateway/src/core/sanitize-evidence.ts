export type EvidencePolicy = 'omit' | 'safe' | 'full';

const STRING_SENTINEL = '[omitted:string]';
const DEPTH_SENTINEL = '[omitted:depth]';
const SIZE_SENTINEL = '[omitted:size]';
const MAX_DEPTH = 4;
const MAX_NODES = 64;

// safe: keep structural primitives (bool/number/null), redact string free-text to a fixed
// sentinel (shape preserved, no content), strip non-serializable values, cap depth/size.
// Object KEYS are preserved (not sanitized) — see the design spec §2 guarantee boundary.
export function sanitizeEvidence(evidence: unknown, policy: EvidencePolicy): unknown {
  if (policy === 'full') return evidence;
  if (policy === 'omit') return undefined;
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES) return SIZE_SENTINEL;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'boolean' || t === 'number') return v;
    if (t === 'string') return STRING_SENTINEL;
    if (t !== 'object') return undefined; // undefined, function, symbol, bigint
    if (depth >= MAX_DEPTH) return DEPTH_SENTINEL;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const sv = walk((v as Record<string, unknown>)[k], depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  };
  return walk(evidence, 0);
}
