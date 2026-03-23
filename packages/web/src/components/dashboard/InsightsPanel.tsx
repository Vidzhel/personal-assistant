'use client';

import Link from 'next/link';

interface Insight {
  id: string;
  type: string;
  title: string;
  content: string;
}

interface InsightsPanelProps {
  insights: Insight[];
}

const TRUNCATE_LENGTH = 120;

export function InsightsPanel({ insights }: InsightsPanelProps) {
  return (
    <div
      className="rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold">Latest Insights</h2>
        <Link
          href="/knowledge"
          className="text-xs"
          style={{ color: 'var(--accent)' }}
        >
          View all
        </Link>
      </div>
      <div className="p-4 space-y-3">
        {insights.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No insights yet.
          </p>
        ) : (
          insights.map((insight) => (
            <div key={insight.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg)', color: 'var(--accent)' }}
                >
                  {insight.type}
                </span>
                <p className="text-sm font-medium truncate">{insight.title}</p>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {insight.content.length > TRUNCATE_LENGTH
                  ? `${insight.content.slice(0, TRUNCATE_LENGTH)}...`
                  : insight.content}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
