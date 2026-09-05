'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '@/lib/api-request';

interface UsePollingOptions {
  enabled?: boolean;
  onError?: (err: Error) => void;
}

interface PollingState<T> {
  url: string;
  data: T | null;
  loading: boolean;
  error: Error | null;
}

interface UsePollingResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function usePolling<T>(
  url: string,
  intervalMs: number,
  options?: UsePollingOptions,
): UsePollingResult<T> {
  const [state, setState] = useState<PollingState<T>>({
    url,
    data: null,
    loading: true,
    error: null,
  });
  const requestRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const enabled = options?.enabled ?? true;
  const refresh = useCallback(() => {
    if (!enabled) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void apiRequest<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ url, data, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState((previous) => ({ ...previous, url, error, loading: false }));
        optionsRef.current?.onError?.(error);
      })
      .finally(() => {
        if (requestRef.current === controller) requestRef.current = null;
      });
  }, [url, enabled]);
  useEffect(() => {
    setState({ url, data: null, error: null, loading: enabled });
    if (!enabled) return;
    refresh();
    const timer = setInterval(() => {
      if (!requestRef.current) refresh();
    }, intervalMs);
    return () => {
      clearInterval(timer);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [url, intervalMs, enabled, refresh]);
  const current = state.url === url ? state : { data: null, error: null, loading: enabled };
  return { data: current.data, error: current.error, loading: current.loading, refresh };
}
