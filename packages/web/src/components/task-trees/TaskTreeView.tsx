'use client';

import { api, type ExecutionTaskRecord } from '@/lib/api-client';

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'rgba(161,161,170,0.2)', text: 'rgb(161,161,170)' },
  ready: { bg: 'rgba(59,130,246,0.2)', text: 'rgb(96,165,250)' },
  running: { bg: 'rgba(234,179,8,0.2)', text: 'rgb(250,204,21)' },
  completed: { bg: 'rgba(34,197,94,0.2)', text: 'rgb(74,222,128)' },
  failed: { bg: 'rgba(239,68,68,0.2)', text: 'rgb(248,113,113)' },
  skipped: { bg: 'rgba(161,161,170,0.15)', text: 'rgb(113,113,122)' },
  'waiting-approval': { bg: 'rgba(168,85,247,0.2)', text: 'rgb(192,132,252)' },
};

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  agent: { bg: 'rgba(59,130,246,0.2)', text: 'rgb(96,165,250)' },
  human: { bg: 'rgba(234,179,8,0.2)', text: 'rgb(250,204,21)' },
  tool: { bg: 'rgba(34,197,94,0.2)', text: 'rgb(74,222,128)' },
  validation: { bg: 'rgba(168,85,247,0.2)', text: 'rgb(192,132,252)' },
};

function getColors(map: Record<string, { bg: string; text: string }>, key: string) {
  return map[key] ?? { bg: 'rgba(161,161,170,0.2)', text: 'rgb(161,161,170)' };
}

interface TaskTreeViewProps {
  treeId: string;
  tasks: ExecutionTaskRecord[];
  onRefresh: () => void;
}

// eslint-disable-next-line max-lines-per-function -- task tree view with approval controls
export function TaskTreeView({ treeId, tasks, onRefresh }: TaskTreeViewProps) {
  const handleApprove = async (taskId: string) => {
    try {
      await api.approveTaskTreeTask(treeId, taskId);
      onRefresh();
    } catch {
      /* */
    }
  };

  return (
    <div className="space-y-2">
      {tasks.map((task, idx) => {
        const statusColor = getColors(STATUS_COLORS, task.status);
        const typeColor = getColors(TYPE_COLORS, task.type);

        return (
          <div
            key={task.id}
            className="p-3 rounded-lg border"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span
                className="text-xs font-mono w-6 text-center"
                style={{ color: 'var(--text-muted)' }}
              >
                {idx + 1}
              </span>
              <span className="text-sm font-medium flex-1">{task.title}</span>
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: typeColor.bg, color: typeColor.text }}
              >
                {task.type}
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: statusColor.bg, color: statusColor.text }}
              >
                {task.status}
              </span>
            </div>

            {task.agent && (
              <p className="text-xs mt-1 ml-8" style={{ color: 'var(--text-muted)' }}>
                Agent: {task.agent}
              </p>
            )}

            {task.blockedBy.length > 0 && (
              <p className="text-xs mt-1 ml-8" style={{ color: 'var(--text-muted)' }}>
                Depends on: {task.blockedBy.join(', ')}
              </p>
            )}

            {task.summary && (
              <p className="text-xs mt-1 ml-8" style={{ color: 'var(--text-muted)' }}>
                {task.summary}
              </p>
            )}

            {task.lastError && (
              <p className="text-xs mt-1 ml-8" style={{ color: '#ef4444' }}>
                Error: {task.lastError}
              </p>
            )}

            {task.validationResult && (
              <div className="flex gap-2 mt-1 ml-8">
                {task.validationResult.gate1Passed != null && (
                  <span
                    className="text-xs"
                    style={{ color: task.validationResult.gate1Passed ? '#22c55e' : '#ef4444' }}
                  >
                    G1:{task.validationResult.gate1Passed ? 'pass' : 'fail'}
                  </span>
                )}
                {task.validationResult.gate2Passed != null && (
                  <span
                    className="text-xs"
                    style={{ color: task.validationResult.gate2Passed ? '#22c55e' : '#ef4444' }}
                  >
                    G2:{task.validationResult.gate2Passed ? 'pass' : 'fail'}
                  </span>
                )}
                {task.validationResult.gate3Score != null && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    G3:{task.validationResult.gate3Score}
                  </span>
                )}
              </div>
            )}

            {task.artifacts.length > 0 && (
              <div className="flex gap-1 mt-1 ml-8 flex-wrap">
                {task.artifacts.map((a, i) => (
                  <span
                    key={i}
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
                  >
                    {a.label}
                  </span>
                ))}
              </div>
            )}

            {task.status === 'waiting-approval' && (
              <div className="mt-2 ml-8">
                <button
                  onClick={() => void handleApprove(task.id)}
                  className="px-3 py-1 rounded text-xs font-medium text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  Approve
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
