'use client';

import { useEffect, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { api, type PendingApproval } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { formatApprovalAge } from './approval-helpers';

const POLL_INTERVAL_MS = 10000;

// Every row here is, by construction, a red-tier action: pending_approvals
// only gets a row when the permission engine's canUseTool policy (or the
// executeApprovedAction pre-check) denies a red-tier action and queues it
// (see packages/core/src/permission-engine/tool-policy.ts). So every
// "Approve" click confirms — there is no green/yellow tier to skip it for.
const APPROVE_CONFIRM_MESSAGE =
  'Approve this action? It was queued because it needs manual sign-off.';

// eslint-disable-next-line max-lines-per-function -- inbox with polling, optimistic resolve, and per-row actions
export function ApprovalsInbox() {
  const { data, refresh } = usePolling<PendingApproval[]>('/approvals/pending', POLL_INTERVAL_MS);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    if (data) setApprovals(data);
  }, [data]);

  async function handleResolve(id: string, resolution: 'approved' | 'denied') {
    if (resolution === 'approved' && !confirm(APPROVE_CONFIRM_MESSAGE)) {
      return;
    }

    setResolvingId(id);
    // Optimistic remove — refetch to restore the row if the resolve fails.
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.resolveApproval(id, resolution);
    } catch {
      refresh();
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div
      id="approvals"
      className="rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div
        className="p-4 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <h2 className="text-sm font-semibold">Pending Approvals</h2>
        {approvals.length > 0 && (
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(234,179,8,0.15)', color: 'rgb(250,204,21)' }}
          >
            {approvals.length}
          </span>
        )}
      </div>

      {approvals.length === 0 ? (
        <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          No pending approvals. Red-tier actions will show up here for sign-off.
        </p>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {approvals.map((approval) => (
            <ApprovalRow
              key={approval.id}
              approval={approval}
              resolving={resolvingId === approval.id}
              onResolve={handleResolve}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ApprovalRowProps {
  approval: PendingApproval;
  resolving: boolean;
  onResolve: (id: string, resolution: 'approved' | 'denied') => void;
}

function ApprovalRow({ approval, resolving, onResolve }: ApprovalRowProps) {
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{approval.actionName}</span>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
          >
            {approval.skillName}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {formatApprovalAge(approval.requestedAt)}
          </span>
        </div>
        {approval.details && (
          <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
            {approval.details}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button
          variant="primary"
          size="sm"
          loading={resolving}
          onClick={() => onResolve(approval.id, 'approved')}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={resolving}
          onClick={() => onResolve(approval.id, 'denied')}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
