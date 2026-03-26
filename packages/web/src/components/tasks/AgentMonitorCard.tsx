'use client';

import { useState } from 'react';
import { api, type ActiveTaskInfo } from '@/lib/api-client';
import { SendMessageModal } from './SendMessageModal';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const ID_DISPLAY_LENGTH = 8;
const OPACITY_HALF = 0.5;

function formatElapsed(startMs?: number, createdMs?: number): string {
  const base = startMs ?? createdMs;
  if (!base) return '—';
  const elapsed = Date.now() - base;
  const secs = Math.floor(elapsed / MS_PER_SECOND);
  if (secs < SECONDS_PER_MINUTE) return `${secs}s`;
  const mins = Math.floor(secs / SECONDS_PER_MINUTE);
  if (mins < MINUTES_PER_HOUR) return `${mins}m ${secs % SECONDS_PER_MINUTE}s`;
  const hrs = Math.floor(mins / MINUTES_PER_HOUR);
  return `${hrs}h ${mins % MINUTES_PER_HOUR}m`;
}

interface AgentMonitorCardProps {
  task: ActiveTaskInfo;
  section: 'running' | 'queued';
  onRefresh: () => void;
}

// eslint-disable-next-line max-lines-per-function, complexity -- card renders task info, session link, cancel/message actions, and modal
export function AgentMonitorCard({ task, section, onRefresh }: AgentMonitorCardProps) {
  const [showMessage, setShowMessage] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!confirm('Terminate this agent task?')) return;
    setCancelling(true);
    try {
      await api.cancelTask(task.taskId);
      onRefresh();
    } catch {
      /* */
    } finally {
      setCancelling(false);
    }
  };

  const isRunning = section === 'running';

  return (
    <div
      className="p-4 rounded-lg border"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: isRunning ? 'var(--warning)' : 'var(--text-muted)' }}
            />
            <span className="font-medium text-sm">{task.skillName}</span>
            {task.priority !== 'normal' && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: task.priority === 'urgent' ? 'var(--error)' : 'var(--warning)',
                  color: 'white',
                }}
              >
                {task.priority}
              </span>
            )}
          </div>

          {task.projectId && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Project: {task.projectName ?? task.projectId}
            </p>
          )}
        </div>

        <div className="text-right flex-shrink-0">
          <span
            className="text-sm font-mono"
            style={{ color: isRunning ? 'var(--warning)' : 'var(--text-muted)' }}
          >
            {isRunning ? formatElapsed(task.startedAt, task.createdAt) : 'Queued'}
          </span>
        </div>
      </div>

      {/* Session link */}
      {task.sessionId && task.projectId && (
        <a
          href={`/projects/${task.projectId}`}
          className="text-xs mt-1 inline-block"
          style={{ color: 'var(--accent)' }}
        >
          Session {task.sessionId.slice(0, ID_DISPLAY_LENGTH)}...
        </a>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="text-xs px-2 py-1 rounded"
          style={{ color: 'var(--error)', opacity: cancelling ? OPACITY_HALF : 1 }}
        >
          {cancelling ? 'Cancelling...' : 'Terminate'}
        </button>

        {task.sessionId && (
          <button
            onClick={() => setShowMessage(!showMessage)}
            className="text-xs px-2 py-1 rounded"
            style={{ color: 'var(--accent)' }}
          >
            Send Message
          </button>
        )}

        {task.sessionId && task.projectId && (
          <a
            href={`/projects/${task.projectId}`}
            className="text-xs px-2 py-1 rounded"
            style={{ color: 'var(--text-muted)' }}
          >
            Go to Conversation
          </a>
        )}
      </div>

      {showMessage && task.sessionId && (
        <SendMessageModal sessionId={task.sessionId} onClose={() => setShowMessage(false)} />
      )}
    </div>
  );
}
