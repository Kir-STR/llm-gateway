import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Import-zone invariant: provider/observability SDKs live only behind their subpaths.
// Base entries (core/, index.ts, node.ts) must import neither @anthropic-ai/sdk nor langfuse,
// value or type. anthropic.ts may import @anthropic-ai/sdk; langfuse.ts may import langfuse.

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

describe('import zones: provider/observability SDKs stay behind their subpaths', () => {
  it('@anthropic-ai/sdk is only imported by anthropic.ts', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('src', 'anthropic.ts')))
      .filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('langfuse is only imported by langfuse.ts', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('src', 'langfuse.ts')))
      .filter((f) => /from\s+['"]langfuse['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
