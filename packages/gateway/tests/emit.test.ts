import { describe, it, expect, vi } from 'vitest';
import { makeEmitter } from '../src/core/emit.js';

describe('makeEmitter', () => {
  it('emits an event with traceId and configVersion', () => {
    const events: unknown[] = [];
    const emit = makeEmitter({ event: (e) => events.push(e) }, '1.0.0', 'trace-1');
    emit('turn_started', { inputLen: 5 });
    expect(events).toEqual([{ event: 'turn_started', traceId: 'trace-1', configVersion: '1.0.0', data: { inputLen: 5 } }]);
  });
  it('swallows sink errors', () => {
    const emit = makeEmitter({ event: () => { throw new Error('sink down'); } }, '1.0.0', 't');
    expect(() => emit('x', {})).not.toThrow();
  });
});
