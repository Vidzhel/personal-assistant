'use client';

import { useEffect, useRef, useState } from 'react';
import type { ModelCatalogSnapshot } from '@raven/shared';
import { api } from '@/lib/api-client';

interface ModelCatalogState {
  catalog?: ModelCatalogSnapshot;
  loading: boolean;
  error?: string;
  refresh: () => void;
}

export function useModelCatalog(onLoaded?: () => void): ModelCatalogState {
  const [request, setRequest] = useState({ generation: 0, refresh: false });
  const [state, setState] = useState<Omit<ModelCatalogState, 'refresh'>>({ loading: true });
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: undefined }));
    void api
      .getModels({ refresh: request.refresh, signal: controller.signal })
      .then((catalog) => {
        setState({ catalog, loading: false });
        if (!catalog.error) onLoadedRef.current?.();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load the model catalog.',
        });
      });
    return () => controller.abort();
  }, [request]);

  return {
    ...state,
    refresh: () => setRequest((current) => ({ generation: current.generation + 1, refresh: true })),
  };
}
