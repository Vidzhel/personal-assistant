'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type ExecutionTaskRecord, type TaskTreeDetailRecord } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { usePolling } from '@/hooks/usePolling';
import { TaskArtifactFile } from '@/components/tasks/TaskArtifactFile';

const TREE_REFRESH_MS = 5_000;

interface TreeDetailPanelProps {
  treeId: string;
  onClose: () => void;
  onRefresh: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="min-w-[72px] font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="break-words" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  );
}

function ArtifactData({ artifact }: { artifact: ExecutionTaskRecord['artifacts'][number] }) {
  return (
    <>
      {artifact.referenceId && (
        <div className="mt-0.5 break-all font-mono" style={{ color: 'var(--accent)' }}>
          Reference: {artifact.referenceId}
        </div>
      )}
      {artifact.data && (
        <pre
          className="mt-1 overflow-x-auto whitespace-pre-wrap"
          style={{ color: 'var(--text-secondary)' }}
        >
          {JSON.stringify(artifact.data, null, 2)}
        </pre>
      )}
    </>
  );
}

function ArtifactList({ task, treeId }: { task: ExecutionTaskRecord; treeId: string }) {
  if (task.artifacts.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        Artifacts
      </div>
      {task.artifacts.map((artifact, index) => (
        <div
          key={`${artifact.type}-${artifact.label}-${String(index)}`}
          className="rounded p-2 text-xs"
          style={{ background: 'var(--bg-hover)' }}
        >
          <div style={{ color: 'var(--text-primary)' }}>
            <span>{artifact.label}</span>{' '}
            <span style={{ color: 'var(--text-muted)' }}>({artifact.type})</span>
          </div>
          {artifact.filePath && (
            <>
              <div className="mt-0.5 break-all font-mono" style={{ color: 'var(--accent)' }}>
                {artifact.filePath}
              </div>
              <TaskArtifactFile
                key={`${treeId}-${task.id}-${index}-${artifact.sourceId}-${artifact.filePath}`}
                treeId={treeId}
                taskId={task.id}
                index={index}
              />
            </>
          )}
          <ArtifactData artifact={artifact} />
        </div>
      ))}
    </div>
  );
}

function TreeTask({
  task,
  treeId,
  treeStatus,
  disabled,
  onApprove,
}: {
  task: ExecutionTaskRecord;
  treeId: string;
  treeStatus: string;
  disabled: boolean;
  onApprove: () => void;
}) {
  const approvalPending =
    treeStatus === 'running' && task.type === 'approval' && task.status === 'pending_approval';
  return (
    <div className="rounded border p-3 space-y-1.5" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium break-words">{task.title}</div>
          <div className="text-xs font-mono break-all" style={{ color: 'var(--text-muted)' }}>
            {task.id}
          </div>
        </div>
        <StatusBadge status={task.status} />
      </div>
      <DetailRow label="Type" value={task.type} />
      {task.agent && <DetailRow label="Agent" value={task.agent} />}
      {task.blockedBy.length > 0 && <DetailRow label="After" value={task.blockedBy.join(', ')} />}
      {task.summary && <DetailRow label="Summary" value={task.summary} />}
      {task.lastError && <DetailRow label="Error" value={task.lastError} />}
      <ArtifactList task={task} treeId={treeId} />
      {approvalPending && (
        <Button size="sm" variant="primary" onClick={onApprove} disabled={disabled}>
          Approve step
        </Button>
      )}
    </div>
  );
}

