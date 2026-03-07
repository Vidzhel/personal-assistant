'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api, type Project, type Session } from '@/lib/api-client';
import { ChatPanel } from '@/components/chat/ChatPanel';

export default function ProjectPage() {
  const params = useParams();
  const id = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);

  useEffect(() => {
    api
      .getProject(id)
      .then(setProject)
      .catch(() => {});
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
      </div>

      {/* Session selector bar */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-b text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="flex items-center gap-2 px-3 py-1 rounded text-sm hover:opacity-80 transition-opacity"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
          >
            <span className="truncate">
              {activeSession
                ? `Session ${new Date(activeSession.createdAt).toLocaleDateString()} · ${activeSession.turnCount} turns`
                : 'No session'}
            </span>
            <span style={{ fontSize: '0.6rem' }}>&#9660;</span>
          </button>

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
                  <span className="truncate">{new Date(s.createdAt).toLocaleString()}</span>
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
    </div>
  );
}
