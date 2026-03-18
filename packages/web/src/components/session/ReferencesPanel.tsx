'use client';

import { useState } from 'react';
import Link from 'next/link';

const PREVIEW_LENGTH = 200;
const HIGH_SCORE_THRESHOLD = 0.8;
const MEDIUM_SCORE_THRESHOLD = 0.5;
const TASK_ID_DISPLAY_LENGTH = 12;

export interface EnrichedReference {
  bubbleId: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
  domains: string[];
  permanence: 'temporary' | 'normal' | 'robust';
}

export interface ExternalRef {
  url: string;
  label: string | null;
  domain: string;
}

interface ReferencesPanelProps {
  references: Record<string, EnrichedReference[]>;
  externalRefs: ExternalRef[];
  onClose: () => void;
}

function scoreColor(score: number): string {
  if (score >= HIGH_SCORE_THRESHOLD) return '#22c55e';
  if (score >= MEDIUM_SCORE_THRESHOLD) return '#eab308';
  return '#9ca3af';
}

function permanenceLabel(p: string): string {
  if (p === 'robust') return 'Robust';
  if (p === 'temporary') return 'Temporary';
  return 'Normal';
}

// eslint-disable-next-line max-lines-per-function -- reference card with expand/collapse, metadata, and navigation
function ReferenceCard({ reference: r }: { reference: EnrichedReference }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="w-full text-left rounded-lg p-3 mb-2 transition-colors cursor-pointer"
      style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {r.title}
        </span>
        <span
          className="text-xs font-mono px-1.5 py-0.5 rounded shrink-0"
          style={{ background: scoreColor(r.score), color: '#fff' }}
        >
          {r.score.toFixed(2)}
        </span>
      </div>
      {r.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {r.tags.map((tag) => (
            <span
              key={tag}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
      <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
        {expanded ? r.snippet : r.snippet.slice(0, PREVIEW_LENGTH)}
        {!expanded && r.snippet.length > PREVIEW_LENGTH && '...'}
      </p>
      {expanded && (
        <div className="mt-2 flex items-center justify-between">
          <div className="flex gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {r.domains.length > 0 && <span>Domains: {r.domains.join(', ')}</span>}
            <span>{permanenceLabel(r.permanence)}</span>
          </div>
          <Link
            href={`/knowledge?bubbleId=${r.bubbleId}`}
            className="text-xs px-2 py-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--accent)' }}
            onClick={(e) => e.stopPropagation()}
          >
            View Full
          </Link>
        </div>
      )}
    </button>
  );
}

// eslint-disable-next-line max-lines-per-function -- panel with overlay, header, knowledge refs grouped by task, external refs
export function ReferencesPanel({ references, externalRefs, onClose }: ReferencesPanelProps) {
  const taskIds = Object.keys(references);
  const totalRefs = taskIds.reduce((sum, tid) => sum + references[tid].length, 0);

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
          width: '400px',
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
          <h3 className="text-sm font-bold" style={{ color: 'var(--text)' }}>
            Knowledge References
          </h3>
          <button
            onClick={onClose}
            className="text-lg px-2 hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Knowledge Context section */}
          {totalRefs === 0 && (
            <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              No knowledge references for this session.
            </div>
          )}
          {taskIds.map((taskId) => (
            <div
              key={taskId}
              className="px-4 py-3 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                Task: {taskId === 'unknown' ? 'General' : taskId.slice(0, TASK_ID_DISPLAY_LENGTH)}
              </div>
              {references[taskId].map((r) => (
                <ReferenceCard key={r.bubbleId} reference={r} />
              ))}
            </div>
          ))}

          {/* External References section */}
          {externalRefs.length > 0 && (
            <div className="px-4 py-3">
              <div
                className="text-xs font-medium mb-2 flex items-center gap-1"
                style={{ color: 'var(--text-muted)' }}
              >
                External References
              </div>
              {externalRefs.map((ext) => (
                <a
                  key={ext.url}
                  href={ext.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded text-sm mb-1 hover:opacity-80"
                  style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
                >
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {ext.domain}
                  </span>
                  <span className="truncate">{ext.label ?? ext.url}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
