import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { LimitsStore, DailyState } from '../core/types.js';

export function createFileLimitsStore(path: string): LimitsStore {
  return {
    async load(): Promise<DailyState | null> {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as DailyState;
    },
    async save(state: DailyState): Promise<void> {
      writeFileSync(path, JSON.stringify(state));
    },
  };
}
