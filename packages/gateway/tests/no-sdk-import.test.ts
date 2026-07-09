import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Import-zone invariant (spec §3): the SDK lives only behind the ./anthropic subpath.
// Base entries (core/, index.ts, node.ts) must never import @anthropic-ai/sdk, value or type.

const SRC = join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('import zones: @anthropic-ai/sdk stays behind ./anthropic', () => {
  it('is never imported by core/, index.ts, or node.ts', () => {
    const base = tsFiles(SRC).filter((f) => !f.endsWith(join('src', 'anthropic.ts')));
    const offenders = base.filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
