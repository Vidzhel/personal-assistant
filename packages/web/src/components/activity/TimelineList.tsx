import { type EventRecord } from '@/lib/api-client';
import { EventCard } from './EventCard';

const SKELETON_COUNT = 5;
const SKELETON_HEIGHT = '56px';

export function TimelineSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div
          key={i}
          className="p-3 rounded-lg animate-pulse"
          style={{ background: 'var(--bg-card)', height: SKELETON_HEIGHT }}
        />
      ))}
    </div>
  );
}

export function TimelineList({
  events,
  hasFilters,
}: {
  events: EventRecord[];
  hasFilters: boolean;
}) {
  return (
    <div className="space-y-2">
      {events.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}
      {events.length === 0 && (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {hasFilters ? 'No matching events' : 'No events recorded yet.'}
        </p>
      )}
    </div>
  );
}
