'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { WsClient, type WsMessage } from '@/lib/ws-client';

const WS_URL = process.env.NEXT_PUBLIC_CORE_WS_URL || 'ws://localhost:4001/ws';
const MESSAGE_BUFFER_OFFSET = -200;

export function useWebSocket(channels: string[]): {
  messages: WsMessage[];
  send: (msg: unknown) => void;
} {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const client = new WsClient(WS_URL);
    clientRef.current = client;

    const unsub = client.onMessage((msg) => {
      setMessages((prev) => [...prev.slice(MESSAGE_BUFFER_OFFSET), msg]);
    });

    client.connect(channels);

    return () => {
      unsub();
      client.disconnect();
    };
  }, [channels.join(',')]);

  const send = useCallback((msg: unknown) => {
    clientRef.current?.send(msg);
  }, []);

  return { messages, send };
}