function TreeActions({
  tree,
  busy,
  onApprove,
  onCancel,
}: {
  tree: TaskTreeDetailRecord;
  busy: 'approve' | 'cancel' | string | null;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const interrupted = tree.interrupted === true;
  const canCancel = tree.status === 'pending_approval' || tree.status === 'running';
  return (
    <>
      {interrupted && (
        <div
          className="rounded border p-3 text-xs"
          style={{ borderColor: 'var(--warning)', color: 'var(--text-secondary)' }}
        >
          This tree was interrupted by a restart. Choose Resume to deliberately continue; some
          earlier actions may already have completed.
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {tree.status === 'pending_approval' && (
          <Button
            variant="primary"
            onClick={onApprove}
            loading={busy === 'approve'}
            disabled={busy !== null}
          >
            {interrupted ? 'Resume' : 'Approve plan'}
          </Button>
        )}
        {canCancel && (
          <Button
            variant="danger"
            onClick={onCancel}
            loading={busy === 'cancel'}
            disabled={busy !== null}
          >
            Cancel tree
          </Button>
        )}
      </div>
    </>
  );
}

function TreePlan({ plan }: { plan?: string }) {
  if (!plan) return null;
  return (
    <div>
      <p
        className="rounded p-3 text-sm whitespace-pre-wrap"
        style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
      >
        {plan}
      </p>
    </div>
  );
}

function TreeMetadata({ tree }: { tree: TaskTreeDetailRecord }) {
  return (
    <div className="space-y-1">
      <DetailRow label="Project" value={tree.projectId} />
      <DetailRow label="Created" value={formatDate(tree.createdAt)} />
      <DetailRow label="Updated" value={formatDate(tree.updatedAt)} />
      <DetailRow label="ID" value={tree.id} />
    </div>
  );
}

function TreePanelContent({
  tree,
  busy,
  onApprove,
  onApproveTask,
  onCancel,
}: {
  tree: TaskTreeDetailRecord;
  busy: 'approve' | 'cancel' | string | null;
  onApprove: () => void;
  onApproveTask: (taskId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge status={tree.status} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {tree.completedCount}/{tree.taskCount} complete
            </span>
          </div>
          <h2 className="mt-2 break-words text-lg font-bold">Execution plan</h2>
        </div>
      </div>

      <TreeActions tree={tree} busy={busy} onApprove={onApprove} onCancel={onCancel} />

      <TreePlan plan={tree.plan} />

      <div className="space-y-2">
        <h3 className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
          Nodes ({tree.tasks.length})
        </h3>
        {tree.tasks.map((task) => (
          <TreeTask
            key={task.id}
            task={task}
            treeId={tree.id}
            treeStatus={tree.status}
            disabled={busy !== null}
            onApprove={() => onApproveTask(task.id)}
          />
        ))}
      </div>

      <TreeMetadata tree={tree} />
    </div>
  );
}

function TreePanelBody({
  tree,
  loading,
  error,
  busy,
  onApprove,
  onApproveTask,
  onCancel,
}: {
  tree: TaskTreeDetailRecord | null;
  loading: boolean;
  error: string | undefined;
  busy: 'approve' | 'cancel' | string | null;
  onApprove: () => void;
  onApproveTask: (taskId: string) => void;
  onCancel: () => void;
}) {
  if (loading && !tree)
    return (
      <p className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </p>
    );
  if (!tree)
    return (
      <p className="p-6 text-sm" role="alert" style={{ color: 'var(--error)' }}>
        {error ?? 'Could not load this task tree.'}
      </p>
    );
  return (
    <>
      <TreePanelContent
        tree={tree}
        busy={busy}
        onApprove={onApprove}
        onApproveTask={onApproveTask}
        onCancel={onCancel}
      />
      {error && (
        <p className="px-4 pb-4 text-sm" role="alert" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
    </>
  );
}

function useTreeMutationActions(
  treeId: string,
  refresh: () => void,
  onRefresh: () => void,
): {
  busy: 'approve' | 'cancel' | string | null;
  error: string | null;
  approve: () => void;
  approveTask: (taskId: string) => void;
  cancel: () => void;
} {
  const [busy, setBusy] = useState<'approve' | 'cancel' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function mutate(action: string, operation: () => Promise<unknown>): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      await operation();
      if (!mounted.current) return;
      refresh();
      onRefresh();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not update this task tree.');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const approve = (): void => {
    void mutate('approve', () => api.approveTaskTree(treeId));
  };

  const approveTask = (taskId: string): void => {
    void mutate(taskId, () => api.approveTaskTreeTask(treeId, taskId));
  };

  const cancel = (): void => {
    if (!confirm('Cancel this task tree? Running agent work will be aborted.')) return;
    void mutate('cancel', () => api.cancelTaskTree(treeId));
  };

  return { busy, error, approve, approveTask, cancel };
}

export function TreeDetailPanel({ treeId, onClose, onRefresh }: TreeDetailPanelProps) {
  const treeState = usePolling<TaskTreeDetailRecord>(
    `/task-trees/${encodeURIComponent(treeId)}`,
    TREE_REFRESH_MS,
  );
  const actions = useTreeMutationActions(treeId, treeState.refresh, onRefresh);
  const error = actions.error ?? treeState.error?.message;

  return (
    <div
      role="region"
      aria-label="Execution tree details"
      className="fixed inset-y-0 right-0 z-50 w-full max-w-[480px] overflow-y-auto border-l shadow-xl"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
    >
      <div
        className="sticky top-0 z-10 flex items-center justify-between border-b p-4"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
      >
        <span className="text-sm font-semibold">Execution tree</span>
        <button
          aria-label="Close execution tree"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>
      <TreePanelBody
        tree={treeState.data}
        loading={treeState.loading}
        error={error}
        busy={actions.busy}
        onApprove={actions.approve}
        onApproveTask={actions.approveTask}
        onCancel={actions.cancel}
      />
    </div>
  );
}
