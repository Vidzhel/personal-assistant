'use client';

import { useState } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { ChatPanel } from '@/components/chat/ChatPanel';

function useGraphChatContext() {
  const selectedNodeIds = useKnowledgeStore((state) => state.selectedNodeIds);
  const nodes = useKnowledgeStore((state) => state.nodes);
  const selectedTitles = selectedNodeIds
    .map((id) => nodes.find((node) => node.id === id)?.title)
    .filter(Boolean);
  const messagePrefix = selectedTitles.length
    ? `[Knowledge graph context — selected nodes: ${selectedTitles.join(', ')}]\n\n`
    : '[Knowledge graph context]\n\n';
  return { count: selectedNodeIds.length, messagePrefix };
}

export function GraphChatPanel({
  projectId,
  onRefetch,
}: {
  projectId: string | null;
  onRefetch: () => void;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const { count, messagePrefix } = useGraphChatContext();
  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="absolute bottom-4 right-4 px-3 py-2 rounded-lg shadow-lg text-xs z-30"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          Chat
        </button>
      )}
      {open !== null && (
        <div
          className={`absolute top-0 z-20 w-80 h-full flex-col shadow-xl ${open ? 'flex' : 'hidden'} ${count === 1 ? 'right-80' : 'right-0'}`}
          style={{ background: 'var(--bg)' }}
        >
          <GraphChatHeader count={count} onClose={() => setOpen(false)} />
          <div className="flex-1 min-h-0">
            {projectId ? (
              <ChatPanel
                projectId={projectId}
                messagePrefix={messagePrefix}
                onTaskComplete={onRefetch}
              />
            ) : (
              <p role="status" className="p-3 text-sm">
                Create a project to start a knowledge conversation.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function GraphChatHeader({ count, onClose }: { count: number; onClose: () => void }) {
  return (
    <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">Knowledge Chat</span>
        <button onClick={onClose} className="text-xs px-2 py-0.5 rounded">
          Close
        </button>
      </div>
      {count > 0 && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Context: {count} node{count !== 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  );
}
