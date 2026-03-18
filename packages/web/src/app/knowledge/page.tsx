'use client';

import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { KnowledgeGraph } from '@/components/knowledge/KnowledgeGraph';
import { GraphControls } from '@/components/knowledge/GraphControls';
import { BubbleDetailPanel } from '@/components/knowledge/BubbleDetailPanel';
import { BulkActionBar } from '@/components/knowledge/BulkActionBar';
import { GraphChatPanel } from '@/components/knowledge/GraphChatPanel';
import { api } from '@/lib/api-client';
import { useWebSocket } from '@/hooks/useWebSocket';

const WS_CHANNELS = ['global'];

function useFirstProjectId(): string | null {
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    api
      .getProjects()
      .then((projects) => {
        if (projects.length > 0) setProjectId(projects[0].id);
      })
      .catch(() => {
        /* no projects available */
      });
  }, []);
  return projectId;
}

function useWsRefetch(fetchGraph: () => void): void {
  const channels = useMemo(() => WS_CHANNELS, []);
  const { messages } = useWebSocket(channels);
  const lastMsgCount = useRef(0);

  useEffect(() => {
    if (messages.length > lastMsgCount.current) {
      lastMsgCount.current = messages.length;
      void fetchGraph();
    }
  }, [messages.length, fetchGraph]);
}

export default function KnowledgePage() {
  const { viewMode, setGraphData, setLoading, selectedNodeIds } = useKnowledgeStore();
  const fetchRef = useRef(0);
  const projectId = useFirstProjectId();

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

  useWsRefetch(fetchGraph);

  const showDetail = selectedNodeIds.length === 1;
  const showBulk = selectedNodeIds.length >= 2;

  return (
    <div className="flex flex-col h-full">
      <GraphControls onRefetch={fetchGraph} />
      <div className="flex flex-1 min-h-0 relative">
        <div className="flex-1 relative">
          <KnowledgeGraph />
          {showBulk && <BulkActionBar onRefetch={fetchGraph} />}
        </div>
        {showDetail && <BubbleDetailPanel onRefetch={fetchGraph} />}
        <GraphChatPanel projectId={projectId} onRefetch={fetchGraph} />
      </div>
    </div>
  );
}
