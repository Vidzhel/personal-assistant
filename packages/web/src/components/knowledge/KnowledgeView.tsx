'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { KnowledgeGraph } from '@/components/knowledge/KnowledgeGraph';
import { GraphControls } from '@/components/knowledge/GraphControls';
import { BubbleDetailPanel } from '@/components/knowledge/BubbleDetailPanel';
import { BulkActionBar } from '@/components/knowledge/BulkActionBar';
import { GraphChatPanel } from '@/components/knowledge/GraphChatPanel';
import { api } from '@/lib/api-client';

interface KnowledgeViewProps {
  projectId?: string;
}

function useGraphData(projectId: string | undefined, viewMode: string) {
  const { setGraphData, setLoading, clearProjectState } = useKnowledgeStore();
  const fetchRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const fetchGraph = useCallback(async () => {
    const id = ++fetchRef.current;
    setLoading(true);
    try {
      if (!projectId) {
        clearProjectState();
        return;
      }
      const data = await api.getKnowledgeGraph({ projectId, view: viewMode });
      if (id === fetchRef.current) {
        setGraphData(data.nodes, data.edges);
        setError(null);
      }
    } catch (cause) {
      if (id === fetchRef.current) {
        clearProjectState();
        setError(cause instanceof Error ? cause.message : 'Could not load knowledge.');
      }
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, [projectId, viewMode, clearProjectState, setGraphData, setLoading]);

  useEffect(() => {
    clearProjectState();
    setError(null);
  }, [projectId, clearProjectState]);

  useEffect(() => {
    void fetchGraph();
    return () => {
      fetchRef.current++;
    };
  }, [fetchGraph]);

  return { fetchGraph, error };
}

export function KnowledgeView({ projectId }: KnowledgeViewProps) {
  const { viewMode, selectedNodeIds } = useKnowledgeStore();
  const { fetchGraph, error } = useGraphData(projectId, viewMode);

  const showDetail = selectedNodeIds.length === 1;
  const showBulk = selectedNodeIds.length >= 2;

  return (
    <div className="flex flex-col h-full">
      {error && (
        <p role="alert" className="px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <GraphControls projectId={projectId} onRefetch={fetchGraph} />
      <div className="flex-1 min-h-0 relative">
        <KnowledgeGraph />
        {showBulk && <BulkActionBar onRefetch={fetchGraph} />}
        {showDetail && <BubbleDetailPanel onRefetch={fetchGraph} />}
        <GraphChatPanel projectId={projectId ?? null} onRefetch={fetchGraph} />
      </div>
    </div>
  );
}
