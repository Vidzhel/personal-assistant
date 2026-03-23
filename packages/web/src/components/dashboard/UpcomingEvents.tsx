'use client';

import Link from 'next/link';

interface UpcomingEvent {
  name: string;
  scheduledAt: string;
  type: string;
}

interface UpcomingEventsProps {
  events: UpcomingEvent[];
}

export function UpcomingEvents({ events }: UpcomingEventsProps) {
  return (
    <div
      className="rounded-lg"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
        <h2 className="text-sm font-semibold">Upcoming Events</h2>
        <Link
          href="/schedules"
          className="text-xs"
          style={{ color: 'var(--accent)' }}
        >
          View all
        </Link>
      </div>
      <div className="p-4 space-y-3">
        {events.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No upcoming events.
          </p>
        ) : (
          events.map((event, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-xs px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}
                >
                  {event.type}
                </span>
                <p className="text-sm truncate">{event.name}</p>
              </div>
              <p className="text-xs shrink-0 ml-3" style={{ color: 'var(--text-muted)' }}>
                {new Date(event.scheduledAt).toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
