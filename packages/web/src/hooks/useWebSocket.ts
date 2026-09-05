'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { WsClient, type WsMessage, type ConnectionState } from '@/lib/ws-client';

import { CORE_WS_URL as WS_URL } from '@/lib/core-endpoints';
const MESSAGE_BUFFER_OFFSET = -200;

export function useWebSocket(channels: string[]): {
  messages: WsMessage[];
  send: (msg: unknown) => boolean;
  connection: ConnectionState;
} {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const clientRef = useRef<WsClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const client = new WsClient(WS_URL);
    clientRef.current = client;
    setMessages([]);
    const unsubscribeState = client.onState(setConnection);

    const unsub = client.onMessage((msg) => {
      setMessages((prev) => [...prev.slice(MESSAGE_BUFFER_OFFSET), msg]);
    });

    client.connect(channels);

    return () => {
      unsub();
      unsubscribeState();
      client.disconnect();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [channels.join(',')]);

  const send = useCallback((msg: unknown) => {
    return clientRef.current?.send(msg) ?? false;
  }, []);

  return { messages, send, connection };
}
