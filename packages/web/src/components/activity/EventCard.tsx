import { type EventRecord } from '@/lib/api-client';
import {
  getEventIcon,
  getEventColor,
  formatEventDescription,
  formatRelativeTime,
} from '@/lib/event-helpers';

export function EventCard({ event }: { event: EventRecord }) {
  const color = getEventColor(event.type);

  return (
    <div
      className="p-3 rounded-lg flex items-center gap-3 transition-colors"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-mono text-sm font-bold"
        style={{ background: 'var(--bg-hover)', color, border: `1px solid ${color}` }}
      >
        {getEventIcon(event.type)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{formatEventDescription(event)}</p>
        <span
          className="text-xs font-mono px-1.5 py-0.5 rounded mt-0.5 inline-block"
          style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
        >
          {event.source}
        </span>
      </div>
      <span className="text-xs shrink-0 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
        {formatRelativeTime(event.timestamp)}
      </span>
    </div>
  );
}
