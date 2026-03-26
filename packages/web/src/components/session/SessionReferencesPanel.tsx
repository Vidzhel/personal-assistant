'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, type Session, type CrossSessionReference } from '@/lib/api-client';

const ID_DISPLAY_LENGTH = 8;

interface SessionReferencesPanelProps {
  sessionId: string;
  sessions: Session[];
  onClose: () => void;
  onNavigate: (sessionId: string) => void;
}

// eslint-disable-next-line max-lines-per-function -- cross-references panel with two sections and link creation
export function SessionReferencesPanel({
  sessionId,
  sessions,
  onClose,
  onNavigate,
}: SessionReferencesPanelProps) {
  const [refsFrom, setRefsFrom] = useState<CrossSessionReference[]>([]);
  const [refsTo, setRefsTo] = useState<CrossSessionReference[]>([]);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkContext, setLinkContext] = useState('');

  const loadRefs = useCallback(async () => {
    const data = await api.getCrossReferences(sessionId);
    setRefsFrom(data.from);
    setRefsTo(data.to);
  }, [sessionId]);

  useEffect(() => {
    void loadRefs();
  }, [loadRefs]);

  const handleCreateLink = useCallback(async () => {
    if (!linkTarget) return;
    await api.createCrossReference(sessionId, {
      targetSessionId: linkTarget,
      context: linkContext || undefined,
    });
    setShowLinkForm(false);
    setLinkTarget('');
    setLinkContext('');
    await loadRefs();
  }, [sessionId, linkTarget, linkContext, loadRefs]);

  const handleDelete = useCallback(
    async (refId: string) => {
      await api.deleteCrossReference(sessionId, refId);
      await loadRefs();
    },
    [sessionId, loadRefs],
  );

  const getSessionName = (id: string): string => {
    const s = sessions.find((sess) => sess.id === id);
    return s?.name || `Session ${id.slice(0, ID_DISPLAY_LENGTH)}`;
  };

  const otherSessions = sessions.filter((s) => s.id !== sessionId);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
      />
      <div
        className="fixed top-0 right-0 z-50 h-full w-[400px] border-l overflow-y-auto"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center justify-between p-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="text-sm font-semibold">Session Links</h3>
          <button onClick={onClose} className="text-lg hover:opacity-70">
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* References FROM this session */}
          <div>
            <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
              References ({refsFrom.length})
            </h4>
            {refsFrom.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                No outgoing references
              </p>
            )}
            {refsFrom.map((ref) => (
              <div
                key={ref.id}
                className="flex items-start gap-2 p-2 rounded mb-1"
                style={{ background: 'var(--bg-hover)' }}
              >
                <button
                  onClick={() => onNavigate(ref.targetSessionId)}
                  className="text-xs text-left hover:underline flex-1"
                  style={{ color: 'var(--accent)' }}
                >
                  {getSessionName(ref.targetSessionId)}
                  {ref.context && (
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {ref.context}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => void handleDelete(ref.id)}
                  className="text-xs hover:opacity-70 shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>

          {/* References TO this session */}
          <div>
            <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
              Referenced By ({refsTo.length})
            </h4>
            {refsTo.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                No incoming references
              </p>
            )}
            {refsTo.map((ref) => (
              <div
                key={ref.id}
                className="flex items-start gap-2 p-2 rounded mb-1"
                style={{ background: 'var(--bg-hover)' }}
              >
                <button
                  onClick={() => onNavigate(ref.sourceSessionId)}
                  className="text-xs text-left hover:underline flex-1"
                  style={{ color: 'var(--accent)' }}
                >
                  {getSessionName(ref.sourceSessionId)}
                  {ref.context && (
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {ref.context}
                    </span>
                  )}
                </button>
              </div>
            ))}
          </div>

          {/* Link Session action */}
          <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            {!showLinkForm ? (
              <button
                onClick={() => setShowLinkForm(true)}
                className="w-full text-xs px-3 py-1.5 rounded"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                Link Session
              </button>
            ) : (
              <div className="space-y-2">
                <select
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                  className="w-full text-xs p-1.5 rounded border"
                  style={{
                    background: 'var(--bg)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">Select session...</option>
                  {otherSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || `Session ${s.id.slice(0, ID_DISPLAY_LENGTH)}`}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Context (optional)"
                  value={linkContext}
                  onChange={(e) => setLinkContext(e.target.value)}
                  className="w-full text-xs p-1.5 rounded border"
                  style={{
                    background: 'var(--bg)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleCreateLink()}
                    disabled={!linkTarget}
                    className="flex-1 text-xs px-3 py-1.5 rounded disabled:opacity-50"
                    style={{ background: 'var(--accent)', color: 'white' }}
                  >
                    Link
                  </button>
                  <button
                    onClick={() => {
                      setShowLinkForm(false);
                      setLinkTarget('');
                      setLinkContext('');
                    }}
                    className="text-xs px-3 py-1.5 rounded"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
