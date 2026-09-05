'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api, type Session } from '@/lib/api-client';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { SessionDebugPanel } from '@/components/session/SessionDebugPanel';
import { ReferencesPanel } from '@/components/session/ReferencesPanel';
import { SessionReferencesPanel } from '@/components/session/SessionReferencesPanel';
import { InlineEditField } from '@/components/project/InlineEditField';
import { useReferences } from '@/hooks/useReferences';
import type { ProjectTabProps } from '@/components/project/project-tab-registry';

const ID_DISPLAY_LENGTH = 8;
const COPY_FEEDBACK_DURATION_MS = 1500;
const SUMMARY_PREVIEW_LENGTH = 100;

// eslint-disable-next-line max-lines-per-function, complexity -- sessions tab with session list, chat panel, debug, references, cross-refs
export function ProjectSessionsTab({ projectId, requestedSessionId }: ProjectTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const [showCrossRefs, setShowCrossRefs] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retroLoading, setRetroLoading] = useState(false);
  const [retroResult, setRetroResult] = useState<{ summary: string } | null>(null);
  const { references, externalRefs } = useReferences(activeSessionId);
  const currentSession = useRef(activeSessionId);
  currentSession.current = activeSessionId;
  useEffect(() => {
    setRetroResult(null);
    setRetroLoading(false);
    setCopied(false);
    setError(null);
  }, [activeSessionId]);

  useEffect(() => {
    let active = true;
    setError(null);
    api
      .getProjectSessions(projectId)
      .then((sessions) => {
        if (!active) return;
        setSessions(sessions);
        setActiveSessionId(
          (previous) =>
            requestedSessionId ??
            (sessions.some((session) => session.id === previous)
              ? previous
              : (sessions[0]?.id ?? null)),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load sessions.');
      });
    return () => {
      active = false;
    };
  }, [projectId, requestedSessionId]);

  const handleNewSession = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await api.createSession(projectId);
      setSessions((previous) => [session, ...previous]);
      setActiveSessionId(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create session.');
    } finally {
      setCreating(false);
    }
  }, [projectId, creating]);

  const handleCopySessionId = useCallback(() => {
    if (!activeSessionId) return;
    void navigator.clipboard
      .writeText(activeSessionId)
      .then(() => {
        if (currentSession.current !== activeSessionId) return;
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
      })
      .catch(() => setError('Could not copy the session ID.'));
  }, [activeSessionId]);

  const handleUpdateSession = useCallback(
    async (sessionId: string, data: { name?: string; description?: string; pinned?: boolean }) => {
      const updated = await api.updateSession(sessionId, data);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    },
    [],
  );

  const handleRunRetrospective = useCallback(async () => {
    if (!activeSessionId) return;
    setRetroLoading(true);
    setRetroResult(null);
    try {
      const result = await api.runSessionRetrospective(activeSessionId);
      if (currentSession.current !== activeSessionId) return;
      setRetroResult(result);
      // Refresh sessions to get updated summary
      const updated = await api.getProjectSessions(projectId);
      setSessions(updated);
    } catch (cause) {
      if (currentSession.current === activeSessionId)
        setError(cause instanceof Error ? cause.message : 'Retrospective failed.');
    } finally {
      if (currentSession.current === activeSessionId) setRetroLoading(false);
    }
  }, [activeSessionId, projectId]);

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
      {error && (
        <p role="alert" className="p-3" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
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
              {s.summary && (
                <div
                  className="text-xs mt-0.5 truncate"
                  style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}
                >
                  {s.summary.slice(0, SUMMARY_PREVIEW_LENGTH)}
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
            disabled={creating}
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
                  void handleUpdateSession(activeSession.id, {
                    pinned: !activeSession.pinned,
                  }).catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : 'Could not update session.'),
                  )
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
                onClick={() => void handleRunRetrospective()}
                disabled={retroLoading}
                className="text-xs px-2 py-1 rounded hover:opacity-80 shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="Run retrospective on this session"
              >
                {retroLoading ? 'Running...' : 'Retro'}
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

        {/* Session summary (from retrospective) */}
        {activeSession?.summary && (
          <details
            className="px-4 py-2 border-b text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
          >
            <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>
              Session Summary
            </summary>
            <p className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--text)' }}>
              {activeSession.summary}
            </p>
          </details>
        )}
        {retroResult && (
          <div
            className="px-4 py-2 border-b text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
          >
            <p className="font-medium mb-1" style={{ color: 'var(--accent)' }}>
              Retrospective Result
            </p>
            <p className="whitespace-pre-wrap" style={{ color: 'var(--text)' }}>
              {retroResult.summary}
            </p>
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
