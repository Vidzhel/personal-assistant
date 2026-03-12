'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, type SessionDebug } from '@/lib/api-client';

interface SessionDebugPanelProps {
  sessionId: string;
  onClose: () => void;
}

interface CollapsibleSectionProps {
  title: string;
  count: number;
  data: unknown;
  defaultOpen?: boolean;
}

function CollapsibleSection({ title, count, data, defaultOpen = false }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="border-b" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between px-4 py-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-sm font-medium"
          style={{ color: 'var(--text)' }}
        >
          <span style={{ fontSize: '0.6rem' }}>{open ? '▼' : '▶'}</span>
          {title}
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
          >
            {count}
          </span>
        </button>
        <button
          onClick={handleCopy}
          className="text-xs px-2 py-0.5 rounded hover:opacity-80"
          style={{ color: 'var(--text-muted)' }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {open && (
        <pre
          className="px-4 pb-3 text-xs overflow-x-auto"
          style={{ color: 'var(--text-muted)', maxHeight: '300px', overflowY: 'auto' }}
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function SessionDebugPanel({ sessionId, onClose }: SessionDebugPanelProps) {
  const [debugData, setDebugData] = useState<SessionDebug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDebugData(null);
    setError(null);
    api
      .getSessionDebug(sessionId)
      .then(setDebugData)
      .catch((e: Error) => setError(e.message));
  }, [sessionId]);

  const handleCopyAll = useCallback(() => {
    if (!debugData) return;
    navigator.clipboard.writeText(JSON.stringify(debugData, null, 2));
  }, [debugData]);

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col shadow-xl"
        style={{
          width: '480px',
          maxWidth: '100vw',
          background: 'var(--bg-card)',
          borderLeft: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <div>
            <h3 className="text-sm font-bold" style={{ color: 'var(--text)' }}>
              Session Debug
            </h3>
            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              {sessionId.slice(0, 12)}...
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyAll}
              className="text-xs px-2 py-1 rounded hover:opacity-80"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
              disabled={!debugData}
            >
              Copy All
            </button>
            <button
              onClick={onClose}
              className="text-lg px-2 hover:opacity-80"
              style={{ color: 'var(--text-muted)' }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="p-4 text-sm" style={{ color: '#ef4444' }}>
              Error: {error}
            </div>
          )}
          {!debugData && !error && (
            <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading...
            </div>
          )}
          {debugData && (
            <>
              <CollapsibleSection title="Session" count={1} data={debugData.session} defaultOpen />
              <CollapsibleSection
                title="Messages"
                count={debugData.messages.length}
                data={debugData.messages}
              />
              <CollapsibleSection
                title="Tasks"
                count={debugData.tasks.length}
                data={debugData.tasks}
              />
              <CollapsibleSection
                title="Audit"
                count={debugData.auditEntries.length}
                data={debugData.auditEntries}
              />
              <CollapsibleSection
                title="Raw Output"
                count={debugData.rawMessages.length}
                data={debugData.rawMessages.map((s) => {
                  try {
                    return JSON.parse(s);
                  } catch {
                    return s;
                  }
                })}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
