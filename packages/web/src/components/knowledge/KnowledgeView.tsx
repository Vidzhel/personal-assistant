'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { KnowledgeGraph } from './KnowledgeGraph';
import { GraphControls } from './GraphControls';
import { BubbleDetailPanel } from './BubbleDetailPanel';
import { BulkActionBar } from './BulkActionBar';
import { GraphChatPanel } from './GraphChatPanel';
import { api } from '@/lib/api-client';

interface KnowledgeViewProps {
  projectId?: string;
}

export function KnowledgeView({ projectId }: KnowledgeViewProps) {
  const { viewMode, setGraphData, setLoading, selectedNodeIds } = useKnowledgeStore();
  const fetchRef = useRef(0);

  const fetchGraph = useCallback(async () => {
    const id = ++fetchRef.current;
    setLoading(true);
    try {
      const data = await api.getKnowledgeGraph({ view: viewMode });
      if (id === fetchRef.current) {
        setGraphData(data.nodes, data.edges);
      }
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, [viewMode, setGraphData, setLoading]);

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  const showDetail = selectedNodeIds.length === 1;
  const showBulk = selectedNodeIds.length >= 2;

  return (
    <div className="flex flex-col h-full">
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
