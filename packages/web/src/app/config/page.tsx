'use client';

import { useEffect, useState, useCallback } from 'react';

interface ConfigChange {
  id: string;
  resourceType: string;
  resourceName: string;
  action: string;
  description: string | null;
  proposedContent: string | null;
  diffText: string | null;
  status: 'pending' | 'applied' | 'discarded';
  createdAt: string;
  resolvedAt: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001';

// eslint-disable-next-line max-lines-per-function -- page component with filter, SSE, resolve, and change list rendering
export default function ConfigPage() {
  const [changes, setChanges] = useState<ConfigChange[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  const fetchChanges = useCallback(async () => {
    try {
      const url =
        filter === 'all'
          ? `${API_BASE}/api/config-changes?limit=50`
          : `${API_BASE}/api/config-changes?status=${filter}&limit=50`;
      const res = await fetch(url);
      if (res.ok) {
        setChanges(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchChanges();
  }, [fetchChanges]);

  // SSE for real-time updates
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/sse/events`);
    es.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data);
        if (
          event.type === 'config:change:proposed' ||
          event.type === 'config:change:applied' ||
          event.type === 'config:change:rejected'
        ) {
          fetchChanges();
        }
      } catch {
        // ignore parse errors
      }
    };
    return () => es.close();
  }, [fetchChanges]);

  async function handleResolve(changeId: string, resolution: 'apply' | 'discard') {
    setResolving(changeId);
    try {
      const res = await fetch(`${API_BASE}/api/config-changes/${changeId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      });
      if (res.ok) {
        fetchChanges();
      }
    } finally {
      setResolving(null);
    }
  }

  const statusColor = (status: string) => {
    if (status === 'pending')
      return { bg: 'rgba(234,179,8,0.1)', color: 'var(--warning, #eab308)' };
    if (status === 'applied')
      return { bg: 'rgba(34,197,94,0.1)', color: 'var(--success, #22c55e)' };
    return { bg: 'rgba(239,68,68,0.1)', color: 'var(--error, #ef4444)' };
  };

  const actionIcon = (action: string) => {
    if (action === 'create') return '+';
    if (action === 'update') return '~';
    if (action === 'delete') return '-';
    return '?';
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Configuration</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Review and manage system configuration changes.
        </p>
      </div>

      <div className="flex gap-2">
        {['all', 'pending', 'applied', 'discarded'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="text-xs px-3 py-1.5 rounded-md capitalize"
            style={{
              background: filter === f ? 'var(--accent, #3b82f6)' : 'var(--bg-card)',
              color: filter === f ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${filter === f ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading...
        </p>
      ) : changes.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No configuration changes found.
        </p>
      ) : (
        <div className="space-y-3">
          {/* eslint-disable-next-line max-lines-per-function -- change row renders action icon, status badge, diff/content preview, and resolve buttons */}
          {changes.map((change) => {
            const sc = statusColor(change.status);
            return (
              <div
                key={change.id}
                className="p-4 rounded-lg space-y-3"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
              >
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono text-sm font-bold w-6 h-6 flex items-center justify-center rounded"
                      style={{ background: sc.bg, color: sc.color }}
                    >
                      {actionIcon(change.action)}
                    </span>
                    <div>
                      <h3 className="font-semibold">
                        {change.action} {change.resourceType}: {change.resourceName}
                      </h3>
                      {change.description && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {change.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs px-2 py-1 rounded capitalize"
                      style={{ background: sc.bg, color: sc.color }}
                    >
                      {change.status}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {new Date(change.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>

                {change.diffText && (
                  <pre
                    className="text-xs p-3 rounded overflow-x-auto font-mono"
                    style={{
                      background: 'var(--bg-main, #111)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {change.diffText}
                  </pre>
                )}

                {change.proposedContent && !change.diffText && (
                  <pre
                    className="text-xs p-3 rounded overflow-x-auto font-mono"
                    style={{
                      background: 'var(--bg-main, #111)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {change.proposedContent}
                  </pre>
                )}

                {change.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleResolve(change.id, 'apply')}
                      disabled={resolving === change.id}
                      className="text-xs px-3 py-1.5 rounded-md font-medium"
                      style={{ background: 'var(--success, #22c55e)', color: '#fff' }}
                    >
                      {resolving === change.id ? 'Applying...' : 'Apply'}
                    </button>
                    <button
                      onClick={() => handleResolve(change.id, 'discard')}
                      disabled={resolving === change.id}
                      className="text-xs px-3 py-1.5 rounded-md font-medium"
                      style={{ background: 'var(--error, #ef4444)', color: '#fff' }}
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
