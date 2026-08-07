'use client';

import { useEffect, useRef, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { api, type PendingApproval } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { formatApprovalAge } from './approval-helpers';

const POLL_INTERVAL_MS = 10000;

// Every row here is, by construction, a red-tier action: pending_approvals
// only gets a row when the permission engine's canUseTool policy (or
// AgentManager.executeAction's pre-check) denies a red-tier action and
// queues it (see packages/core/src/permission-engine/tool-policy.ts). So
// every "Approve" click confirms — there is no green/yellow tier to skip it
// for.
const APPROVE_CONFIRM_MESSAGE =
  'Approve this action? It was queued because it needs manual sign-off.';
const RESOLVE_FAILURE_MESSAGE =
  'Could not resolve this approval — it has been restored. Try again.';

// eslint-disable-next-line max-lines-per-function -- inbox with polling, optimistic resolve, and per-row actions
export function ApprovalsInbox() {
  const { data, loading, error } = usePolling<PendingApproval[]>(
    '/approvals/pending',
    POLL_INTERVAL_MS,
  );
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // M13: ids this tab has already resolved. A poll request in flight when a
  // resolve completes can still land afterwards carrying the now-stale
  // pending row — filtering every poll response through this set (and
  // through `resolvingId`, below) stops that response from resurrecting a
  // row we already know is done. Grows for the component's lifetime; that's
  // fine because a resolution is a one-way, terminal transition.
  const resolvedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!data) return;
    // L19: `resolvingId` isn't just a per-row spinner flag any more — it
    // also has to exclude the in-flight row here, or a poll response that
    // started before this resolve and lands before it finishes would
    // resurrect the row mid-flight.
    setApprovals(data.filter((a) => a.id !== resolvingId && !resolvedIdsRef.current.has(a.id)));
  }, [data, resolvingId]);

  async function handleResolve(id: string, resolution: 'approved' | 'denied') {
    if (resolution === 'approved' && !confirm(APPROVE_CONFIRM_MESSAGE)) {
      return;
    }

    setResolveError(null);
    setResolvingId(id);
    let removed: PendingApproval | undefined;
    // Optimistic remove — captures the removed row so a failed resolve can
    // restore it directly instead of depending on a refetch that might
    // itself fail (the previous behavior: silent catch + refresh()).
    setApprovals((prev) => {
      removed = prev.find((a) => a.id === id);
      return prev.filter((a) => a.id !== id);
    });

    try {
      await api.resolveApproval(id, resolution);
      resolvedIdsRef.current.add(id);
    } catch {
      setApprovals((prev) =>
        removed && !prev.some((a) => a.id === id) ? [...prev, removed] : prev,
      );
      setResolveError(RESOLVE_FAILURE_MESSAGE);
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

      {resolveError && (
        <p className="px-4 pt-3 text-xs" style={{ color: 'var(--error)' }}>
          {resolveError}
        </p>
      )}

      {loading ? (
        <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      ) : approvals.length === 0 && error ? (
        <p className="p-4 text-sm" style={{ color: 'var(--error)' }}>
          Could not load approvals. Retrying…
        </p>
      ) : approvals.length === 0 ? (
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
