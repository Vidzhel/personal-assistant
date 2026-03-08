'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWebSocket } from './useWebSocket';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'thinking';
  content: string;
  timestamp: number;
  taskId?: string;
  toolName?: string;
  toolSummary?: string;
}

interface UseChatOptions {
  projectId: string;
  sessionId?: string | null;
}

export function useChat(opts: UseChatOptions): {
  messages: ChatMessage[];
  sendMessage: (message: string) => void;
  sessionId: string | null;
  loading: boolean;
} {
  const { projectId, sessionId: externalSessionId } = opts;
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(externalSessionId ?? null);
  const [loading, setLoading] = useState(true);
  const initializedRef = useRef(false);
  const channels = useMemo(() => [`project:${projectId}`], [projectId]);
  const { messages: wsMessages, send } = useWebSocket(channels);

  // Sync external sessionId changes (e.g. session switch)
  useEffect(() => {
    if (externalSessionId !== undefined && externalSessionId !== sessionId) {
      setSessionId(externalSessionId);
      initializedRef.current = false;
    }
  }, [externalSessionId, sessionId]);

  // On mount or session change: load history
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    async function init(): Promise<void> {
      try {
        let sid = externalSessionId;
        if (!sid) {
          const res = await fetch(`${API_URL}/projects/${projectId}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          if (!res.ok) throw new Error('Failed to get session');
          const session = (await res.json()) as { id: string };
          sid = session.id;
          setSessionId(sid);
        }

        const msgRes = await fetch(`${API_URL}/sessions/${sid}/messages`);
        if (msgRes.ok) {
          const history = (await msgRes.json()) as ChatMessage[];
          setChatMessages(history);
        } else {
          setChatMessages([]);
        }
      } catch {
        // Fallback: work without session persistence
        setChatMessages([]);
      } finally {
        setLoading(false);
      }
    }

    setLoading(true);
    init();
  }, [projectId, externalSessionId]);

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
            messageId?: string;
          };
        };
        const content = event.payload?.content;
        const taskId = event.payload?.taskId;
        const messageType = event.payload?.messageType;
        const messageId = event.payload?.messageId;

        if (event.type === 'agent:message' && content) {
          if (messageType === 'tool_use') {
            const colonIdx = content.indexOf(':');
            const toolName = colonIdx > 0 ? content.slice(0, colonIdx).trim() : undefined;
            const toolSummary = colonIdx > 0 ? content.slice(colonIdx + 1).trim() : content;
            setChatMessages((prev) => {
              if (messageId && prev.some((m) => m.id === messageId)) return prev;
              return [
                ...prev,
                {
                  id: messageId ?? crypto.randomUUID(),
                  role: 'action' as const,
                  content,
                  timestamp: Date.now(),
                  taskId,
                  toolName,
                  toolSummary,
                },
              ];
            });
          } else if (messageType === 'thinking') {
            setChatMessages((prev) => {
              if (messageId && prev.some((m) => m.id === messageId)) return prev;
              return [
                ...prev,
                {
                  id: messageId ?? crypto.randomUUID(),
                  role: 'thinking' as const,
                  content,
                  timestamp: Date.now(),
                  taskId,
                },
              ];
            });
          } else {
            setChatMessages((prev) => {
              if (messageId && prev.some((m) => m.id === messageId)) return prev;
              const existing = prev.find((m) => m.role === 'assistant' && m.taskId === taskId);
              if (existing) {
                return prev.map((m) =>
                  m === existing ? { ...m, content: m.content + content } : m,
                );
              }
              return [
                ...prev,
                {
                  id: messageId ?? crypto.randomUUID(),
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
