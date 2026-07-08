import { describe, it, expect } from 'vitest';
import { renderTemplate, renderNamed } from '../src/core/templates.js';

describe('templates', () => {
  it('substitutes trace_id_short with first 8 chars', () => {
    expect(renderTemplate('Code: {{trace_id_short}}', 'abcdefgh-1234')).toBe('Code: abcdefgh');
  });
  it('leaves text without the variable unchanged', () => {
    expect(renderTemplate('No vars here', 'xxxx')).toBe('No vars here');
  });
  it('renders by key from a templates map', () => {
    expect(renderNamed({ degrade: 'Down: {{trace_id_short}}' }, 'degrade', 'abcdefgh12')).toBe('Down: abcdefgh');
  });
  it('throws on missing key', () => {
    expect(() => renderNamed({}, 'nope', 'x')).toThrow();
  });
});
