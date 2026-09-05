'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { EnrichedReference, ExternalRef } from '@/components/session/ReferencesPanel';
import { useWebSocket } from '@/hooks/useWebSocket';
import { apiRequest } from '@/lib/api-request';
import { extractUrls } from '@/lib/references';
import { consumeWsMessages } from '@/lib/ws-message-cursor';
import type { WsMessage } from '@/lib/ws-client';

interface ReferenceState {
  sessionId: string | null;
  references: Record<string, EnrichedReference[]>;
  externalRefs: ExternalRef[];
  loading: boolean;
}

async function fetchReferences(sessionId: string, signal: AbortSignal): Promise<ReferenceState> {
  const prefix = `/sessions/${encodeURIComponent(sessionId)}`;
  const [refs, messages] = await Promise.all([
    apiRequest<{ references: Record<string, EnrichedReference[]> }>(`${prefix}/references`, {
      signal,
    }).catch(() => null),
    apiRequest<Array<{ role: string; content: string }>>(`${prefix}/messages`, { signal }).catch(
      () => null,
    ),
  ]);
  return {
    sessionId,
    references: refs?.references ?? {},
    externalRefs: extractUrls(messages ?? []),
    loading: false,
  };
}

function relevantEvent(message: WsMessage, sessionId: string | null): boolean {
  if (message.type !== 'event' || !message.data || typeof message.data !== 'object') return false;
  const event = message.data as { type: string; payload?: { sessionId?: string } };
  return Boolean(
    sessionId &&
    event.payload?.sessionId === sessionId &&
    ['agent:message', 'agent:task:complete'].includes(event.type),
  );
}

export function useReferences(sessionId: string | null): ReferenceState {
  const [state, setState] = useState<ReferenceState>({
    sessionId,
    references: {},
    externalRefs: [],
    loading: false,
  });
  const request = useRef<AbortController | null>(null);
  const cursor = useRef<WsMessage | undefined>(undefined);
  const channels = useMemo(() => (sessionId ? ['global'] : []), [sessionId]);
  const { messages } = useWebSocket(channels);
  const refresh = useCallback(() => {
    if (!sessionId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void fetchReferences(sessionId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
  }, [sessionId]);
  useEffect(() => {
    cursor.current = messages.at(-1);
    setState({ sessionId, references: {}, externalRefs: [], loading: Boolean(sessionId) });
    refresh();
    return () => request.current?.abort();
  }, [sessionId, refresh]);
  useEffect(() => {
    if (consumeWsMessages(messages, cursor).some((message) => relevantEvent(message, sessionId)))
      refresh();
  }, [messages, sessionId, refresh]);
  return state.sessionId === sessionId
    ? state
    : { sessionId, references: {}, externalRefs: [], loading: Boolean(sessionId) };
}
