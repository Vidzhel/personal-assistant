'use client';

import { useEffect, useState } from 'react';
import { api, type EventRecord } from '@/lib/api-client';

export default function ActivityPage() {
  const [events, setEvents] = useState<EventRecord[]>([]);

  useEffect(() => {
    api
      .getEvents({ limit: 100 })
      .then(setEvents)
      .catch(() => {});
    const interval = setInterval(() => {
      api
        .getEvents({ limit: 100 })
        .then(setEvents)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity Log</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          All system events in chronological order.
        </p>
      </div>

      <div className="space-y-2">
        {events.map((e) => (
          <div
            key={e.id}
            className="p-3 rounded-lg flex items-start gap-3"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <span
              className="text-xs font-mono px-2 py-0.5 rounded shrink-0"
              style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
            >
              {e.type}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate">{JSON.stringify(e.payload)}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {e.source} &middot; {new Date(e.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
        {events.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No events recorded yet.
          </p>
        )}
      </div>
    </div>
  );
}
