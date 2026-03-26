'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { KnowledgeView } from '@/components/knowledge/KnowledgeView';
import { api } from '@/lib/api-client';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useState } from 'react';

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

export default function KnowledgePage() {
  const { setHighlightedNodeIds } = useKnowledgeStore();
  const projectId = useFirstProjectId();
  const searchParams = useSearchParams();

  useEffect(() => {
    const highlight = searchParams.get('highlight');
    if (highlight) {
      setHighlightedNodeIds(highlight.split(',').filter(Boolean));
    } else {
      setHighlightedNodeIds([]);
    }
  }, [searchParams, setHighlightedNodeIds]);

  return <KnowledgeView projectId={projectId ?? undefined} />;
}
