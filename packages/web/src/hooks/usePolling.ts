'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';

interface UsePollingOptions {
  enabled?: boolean;
  onError?: (err: Error) => void;
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
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options?.enabled ?? true;

  const doFetch = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}${url}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      optionsRef.current?.onError?.(e);
    } finally {
      if (!hasFetchedRef.current) {
        hasFetchedRef.current = true;
        setLoading(false);
      }
    }
  }, [url]);

  useEffect(() => {
    if (!enabled) return;

    hasFetchedRef.current = false;
    setLoading(true);
    void doFetch();

    const timer = setInterval(() => void doFetch(), intervalMs);
    return () => clearInterval(timer);
  }, [doFetch, intervalMs, enabled]);

  const refresh = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  return { data, loading, error, refresh };
}
