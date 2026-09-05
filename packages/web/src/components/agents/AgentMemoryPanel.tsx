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

function ProjectMemorySelection() {
  const {
    selectedAgentMemory,
    selectedAgentMemoryError,
    availableProjects,
    memoryProjectId,
    memoryLoading,
    selectMemoryProject,
  } = useAgentStore();

  return (
    <div className="p-4 space-y-3">
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Notes shared by agents working in the selected project.
      </p>
      <label className="block text-sm" htmlFor="memory-project">
        Project
      </label>
      <select
        id="memory-project"
        value={memoryProjectId ?? ''}
        onChange={(event) => void selectMemoryProject(event.target.value)}
        className="w-full rounded border p-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <option value="">Select a project</option>
        {availableProjects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {memoryLoading ? (
        <p className="text-sm">Loading memory…</p>
      ) : (
        memoryProjectId && (
          <MemoryPanelBody error={selectedAgentMemoryError} files={selectedAgentMemory} />
        )
      )}
    </div>
  );
}

export function AgentMemoryPanel() {
  const { closeMemoryPanel } = useAgentStore();

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-full max-w-96 border-l shadow-lg overflow-y-auto"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
    >
      <div
        className="p-4 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <h3 className="font-semibold text-sm">Project memory</h3>
        <button
          onClick={closeMemoryPanel}
          className="text-sm px-2 py-1 rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>

      <ProjectMemorySelection />
    </div>
  );
}
