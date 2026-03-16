'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

export interface SSEEvent {
  event: string;
  data: unknown;
}

interface UseSSEOptions {
  onMessage?: (event: SSEEvent) => void;
  onComplete?: (event: SSEEvent) => void;
  onError?: (err: Event) => void;
}

interface UseSSEResult {
  connected: boolean;
  lastEvent: SSEEvent | null;
  close: () => void;
}

// eslint-disable-next-line max-lines-per-function -- hook with EventSource setup, event listeners, and cleanup
export function useSSE(url: string | null, options?: UseSSEOptions): UseSSEResult {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);

  const close = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (mountedRef.current) {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!url) {
      close();
      return;
    }

    const fullUrl = `${API_URL}${url}`;
    const es = new EventSource(fullUrl);
    esRef.current = es;

    es.onopen = () => {
      if (mountedRef.current) setConnected(true);
    };

    const parseEventData = (raw: string): unknown => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    };

    es.addEventListener('agent-output', (e: MessageEvent) => {
      const sseEvent: SSEEvent = { event: 'agent-output', data: parseEventData(e.data as string) };
      if (mountedRef.current) setLastEvent(sseEvent);
      optionsRef.current?.onMessage?.(sseEvent);
    });

    es.addEventListener('agent-complete', (e: MessageEvent) => {
      const sseEvent: SSEEvent = {
        event: 'agent-complete',
        data: parseEventData(e.data as string),
      };
      if (mountedRef.current) setLastEvent(sseEvent);
      optionsRef.current?.onComplete?.(sseEvent);
      es.close();
      esRef.current = null;
      if (mountedRef.current) setConnected(false);
    });

    es.addEventListener('agent-error', (e: MessageEvent) => {
      const sseEvent: SSEEvent = { event: 'agent-error', data: parseEventData(e.data as string) };
      if (mountedRef.current) setLastEvent(sseEvent);
    });

    es.onerror = (e: Event) => {
      optionsRef.current?.onError?.(e);
    };

    return () => {
      mountedRef.current = false;
      es.close();
      esRef.current = null;
    };
  }, [url, close]);

  return { connected, lastEvent, close };
}
