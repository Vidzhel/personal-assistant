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

export function KnowledgeView({ projectId }: KnowledgeViewProps) {
  const { viewMode, setGraphData, setLoading, selectedNodeIds } = useKnowledgeStore();
  const fetchRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const fetchGraph = useCallback(async () => {
    const id = ++fetchRef.current;
    setLoading(true);
    try {
      // TODO: backend /knowledge/graph doesn't support projectId filtering yet
      const data = await api.getKnowledgeGraph({ view: viewMode });
      if (id === fetchRef.current) {
        setGraphData(data.nodes, data.edges);
        setError(null);
      }
    } catch (cause) {
      if (id === fetchRef.current)
        setError(cause instanceof Error ? cause.message : 'Could not load knowledge.');
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, [viewMode, setGraphData, setLoading]);

  useEffect(() => {
    void fetchGraph();
    return () => {
      fetchRef.current++;
    };
  }, [fetchGraph]);

  const showDetail = selectedNodeIds.length === 1;
  const showBulk = selectedNodeIds.length >= 2;

  return (
    <div className="flex flex-col h-full">
      {error && (
        <p role="alert" className="px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <GraphControls onRefetch={fetchGraph} />
      <div className="flex-1 min-h-0 relative">
        <KnowledgeGraph />
        {showBulk && <BulkActionBar onRefetch={fetchGraph} />}
        {showDetail && <BubbleDetailPanel onRefetch={fetchGraph} />}
        <GraphChatPanel projectId={projectId ?? null} onRefetch={fetchGraph} />
      </div>
    </div>
  );
}
