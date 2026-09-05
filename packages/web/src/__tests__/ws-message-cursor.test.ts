import { describe, expect, it } from 'vitest';
import type { WsMessage } from '../lib/ws-client.ts';
import { consumeWsMessages } from '@/lib/ws-message-cursor';

// The buffer used by useWebSocket retains the previous 200 entries plus the newest message.
function append(buffer: WsMessage[], message: WsMessage): WsMessage[] {
  return [...buffer.slice(-200), message];
}

function assistantMessage(index: number): WsMessage {
  return {
    type: 'event',
    data: {
      type: 'agent:message',
      payload: { messageType: 'assistant', content: `Chunk ${index}`, messageId: `msg-${index}` },
    },
  };
}

const rejections: WsMessage[] = [
  {
    type: 'chat:error',
    data: { projectId: 'project-b', sessionId: 'session-a', error: 'Session not found' },
  },
  {
    type: 'event',
    data: {
      type: 'user:chat:rejected',
      payload: { projectId: 'project-b', sessionId: 'session-a', error: 'Session not found' },
    },
  },
];

describe('Chat consumption of a bounded WebSocket stream', () => {
  it.each(rejections)(
    'delivers rejection $type after 250 messages without replaying earlier events',
    (rejection) => {
      const cursor = { current: undefined as WsMessage | undefined };
      let buffer: WsMessage[] = [];
      const sent = Array.from({ length: 250 }, (_, index) => assistantMessage(index));
      const consumed: WsMessage[] = [];

      for (const message of sent) {
        buffer = append(buffer, message);
        consumed.push(...consumeWsMessages(buffer, cursor));
      }
      expect(buffer).toHaveLength(201);
      expect(consumed).toEqual(sent);

      buffer = append(buffer, rejection);
      expect(buffer).toHaveLength(201);
      expect(consumeWsMessages(buffer, cursor)).toEqual([rejection]);
      // A render without a new socket message must not repeat the rejection.
      expect(consumeWsMessages([...buffer], cursor)).toEqual([]);

      const next = assistantMessage(251);
      buffer = append(buffer, next);
      expect(consumeWsMessages(buffer, cursor)).toEqual([next]);
    },
  );

  it('consumes a batch once when several messages arrive between renders at capacity', () => {
    const cursor = { current: undefined as WsMessage | undefined };
    let buffer = Array.from({ length: 201 }, (_, index) => assistantMessage(index));
    consumeWsMessages(buffer, cursor);
    const batch = [assistantMessage(201), rejections[0], assistantMessage(202)];
    for (const message of batch) buffer = append(buffer, message);

    expect(consumeWsMessages(buffer, cursor)).toEqual(batch);
    expect(consumeWsMessages(buffer, cursor)).toEqual([]);
  });

  it('consumes all retained events if a paused consumer falls behind the buffer', () => {
    const cursor = { current: undefined as WsMessage | undefined };
    let buffer = [assistantMessage(0)];
    consumeWsMessages(buffer, cursor);
    for (let index = 1; index <= 250; index++) buffer = append(buffer, assistantMessage(index));
    buffer = append(buffer, rejections[0]);

    expect(consumeWsMessages(buffer, cursor)).toEqual(buffer);
    expect(consumeWsMessages(buffer, cursor)).toEqual([]);
  });

  it('consumes a replacement stream even when it is shorter than the old buffer', () => {
    const cursor = { current: undefined as WsMessage | undefined };
    consumeWsMessages([assistantMessage(0), assistantMessage(1)], cursor);

    expect(consumeWsMessages([rejections[0]], cursor)).toEqual([rejections[0]]);
    expect(consumeWsMessages([], cursor)).toEqual([]);
    expect(cursor.current).toBeUndefined();
  });
});
