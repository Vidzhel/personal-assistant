'use client';

import { useState } from 'react';
import type { LogEntry } from '@/lib/api-client';

const LEVEL_COLORS: Record<string, string> = {
  debug: '#6b7280',
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
  fatal: '#dc2626',
  trace: '#9ca3af',
};

const JSON_INDENT = 2;

function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
      style={{ background: LEVEL_COLORS[level] ?? '#6b7280', color: '#fff' }}
    >
      {level}
    </span>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="border-b cursor-pointer hover:opacity-80 transition-opacity"
      style={{ borderColor: 'var(--border)' }}
      onClick={onToggle}
    >
      <div className="flex items-center gap-3 px-3 py-1.5 font-mono text-xs">
        <span style={{ color: 'var(--text-muted)' }}>{formatTime(entry.time)}</span>
        <LevelBadge level={entry.levelLabel} />
        {entry.component && (
          <span className="text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
            {entry.component}
          </span>
        )}
        <span className="flex-1 truncate" style={{ color: 'var(--text)' }}>
          {entry.msg}
        </span>
      </div>
      {expanded && (
        <pre
          className="px-3 py-2 text-[11px] overflow-x-auto"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
        >
          {JSON.stringify(entry, null, JSON_INDENT)}
        </pre>
      )}
    </div>
  );
}

export function LogList({ entries, loading }: { entries: LogEntry[]; loading: boolean }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div
      className="rounded-md border overflow-hidden"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      {loading && entries.length === 0 ? (
        <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
          Loading logs...
        </div>
      ) : entries.length === 0 ? (
        <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
          No log entries found.
        </div>
      ) : (
        <div className="max-h-[70vh] overflow-y-auto">
          {entries.map((entry, i) => (
            <LogRow
              key={`${entry.time}-${i}`}
              entry={entry}
              expanded={expandedIdx === i}
              onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
