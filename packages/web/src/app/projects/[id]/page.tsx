'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api, type Project, type Session } from '@/lib/api-client';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { SessionDebugPanel } from '@/components/session/SessionDebugPanel';
import { ReferencesPanel } from '@/components/session/ReferencesPanel';
import { useReferences } from '@/hooks/useReferences';
import { ProjectMemory } from '@/components/project/ProjectMemory';

const COPY_FEEDBACK_DURATION_MS = 1500;
const ID_DISPLAY_LENGTH = 8;

// eslint-disable-next-line max-lines-per-function, complexity -- page component with session management and layout
export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const [error, setError] = useState(false);
  const { references, externalRefs } = useReferences(activeSessionId);

  useEffect(() => {
    api
      .getProject(id)
      .then(setProject)
      .catch(() => setError(true));
    api
      .getProjectSessions(id)
      .then((s) => {
        setSessions(s);
        if (s.length > 0) setActiveSessionId(s[0].id);
      })
      .catch(() => {});
  }, [id]);

  const handleNewSession = useCallback(async () => {
    const session = await api.createSession(id);
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setShowSessions(false);
  }, [id]);

  const handleSwitchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setShowSessions(false);
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const handleCopySessionId = useCallback(() => {
    if (!activeSession) return;
    navigator.clipboard.writeText(activeSession.id);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
  }, [activeSession]);

  if (error) {
    return (
      <div className="p-8" style={{ color: 'var(--text-muted)' }}>
        Project not found.
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-8" style={{ color: 'var(--text-muted)' }}>
        Loading project...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <h1 className="text-lg font-bold">{project.name}</h1>
        <div className="flex gap-1 mt-1">
          {project.skills.map((s) => (
            <span
              key={s}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
            >
              {s}
            </span>
          ))}
        </div>
        <ProjectMemory
          systemPrompt={project.systemPrompt}
          projectId={project.id}
          onSaved={(prompt) => setProject((p) => (p ? { ...p, systemPrompt: prompt } : p))}
        />
      </div>

      {/* Session selector bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <div className="relative flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSessions(!showSessions)}
              className="flex items-center gap-2 px-3 py-1 rounded text-sm hover:opacity-80 transition-opacity"
              style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
            >
              <span className="truncate">
                {activeSession ? (
                  <>
                    <span className="font-mono opacity-60">
                      {activeSession.id.slice(0, ID_DISPLAY_LENGTH)}
                    </span>
                    {' · '}
                    {new Date(activeSession.createdAt).toLocaleDateString()}
                    {' · '}
                    {activeSession.turnCount} turns
                  </>
                ) : (
                  'No session'
                )}
              </span>
              <span style={{ fontSize: '0.6rem' }}>&#9660;</span>
            </button>

            {activeSession && (
              <button
                onClick={handleCopySessionId}
                className="px-1.5 py-1 rounded text-xs hover:opacity-80 transition-opacity shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="Copy session ID"
              >
                {copied ? (
                  'Copied!'
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            )}
          </div>

          {showSessions && (
            <div
              className="absolute top-full left-0 mt-1 w-72 rounded-lg shadow-lg border z-10 max-h-64 overflow-y-auto"
              style={{
                background: 'var(--bg-card)',
                borderColor: 'var(--border)',
              }}
            >
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => handleSwitchSession(s.id)}
                  className="w-full text-left px-3 py-2 text-sm hover:opacity-80 transition-opacity flex justify-between items-center"
                  style={{
                    background: s.id === activeSessionId ? 'var(--bg-hover)' : 'transparent',
                    color: 'var(--text)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span className="truncate">
                    <span className="font-mono opacity-60">{s.id.slice(0, ID_DISPLAY_LENGTH)}</span>
                    {' · '}
                    {new Date(s.createdAt).toLocaleString()}
                  </span>
                  <span className="text-xs ml-2 shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {s.turnCount} turns · {s.status}
                  </span>
                </button>
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  No sessions yet
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => activeSessionId && setShowRefs(true)}
          className="px-2 py-1 rounded text-sm hover:opacity-80 transition-opacity shrink-0"
          style={{ color: 'var(--text-muted)' }}
          title="Knowledge references"
          disabled={!activeSessionId}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </button>

        <button
          onClick={() => activeSessionId && setShowDebug(true)}
          className="px-2 py-1 rounded text-sm hover:opacity-80 transition-opacity shrink-0"
          style={{ color: 'var(--text-muted)' }}
          title="Debug session"
          disabled={!activeSessionId}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
            <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17l-4 1M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 13h4M18 17l4 1" />
          </svg>
        </button>

        <button
          onClick={handleNewSession}
          className="px-3 py-1 rounded text-sm font-medium transition-colors shrink-0"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          New Session
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <ChatPanel projectId={id} sessionId={activeSessionId} />
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
    </div>
  );
}
