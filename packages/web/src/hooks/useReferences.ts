'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { EnrichedReference, ExternalRef } from '@/components/session/ReferencesPanel';
import { useWebSocket } from './useWebSocket';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

interface ReferencesApiResponse {
  references: Record<
    string,
    Array<{
      bubbleId: string;
      title: string;
      snippet: string;
      score: number;
      tags: string[];
      domains: string[];
      permanence: string;
    }>
  >;
}

interface StoredMessage {
  role: string;
  content: string;
}

function extractUrls(messages: StoredMessage[]): ExternalRef[] {
  const urls = new Map<string, ExternalRef>();
  for (const msg of messages.filter((m) => m.role === 'assistant')) {
    for (const match of msg.content.matchAll(MARKDOWN_LINK_REGEX)) {
      try {
        urls.set(match[2], { url: match[2], label: match[1], domain: new URL(match[2]).hostname });
      } catch {
        /* invalid URL */
      }
    }
    for (const match of msg.content.matchAll(URL_REGEX)) {
      if (!urls.has(match[0])) {
        try {
          urls.set(match[0], { url: match[0], label: null, domain: new URL(match[0]).hostname });
        } catch {
          /* invalid URL */
        }
      }
    }
  }
  return [...urls.values()];
}

interface UseReferencesResult {
  references: Record<string, EnrichedReference[]>;
  externalRefs: ExternalRef[];
  loading: boolean;
}

// eslint-disable-next-line max-lines-per-function -- hook managing API fetch, URL extraction, and WebSocket updates
export function useReferences(sessionId: string | null): UseReferencesResult {
  const [references, setReferences] = useState<Record<string, EnrichedReference[]>>({});
  const [externalRefs, setExternalRefs] = useState<ExternalRef[]>([]);
  const [loading, setLoading] = useState(false);
  const channels = useMemo(() => (sessionId ? ['project:*'] : []), [sessionId]);
  const { messages: wsMessages } = useWebSocket(channels);
  const processedWsRef = useRef(0);

  const fetchData = useCallback(
    (sid: string): Promise<void> =>
      Promise.all([
        fetch(`${API_URL}/sessions/${sid}/references`)
          .then((res) => (res.ok ? (res.json() as Promise<ReferencesApiResponse>) : null))
          .catch(() => null),
        fetch(`${API_URL}/sessions/${sid}/messages`)
          .then((res) => (res.ok ? (res.json() as Promise<StoredMessage[]>) : null))
          .catch(() => null),
      ]).then(([refsData, messagesData]) => {
        if (refsData) {
          setReferences(refsData.references as Record<string, EnrichedReference[]>);
        }
        if (messagesData) {
          setExternalRefs(extractUrls(messagesData));
        }
      }),
    [],
  );

  useEffect(() => {
    if (!sessionId) {
      setReferences({});
      setExternalRefs([]);
      return;
    }
    setLoading(true);
    fetchData(sessionId).finally(() => setLoading(false));
  }, [sessionId, fetchData]);

  // Listen for real-time context messages via WebSocket
  useEffect(() => {
    const newMessages = wsMessages.slice(processedWsRef.current);
    processedWsRef.current = wsMessages.length;

    for (const msg of newMessages) {
      if (msg.type === 'event') {
        const event = msg.data as {
          type: string;
          payload?: { messageType?: string };
        };
        if (event.type === 'agent:message' && event.payload?.messageType === 'context') {
          if (sessionId) fetchData(sessionId);
        }
      }
    }
  }, [wsMessages, sessionId, fetchData]);

  return { references, externalRefs, loading };
}
