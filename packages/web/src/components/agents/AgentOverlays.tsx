'use client';

import { useAgentStore } from '@/stores/agent-store';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import { AgentTaskHistory } from '@/components/agents/AgentTaskHistory';
import { AgentMemoryPanel } from '@/components/agents/AgentMemoryPanel';

/** The agents page's modal/panel overlays, grouped so the page component
 * itself only needs to know they exist, not which store flags drive them. */
export function AgentOverlays() {
  const { showForm, showTaskHistory, showMemory } = useAgentStore();

  return (
    <>
      {showForm && <AgentFormModal />}
      {showTaskHistory && <AgentTaskHistory />}
      {showMemory && <AgentMemoryPanel />}
    </>
  );
}
