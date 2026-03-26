'use client';

import { useEffect, useState, useCallback } from 'react';
import { DiffViewer } from '@/components/dashboard/DiffViewer';

interface ConfigCommit {
  hash: string;
  timestamp: string;
  message: string;
  author: string;
  files: string[];
}

interface CommitDetail extends ConfigCommit {
  diffs: Array<{ file: string; diff: string }>;
}

const API_BASE = process.env.NEXT_PUBLIC_CORE_API_URL || 'http://localhost:4001/api';
const PAGE_SIZE = 20;
const COMMIT_HASH_DISPLAY_LENGTH = 7;
const TOAST_DURATION_MS = 4000;
const OPACITY_HALF = 0.5;

// eslint-disable-next-line max-lines-per-function -- page component with commit list, diff viewer, and revert
export default function ConfigHistoryPage() {
  const [commits, setCommits] = useState<ConfigCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const fetchCommits = useCallback(async (off: number) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/config-history?limit=${PAGE_SIZE}&offset=${off}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = (await res.json()) as { commits: ConfigCommit[] };
      setCommits(data.commits);
    } catch {
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCommits(offset);
  }, [fetchCommits, offset]);

  const toggleExpand = useCallback(
    async (hash: string) => {
      if (expandedHash === hash) {
        setExpandedHash(null);
        setDetail(null);
        return;
      }
      setExpandedHash(hash);
      setLoadingDetail(true);
      try {
        const res = await fetch(`${API_BASE}/config-history/${hash}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = (await res.json()) as CommitDetail;
        setDetail(data);
      } catch {
        setDetail(null);
      } finally {
        setLoadingDetail(false);
      }
    },
    [expandedHash],
  );

  const handleRevert = useCallback(
    async (hash: string) => {
      if (
        !confirm(
          `Revert commit ${hash.slice(0, COMMIT_HASH_DISPLAY_LENGTH)}? This will create a new commit.`,
        )
      )
        return;

      setReverting(hash);
      try {
        const res = await fetch(`${API_BASE}/config-history/${hash}/revert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = (await res.json()) as { success: boolean; message: string };
        if (data.success) {
          setToast({ message: data.message, type: 'success' });
          void fetchCommits(offset);
        } else {
          setToast({ message: data.message, type: 'error' });
        }
      } catch (err) {
        setToast({
          message: err instanceof Error ? err.message : 'Revert failed',
          type: 'error',
        });
      } finally {
        setReverting(null);
        setTimeout(() => setToast(null), TOAST_DURATION_MS);
      }
    },
    [fetchCommits, offset],
  );

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Config History</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Git-committed configuration changes.
        </p>
      </div>

      {toast && (
        <div
          className="p-3 rounded-lg text-sm"
          style={{
            background: toast.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: toast.type === 'success' ? 'var(--success)' : 'var(--error)',
            border: `1px solid ${toast.type === 'success' ? 'var(--success)' : 'var(--error)'}`,
          }}
        >
          {toast.message}
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
      ) : commits.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No config commits found.</p>
      ) : (
        <div className="space-y-2">
          {/* eslint-disable-next-line max-lines-per-function -- commit row renders hash, timestamp, files, revert button, and inline diff */}
          {commits.map((commit) => (
            <div
              key={commit.hash}
              className="rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <div className="p-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => void toggleExpand(commit.hash)}
                    className="text-sm font-medium text-left hover:underline"
                    style={{ color: 'var(--text)' }}
                  >
                    {commit.message || '(no message)'}
                  </button>
                  <div
                    className="flex items-center gap-3 mt-1 text-xs"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span className="font-mono">
                      {commit.hash.slice(0, COMMIT_HASH_DISPLAY_LENGTH)}
                    </span>
                    <span>{new Date(commit.timestamp).toLocaleString()}</span>
                    <span>{commit.author}</span>
                  </div>
                  {commit.files.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {commit.files.map((f) => (
                        <span
                          key={f}
                          className="text-xs px-1.5 py-0.5 rounded font-mono"
                          style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void handleRevert(commit.hash)}
                  disabled={reverting === commit.hash}
                  className="px-3 py-1.5 text-xs rounded-md shrink-0"
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    color: 'var(--error)',
                    opacity: reverting === commit.hash ? OPACITY_HALF : 1,
                  }}
                >
                  {reverting === commit.hash ? 'Reverting...' : 'Revert'}
                </button>
              </div>

              {expandedHash === commit.hash && (
                <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
                  {loadingDetail ? (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Loading diff...
                    </p>
                  ) : detail ? (
                    <div className="space-y-3">
                      {detail.diffs.map((d) => (
                        <div key={d.file}>
                          <p
                            className="text-xs font-mono mb-1"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {d.file}
                          </p>
                          <DiffViewer diff={d.diff} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Failed to load diff.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-3 py-1.5 text-xs rounded-md"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                opacity: offset === 0 ? OPACITY_HALF : 1,
              }}
            >
              Previous
            </button>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Showing {offset + 1}–{offset + commits.length}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={commits.length < PAGE_SIZE}
              className="px-3 py-1.5 text-xs rounded-md"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                opacity: commits.length < PAGE_SIZE ? OPACITY_HALF : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
