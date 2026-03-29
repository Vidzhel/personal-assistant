'use client';

import { useEffect, useState, useRef } from 'react';
import { api, type TaskTreeRecord, type TaskTreeDetailRecord } from '@/lib/api-client';
import { TaskTreeView } from '@/components/task-trees/TaskTreeView';

const POLL_INTERVAL_MS = 5000;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'rgba(161,161,170,0.2)', text: 'rgb(161,161,170)' },
  'waiting-approval': { bg: 'rgba(168,85,247,0.2)', text: 'rgb(192,132,252)' },
  running: { bg: 'rgba(234,179,8,0.2)', text: 'rgb(250,204,21)' },
  completed: { bg: 'rgba(34,197,94,0.2)', text: 'rgb(74,222,128)' },
  failed: { bg: 'rgba(239,68,68,0.2)', text: 'rgb(248,113,113)' },
  cancelled: { bg: 'rgba(161,161,170,0.15)', text: 'rgb(113,113,122)' },
};

function getStatusColor(status: string) {
  return STATUS_COLORS[status] ?? { bg: 'rgba(161,161,170,0.2)', text: 'rgb(161,161,170)' };
}

// eslint-disable-next-line max-lines-per-function -- page with tree list + expandable detail
export default function TaskTreesPage() {
  const [trees, setTrees] = useState<TaskTreeRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskTreeDetailRecord | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchTrees = async () => {
    try {
      const data = await api.getTaskTrees();
      setTrees(data);
    } catch {
      /* polling failure */
    }
  };

  useEffect(() => {
    void fetchTrees();
    timerRef.current = setInterval(() => void fetchTrees(), POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    try {
      const d = await api.getTaskTree(id);
      setDetail(d);
    } catch {
      /* */
    }
  };

  const handleApproveTree = async (id: string) => {
    try {
      await api.approveTaskTree(id);
      void fetchTrees();
      if (expandedId === id) {
        const d = await api.getTaskTree(id);
        setDetail(d);
      }
    } catch {
      /* */
    }
  };

  const handleCancelTree = async (id: string) => {
    try {
      await api.cancelTaskTree(id);
      void fetchTrees();
    } catch {
      /* */
    }
  };

  const handleRefreshDetail = async () => {
    if (!expandedId) return;
    try {
      const d = await api.getTaskTree(expandedId);
      setDetail(d);
    } catch {
      /* */
    }
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Task Trees</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Multi-step execution plans with dependency tracking and approval gates.
        </p>
      </div>

      <div className="space-y-3">
        {trees.map((tree) => {
          const sc = getStatusColor(tree.status);
          const progress =
            tree.taskCount > 0 ? Math.round((tree.completedCount / tree.taskCount) * 100) : 0;
          const isExpanded = expandedId === tree.id;

          return (
            <div key={tree.id}>
              <div
                className="p-4 rounded-lg border cursor-pointer"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
                onClick={() => void toggleExpand(tree.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                      {isExpanded ? 'v' : '>'}
                    </span>
                    <span className="text-sm font-medium font-mono">{tree.id.slice(0, 8)}</span>
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{ background: sc.bg, color: sc.text }}
                    >
                      {tree.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {tree.completedCount}/{tree.taskCount} tasks ({progress}%)
                    </span>
                    {tree.status === 'waiting-approval' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleApproveTree(tree.id);
                        }}
                        className="px-3 py-1 rounded text-xs font-medium text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        Approve
                      </button>
                    )}
                    {(tree.status === 'running' || tree.status === 'waiting-approval') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCancelTree(tree.id);
                        }}
                        className="px-3 py-1 rounded text-xs font-medium"
                        style={{ color: '#ef4444' }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
                {tree.plan && (
                  <p className="text-xs mt-2 ml-7" style={{ color: 'var(--text-muted)' }}>
                    {tree.plan}
                  </p>
                )}
                {/* Progress bar */}
                <div
                  className="mt-2 ml-7 h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'var(--bg-hover)' }}
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${progress}%`,
                      background: tree.status === 'failed' ? '#ef4444' : 'var(--accent)',
                    }}
                  />
                </div>
                <p className="text-xs mt-1 ml-7" style={{ color: 'var(--text-muted)' }}>
                  {new Date(tree.createdAt).toLocaleString()}
                </p>
              </div>

              {isExpanded && detail && detail.id === tree.id && (
                <div className="mt-1 ml-6 pl-4 border-l" style={{ borderColor: 'var(--border)' }}>
                  <TaskTreeView
                    treeId={tree.id}
                    tasks={detail.tasks}
                    onRefresh={() => void handleRefreshDetail()}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {trees.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          No task trees yet. Trigger a template to create one.
        </div>
      )}
    </div>
  );
}
