import type { WsMessage } from './ws-client.ts';

interface MessageCursor {
  current: WsMessage | undefined;
}

/** Consume a rolling buffer by message identity: its length stops growing at capacity. */
export function consumeWsMessages(
  messages: readonly WsMessage[],
  cursor: MessageCursor,
): WsMessage[] {
  const previousIndex = cursor.current ? messages.lastIndexOf(cursor.current) : -1;
  cursor.current = messages.at(-1);
  // If the previous message was evicted, consume every message still retained.
  return messages.slice(previousIndex + 1);
}
