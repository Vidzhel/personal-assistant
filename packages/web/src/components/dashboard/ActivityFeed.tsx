'use client';

import { useEffect, useState, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

interface ActivityItem {
  id: string;
  type: string;
  source: string;
  content: string;
  timestamp: number;
}

const MAX_ACTIVITY_ITEMS = 49;

// eslint-disable-next-line max-lines-per-function -- feed component with WebSocket integration and event rendering
export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const channels = useMemo(() => ['global'], []);
  const { messages } = useWebSocket(channels);

  useEffect(() => {
    for (const msg of messages) {
      if (msg.type === 'event') {
        const event = msg.data as {
          id: string;
          type: string;
          source: string;
          payload?: { content?: string; title?: string; subject?: string };
          timestamp: number;
        };
        setItems((prev) => [
          {
            id: event.id,
            type: event.type,
            source: event.source,
            content:
              event.payload?.content ||
              event.payload?.title ||
              event.payload?.subject ||
              event.type,
            timestamp: event.timestamp,
          },
          ...prev.slice(0, MAX_ACTIVITY_ITEMS),
        ]);
      }
    }
  }, [messages]);

  return (
    <div
      className="rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold">Live Activity</h2>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            No activity yet. Events will appear here in real-time.
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="px-4 py-3 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex justify-between items-start">
                <span
                  className="text-xs font-mono px-2 py-0.5 rounded"
                  style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
                >
                  {item.type}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(item.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-sm mt-1 truncate" style={{ color: 'var(--text)' }}>
                {item.content}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
