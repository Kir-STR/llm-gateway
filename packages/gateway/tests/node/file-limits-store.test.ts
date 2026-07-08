import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLimitsStore } from '../../src/node/file-limits-store.js';

describe('createFileLimitsStore', () => {
  it('returns null when the file is absent', async () => {
    const store = createFileLimitsStore(join(mkdtempSync(join(tmpdir(), 'gw-')), 'limits.json'));
    expect(await store.load()).toBeNull();
  });
  it('round-trips state', async () => {
    const store = createFileLimitsStore(join(mkdtempSync(join(tmpdir(), 'gw-')), 'limits.json'));
    const state = { date: '2026-07-08', costUsd: 1.5, requestCount: 2 };
    await store.save(state);
    expect(await store.load()).toEqual(state);
  });
});
