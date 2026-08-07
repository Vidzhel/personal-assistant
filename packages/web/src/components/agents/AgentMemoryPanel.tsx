'use client';

import { useAgentStore } from '@/stores/agent-store';
import type { AgentMemoryFile } from '@/lib/api-client';

/** Distinct from an empty list: a fetch failure must never render as "this
 * agent simply has no memory yet." */
function MemoryPanelBody({ error, files }: { error: string | null; files: AgentMemoryFile[] }) {
  if (error) {
    return (
      <p className="text-sm" style={{ color: 'var(--error)' }}>
        Could not load memory: {error}
      </p>
    );
  }
  if (files.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No memory files yet.
      </p>
    );
  }
  return (
    <>
      {files.map((file) => (
        <div
          key={file.file}
          className="rounded border p-3 text-xs space-y-1"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="font-medium">{file.file}</div>
          <pre className="whitespace-pre-wrap font-sans" style={{ color: 'var(--text-muted)' }}>
            {file.content}
          </pre>
        </div>
      ))}
    </>
  );
}

export function AgentMemoryPanel() {
  const { showMemory, selectedAgentMemory, selectedAgentMemoryError, agents, closeMemoryPanel } =
    useAgentStore();
  const agent = agents.find((a) => a.id === showMemory);

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-96 border-l shadow-lg overflow-y-auto"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
    >
      <div
        className="p-4 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <h3 className="font-semibold text-sm">Memory: {agent?.name ?? 'Unknown'}</h3>
        <button
          onClick={closeMemoryPanel}
          className="text-sm px-2 py-1 rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>

      <div className="p-4 space-y-3">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          What this agent actually remembers — read-only, git-committed, human-editable on disk.
        </p>
        <MemoryPanelBody error={selectedAgentMemoryError} files={selectedAgentMemory} />
      </div>
    </div>
  );
}
