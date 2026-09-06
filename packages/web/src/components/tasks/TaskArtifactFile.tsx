'use client';

import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api-request';
import type { ProjectFileInfo } from '@/lib/workspace-api';
import { FilePreview } from '@/components/project/FilePreview';

export function TaskArtifactFile({
  treeId,
  taskId,
  index,
}: {
  treeId: string;
  taskId: string;
  index: number;
}) {
  const [info, setInfo] = useState<ProjectFileInfo>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const open = async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setInfo(undefined);
    setError(undefined);
    try {
      const path = `/task-trees/${encodeURIComponent(treeId)}/tasks/${encodeURIComponent(taskId)}/artifacts/${index}/file`;
      const result = await apiRequest<ProjectFileInfo>(path, { signal: current.signal });
      if (!current.signal.aborted) setInfo(result);
    } catch (cause) {
      if (!current.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'File unavailable');
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="mt-2 min-w-0 space-y-2">
      <button type="button" disabled={busy} className="underline" onClick={() => void open()}>
        {busy ? 'Opening file…' : 'View file'}
      </button>
      {error && <p role="alert">{error}</p>}
      {info && <FilePreview projectId={info.projectId} sourceId={info.sourceId} info={info} />}
    </div>
  );
}
