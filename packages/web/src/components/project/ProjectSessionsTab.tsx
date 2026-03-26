'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, type Session } from '@/lib/api-client';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { SessionDebugPanel } from '@/components/session/SessionDebugPanel';
import { ReferencesPanel } from '@/components/session/ReferencesPanel';
import { SessionReferencesPanel } from '@/components/session/SessionReferencesPanel';
import { InlineEditField } from './InlineEditField';
import { useReferences } from '@/hooks/useReferences';
import type { ProjectTabProps } from './project-tab-registry';

const ID_DISPLAY_LENGTH = 8;
const COPY_FEEDBACK_DURATION_MS = 1500;

// eslint-disable-next-line max-lines-per-function, complexity -- sessions tab with session list, chat panel, debug, references, cross-refs
export function ProjectSessionsTab({ projectId }: ProjectTabProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const [showCrossRefs, setShowCrossRefs] = useState(false);
  const [copied, setCopied] = useState(false);
  const { references, externalRefs } = useReferences(activeSessionId);

  useEffect(() => {
    api.getProjectSessions(projectId).then((s) => {
      setSessions(s);
      if (s.length > 0 && !activeSessionId) setActiveSessionId(s[0].id);
    });
  }, [projectId]); // intentionally omit activeSessionId — only set on first load

  const handleNewSession = useCallback(async () => {
    const session = await api.createSession(projectId);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  }, [projectId]);

  const handleCopySessionId = useCallback(() => {
    if (!activeSessionId) return;
    navigator.clipboard.writeText(activeSessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
  }, [activeSessionId]);

  const handleUpdateSession = useCallback(
    async (sessionId: string, data: { name?: string; description?: string; pinned?: boolean }) => {
      const updated = await api.updateSession(sessionId, data);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    },
    [],
  );

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        new Date(s.createdAt).toLocaleString().toLowerCase().includes(q),
    );
  }, [sessions, searchQuery]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex h-full">
      {/* Session list sidebar */}
      <div
        className="w-72 border-r flex flex-col shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-2 py-1.5 rounded text-sm border"
            style={{
              background: 'var(--bg)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className="w-full text-left px-3 py-2.5 text-sm border-b transition-colors"
              style={{
                background: s.id === activeSessionId ? 'var(--bg-hover)' : 'transparent',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-xs truncate"
                  style={{ color: s.pinned ? 'var(--accent)' : 'var(--text)' }}
                >
                  {s.pinned ? '\u{1F4CC} ' : ''}
                  {s.name || `Session ${s.id.slice(0, ID_DISPLAY_LENGTH)}`}
                </span>
                <span className="text-xs shrink-0 ml-1" style={{ color: 'var(--text-muted)' }}>
                  {s.turnCount}t
                </span>
              </div>
              {s.description && (
                <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                  {s.description}
                </div>
              )}
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {new Date(s.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
          {filteredSessions.length === 0 && (
            <p className="text-sm p-3 text-center" style={{ color: 'var(--text-muted)' }}>
              No sessions found
            </p>
          )}
        </div>
        <div className="p-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={() => void handleNewSession()}
            className="w-full px-3 py-1.5 rounded text-sm font-medium transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            New Session
          </button>
        </div>
      </div>

      {/* Chat area — NO ProjectMemory editing here */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Session info bar */}
        {activeSession && (
          <div
            className="px-4 py-2 border-b text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
          >
            <div className="flex items-center gap-3">
              <button
                onClick={() =>
                  void handleUpdateSession(activeSession.id, { pinned: !activeSession.pinned })
                }
                className="text-sm hover:opacity-80"
                title={activeSession.pinned ? 'Unpin session' : 'Pin session'}
              >
                {activeSession.pinned ? '\u{1F4CC}' : '\u{1F587}\uFE0F'}
              </button>
              <InlineEditField
                value={activeSession.name || ''}
                onSave={async (name) => {
                  await handleUpdateSession(activeSession.id, { name });
                }}
                placeholder="Name this session..."
                className="text-sm font-medium flex-1"
              />
              <span className="font-mono text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                {activeSession.id.slice(0, ID_DISPLAY_LENGTH)}
              </span>
              <button
                onClick={handleCopySessionId}
                className="text-xs px-1.5 py-0.5 rounded hover:opacity-80 shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {copied ? 'Copied!' : 'Copy ID'}
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <InlineEditField
                value={activeSession.description || ''}
                onSave={async (desc) => {
                  await handleUpdateSession(activeSession.id, { description: desc });
                }}
                placeholder="Add description..."
                className="text-xs flex-1"
                style={{ color: 'var(--text-muted)' }}
              />
              <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                {new Date(activeSession.createdAt).toLocaleDateString()} · {activeSession.turnCount}{' '}
                turns · {activeSession.status}
              </span>
              <button
                onClick={() => setShowCrossRefs(true)}
                className="text-xs px-2 py-1 rounded hover:opacity-80 shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="Session cross-references"
              >
                Links
              </button>
              <button
                onClick={() => setShowRefs(true)}
                className="text-xs px-2 py-1 rounded hover:opacity-80 shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="Knowledge references"
              >
                Refs
              </button>
              <button
                onClick={() => setShowDebug(true)}
                className="text-xs px-2 py-1 rounded hover:opacity-80 shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="Debug session"
              >
                Debug
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {activeSessionId ? (
            <ChatPanel projectId={projectId} sessionId={activeSessionId} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Select a session or create a new one
              </p>
            </div>
          )}
        </div>
      </div>

      {showDebug && activeSessionId && (
        <SessionDebugPanel sessionId={activeSessionId} onClose={() => setShowDebug(false)} />
      )}

      {showRefs && activeSessionId && (
        <ReferencesPanel
          references={references}
          externalRefs={externalRefs}
          onClose={() => setShowRefs(false)}
        />
      )}

      {showCrossRefs && activeSessionId && (
        <SessionReferencesPanel
          sessionId={activeSessionId}
          sessions={sessions}
          onClose={() => setShowCrossRefs(false)}
          onNavigate={(targetId) => {
            setActiveSessionId(targetId);
            setShowCrossRefs(false);
          }}
        />
      )}
    </div>
  );
}
