import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '@/lib/ws-client';

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    FakeSocket.sockets.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  finishClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.sockets = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WebSocket ownership and send acknowledgement', () => {
  it('reports a disconnected send and sends subscriptions before a connected message', () => {
    const client = new WsClient('ws://fixture.invalid');
    expect(client.send({ type: 'chat:send' })).toBe(false);
    client.connect(['project:parent/child']);
    expect(client.send({ type: 'chat:send' })).toBe(false);
    const socket = FakeSocket.sockets[0];
    socket.open();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', channels: ['project:parent/child'] }),
    );
    expect(client.send({ type: 'chat:send', message: 'Hello' })).toBe(true);
    socket.send.mockImplementation(() => {
      throw new Error('Closed during send');
    });
    expect(client.send({ type: 'chat:send' })).toBe(false);
    client.disconnect();
  });

  it('never reconnects when a delayed close arrives after intentional disconnect', () => {
    const client = new WsClient('ws://fixture.invalid');
    client.connect(['global']);
    const socket = FakeSocket.sockets[0];
    client.disconnect();
    socket.finishClose();
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.sockets).toHaveLength(1);
    expect(client.send({})).toBe(false);
  });

  it('reconnects an unexpected close once, and cancels pending reconnect on cleanup', () => {
    const client = new WsClient('ws://fixture.invalid');
    const states: string[] = [];
    client.onState((state) => states.push(state));
    client.connect(['global']);
    client.connect(['global']);
    expect(FakeSocket.sockets).toHaveLength(1);
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].finishClose();
    vi.advanceTimersByTime(3_000);
    expect(FakeSocket.sockets).toHaveLength(2);
    FakeSocket.sockets[1].finishClose();
    client.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.sockets).toHaveLength(2);
    expect(states).toContain('connected');
    expect(states).toContain('disconnected');
  });

  it('ignores late events from an obsolete socket after a new connection exists', () => {
    const client = new WsClient('ws://fixture.invalid');
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect(['project:a']);
    const obsolete = FakeSocket.sockets[0];
    client.disconnect();
    client.connect(['project:b']);
    obsolete.open();
    obsolete.onmessage?.({ data: JSON.stringify({ type: 'event', data: { content: 'stale' } }) });
    obsolete.finishClose();
    expect(obsolete.send).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(FakeSocket.sockets).toHaveLength(2);
    client.disconnect();
  });
});
