'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { type TaskRecord, api } from '@/lib/api-client';
import { useSSE, type SSEEvent } from '@/hooks/useSSE';
import {
  getTaskStatusColor,
  getTaskStatusIcon,
  formatTaskDuration,
  getTaskPriorityLabel,
} from '@/lib/task-helpers';

const TASK_ID_DISPLAY_LENGTH = 8;
const DISABLED_OPACITY = 0.7;

interface TaskDetailProps {
  taskId: string;
  initialStatus: string;
  onClose: () => void;
  onRefresh: () => void;
}

function DetailHeader({ task, onClose }: { task: TaskRecord | null; onClose: () => void }) {
  if (!task) return null;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span
          className="font-mono text-sm font-bold"
          style={{ color: getTaskStatusColor(task.status) }}
        >
          {getTaskStatusIcon(task.status)}
        </span>
        <div>
          <h2 className="text-lg font-bold">{task.skillName}</h2>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {task.id.slice(0, TASK_ID_DISPLAY_LENGTH)}
          </span>
        </div>
      </div>
      <button
        className="px-2 py-1 rounded text-xs"
        style={{ color: 'var(--text-muted)' }}
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

function DetailMeta({ task }: { task: TaskRecord }) {
  return (
    <div className="flex flex-wrap gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
      <span>
        Status: <strong style={{ color: getTaskStatusColor(task.status) }}>{task.status}</strong>
      </span>
      <span>Priority: {getTaskPriorityLabel(task.priority)}</span>
      {task.createdAt && <span>Created: {new Date(task.createdAt).toLocaleString()}</span>}
      {task.startedAt && <span>Started: {new Date(task.startedAt).toLocaleString()}</span>}
      {task.completedAt && <span>Completed: {new Date(task.completedAt).toLocaleString()}</span>}
      {task.durationMs != null && <span>Duration: {formatTaskDuration(task.durationMs)}</span>}
    </div>
  );
}

function StreamingOutput({ taskId }: { taskId: string }) {
  const [chunks, setChunks] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMessage = useCallback((event: SSEEvent) => {
    const data = event.data as { chunk?: string };
    if (data.chunk) {
      const chunk = data.chunk;
      setChunks((prev) => [...prev, chunk]);
    }
  }, []);

  const { connected } = useSSE(`/agent-tasks/${taskId}/stream`, { onMessage: handleMessage });

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [chunks]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold">Live Output</h3>
        {connected && (
          <span
            className="w-2 h-2 rounded-full pipeline-running"
            style={{ background: 'var(--success)' }}
          />
        )}
      </div>
      <div
        ref={containerRef}
        className="font-mono text-xs p-3 rounded-lg overflow-auto"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          maxHeight: '400px',
          whiteSpace: 'pre-wrap',
        }}
      >
        {chunks.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>Waiting for output...</span>
        ) : (
          chunks.join('')
        )}
      </div>
    </div>
  );
}

function CompletedResult({ result }: { result?: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Result</h3>
      <div
        className="text-xs p-3 rounded-lg overflow-auto"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          maxHeight: '400px',
          whiteSpace: 'pre-wrap',
        }}
      >
        {result ?? 'No result recorded.'}
      </div>
    </div>
  );
}

function FailedErrors({ errors }: { errors?: string[] }) {
  if (!errors || errors.length === 0)
    return <CompletedResult result="No error details available." />;
  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Errors</h3>
      <div
        className="text-xs p-3 rounded-lg overflow-auto space-y-2"
        style={{ background: 'var(--bg)', border: '1px solid var(--border)', maxHeight: '400px' }}
      >
        {errors.map((err, i) => (
          <p key={i} style={{ color: 'var(--error)', whiteSpace: 'pre-wrap' }}>
            {err}
          </p>
        ))}
      </div>
    </div>
  );
}

function CancelButton({ task, onRefresh }: { task: TaskRecord; onRefresh: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const canCancel = task.status === 'running' || task.status === 'queued';
  if (!canCancel) return null;

  const handleCancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      await api.cancelTask(task.id);
      onRefresh();
    } catch {
      // polling will reflect actual state
    } finally {
      setCancelling(false);
    }
  };

  return (
    <button
      className="px-3 py-1 rounded text-xs font-medium"
      style={{
        background: 'var(--error)',
        color: 'var(--text)',
        opacity: cancelling ? DISABLED_OPACITY : 1,
      }}
      onClick={handleCancel}
      disabled={cancelling}
    >
      {cancelling ? 'Cancelling...' : 'Cancel Task'}
    </button>
  );
}

function TaskBody({ task }: { task: TaskRecord }) {
  if (task.status === 'running') return <StreamingOutput taskId={task.id} />;
  if (task.status === 'failed') return <FailedErrors errors={task.errors} />;
  return <CompletedResult result={task.result} />;
}

// eslint-disable-next-line max-lines-per-function -- detail panel with fetch, SSE, and multiple sections
export function TaskDetail({ taskId, initialStatus, onClose, onRefresh }: TaskDetailProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchTask = async (): Promise<void> => {
      try {
        const data = await api.getAgentTask(taskId);
        if (!cancelled) setTask(data);
      } catch {
        // task may have been cleaned up
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchTask();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (loading) {
    return (
      <div
        className="p-4 rounded-lg space-y-4"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center justify-between">
          <div
            className="h-6 w-48 rounded animate-pulse"
            style={{ background: 'var(--bg-hover)' }}
          />
          <button
            className="px-2 py-1 rounded text-xs"
            style={{ color: 'var(--text-muted)' }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const displayTask =
    task ??
    ({
      id: taskId,
      status: initialStatus,
      skillName: 'Unknown',
      prompt: '',
      priority: 'normal',
      blocked: false,
      createdAt: '',
    } as TaskRecord);

  return (
    <div
      className="p-4 rounded-lg space-y-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <DetailHeader task={displayTask} onClose={onClose} />
      <DetailMeta task={displayTask} />
      {displayTask.prompt && (
        <div>
          <h3 className="text-sm font-semibold mb-1">Prompt</h3>
          <p className="text-xs" style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
            {displayTask.prompt}
          </p>
        </div>
      )}
      <TaskBody task={displayTask} />
      <CancelButton task={displayTask} onRefresh={onRefresh} />
    </div>
  );
}
