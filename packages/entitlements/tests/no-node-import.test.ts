import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Runtime-agnostic zone invariant (spec §10): src/** must never import a node: builtin.
// (Tests may use node:* — they are not part of the shipped runtime zone.)
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

describe('runtime-agnostic zone: no node:* in src', () => {
  it('no src file imports a node: builtin', () => {
    const offenders = tsFiles(SRC).filter((f) => /from\s+['"]node:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
