import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';

function makeEvent(type: string, overrides: Partial<RavenEvent> = {}): RavenEvent {
  return {
    id: 'test-id',
    timestamp: Date.now(),
    source: 'test',
    type,
    payload: {},
    ...overrides,
  } as unknown as RavenEvent;
}

describe('EventBus', () => {
  it('emits and receives typed events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('user:chat:message', handler);

    const event = makeEvent('user:chat:message');
    bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('wildcard * listener receives all events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('*', handler);

    const e1 = makeEvent('user:chat:message');
    const e2 = makeEvent('email:new');
    bus.emit(e1);
    bus.emit(e2);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(e1);
    expect(handler).toHaveBeenCalledWith(e2);
  });

  it('off() removes handlers', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('user:chat:message', handler);
    bus.off('user:chat:message', handler);

    bus.emit(makeEvent('user:chat:message'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('once() fires only once', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.once('user:chat:message', handler);

    bus.emit(makeEvent('user:chat:message'));
    bus.emit(makeEvent('user:chat:message'));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('multiple listeners on same event type', () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('email:new', handler1);
    bus.on('email:new', handler2);

    bus.emit(makeEvent('email:new'));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners clears specific event type', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('email:new', handler);
    bus.removeAllListeners('email:new');

    bus.emit(makeEvent('email:new'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAllListeners with no args clears everything', () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('email:new', handler1);
    bus.on('user:chat:message', handler2);
    bus.removeAllListeners();

    bus.emit(makeEvent('email:new'));
    bus.emit(makeEvent('user:chat:message'));
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });
});
