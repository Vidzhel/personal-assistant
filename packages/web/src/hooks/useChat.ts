'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useWebSocket } from './useWebSocket';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export function useChat(projectId: string): {
  messages: ChatMessage[];
  sendMessage: (message: string) => void;
} {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const channels = useMemo(() => [`project:${projectId}`], [projectId]);
  const { messages: wsMessages, send } = useWebSocket(channels);

  useEffect(() => {
    for (const msg of wsMessages) {
      if (msg.type === 'event') {
        const event = msg.data as {
          type: string;
          payload?: { messageType?: string; content?: string; taskId?: string };
        };
        const content = event.payload?.content;
        const taskId = event.payload?.taskId;
        if (event.type === 'agent:message' && content) {
          setChatMessages((prev) => {
            const existing = prev.find((m) => m.role === 'assistant' && m.id === taskId);
            if (existing) {
              return prev.map((m) =>
                m.id === taskId ? { ...m, content: m.content + content } : m,
              );
            }
            return [
              ...prev,
              {
                id: taskId || crypto.randomUUID(),
                role: 'assistant' as const,
                content,
                timestamp: Date.now(),
              },
            ];
          });
        }
      }
    }
  }, [wsMessages]);

  const sendMessage = useCallback(
    (message: string) => {
      setChatMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: message, timestamp: Date.now() },
      ]);
      send({ type: 'chat:send', projectId, message });
    },
    [projectId, send],
  );

  return { messages: chatMessages, sendMessage };
}
