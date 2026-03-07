'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWebSocket } from './useWebSocket';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:3001/api';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'thinking';
  content: string;
  timestamp: number;
  taskId?: string;
  toolName?: string;
  toolSummary?: string;
}

export function useChat(projectId: string): {
  messages: ChatMessage[];
  sendMessage: (message: string) => void;
  sessionId: string | null;
  loading: boolean;
} {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const initializedRef = useRef(false);
  const channels = useMemo(() => [`project:${projectId}`], [projectId]);
  const { messages: wsMessages, send } = useWebSocket(channels);

  // On mount: get/create active session & load history
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    async function init(): Promise<void> {
      try {
        const res = await fetch(`${API_URL}/projects/${projectId}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('Failed to get session');
        const session = (await res.json()) as { id: string };
        setSessionId(session.id);

        const msgRes = await fetch(`${API_URL}/sessions/${session.id}/messages`);
        if (msgRes.ok) {
          const history = (await msgRes.json()) as ChatMessage[];
          setChatMessages(history);
        }
      } catch {
        // Fallback: work without session persistence
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [projectId]);

  // Handle incoming WebSocket messages
  useEffect(() => {
    for (const msg of wsMessages) {
      if (msg.type === 'event') {
        const event = msg.data as {
          type: string;
          payload?: {
            messageType?: string;
            content?: string;
            taskId?: string;
          };
        };
        const content = event.payload?.content;
        const taskId = event.payload?.taskId;
        const messageType = event.payload?.messageType;

        if (event.type === 'agent:message' && content) {
          if (messageType === 'tool_use') {
            // Tool use messages: parse toolName from content
            const colonIdx = content.indexOf(':');
            const toolName = colonIdx > 0 ? content.slice(0, colonIdx).trim() : undefined;
            const toolSummary = colonIdx > 0 ? content.slice(colonIdx + 1).trim() : content;
            setChatMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'action' as const,
                content,
                timestamp: Date.now(),
                taskId,
                toolName,
                toolSummary,
              },
            ]);
          } else if (messageType === 'thinking') {
            setChatMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'thinking' as const,
                content,
                timestamp: Date.now(),
                taskId,
              },
            ]);
          } else {
            // Assistant text — append to existing or create new
            setChatMessages((prev) => {
              const existing = prev.find((m) => m.role === 'assistant' && m.taskId === taskId);
              if (existing) {
                return prev.map((m) =>
                  m === existing ? { ...m, content: m.content + content } : m,
                );
              }
              return [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content,
                  timestamp: Date.now(),
                  taskId,
                },
              ];
            });
          }
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
      send({ type: 'chat:send', projectId, message, sessionId });
    },
    [projectId, sessionId, send],
  );

  return { messages: chatMessages, sendMessage, sessionId, loading };
}
