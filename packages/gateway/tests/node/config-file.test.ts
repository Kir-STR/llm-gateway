import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFile } from '../../src/node/config-file.js';

describe('loadConfigFile', () => {
  it('parses YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'));
    const p = join(dir, 'c.yaml');
    writeFileSync(p, 'version: 1.0.0\nmodels: {}\n');
    expect(loadConfigFile(p)).toEqual({ version: '1.0.0', models: {} });
  });
  it('parses JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'));
    const p = join(dir, 'c.json');
    writeFileSync(p, '{"version":"1.0.0"}');
    expect(loadConfigFile(p)).toEqual({ version: '1.0.0' });
  });
});
