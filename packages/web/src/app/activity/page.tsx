'use client';

import { useState } from 'react';
import { type EventRecord } from '@/lib/api-client';
import { usePolling } from '@/hooks/usePolling';
import { FilterBar } from '@/components/activity/FilterBar';
import { TimelineSkeleton, TimelineList } from '@/components/activity/TimelineList';

const REFRESH_MS = 5000;
const FILTERS_REFRESH_MS = 30000;
const EVENT_LIMIT = 200;

export default function ActivityPage() {
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedType, setSelectedType] = useState('');

  const eventsParams = new URLSearchParams();
  eventsParams.set('limit', String(EVENT_LIMIT));
  if (selectedSource) eventsParams.set('source', selectedSource);
  if (selectedType) eventsParams.set('type', selectedType);
  const eventsUrl = `/events?${eventsParams}`;

  const { data: events, loading } = usePolling<EventRecord[]>(eventsUrl, REFRESH_MS);
  const { data: sources } = usePolling<string[]>('/events/sources', FILTERS_REFRESH_MS);
  const { data: eventTypes } = usePolling<string[]>('/events/types', FILTERS_REFRESH_MS);

  const clearFilters = (): void => {
    setSelectedSource('');
    setSelectedType('');
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Activity Timeline</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Chronological view of all autonomous Raven actions.
        </p>
      </div>
      <FilterBar
        sources={sources ?? []}
        eventTypes={eventTypes ?? []}
        selectedSource={selectedSource}
        selectedType={selectedType}
        onSourceChange={setSelectedSource}
        onTypeChange={setSelectedType}
        onClear={clearFilters}
      />
      {loading ? (
        <TimelineSkeleton />
      ) : (
        <TimelineList events={events ?? []} hasFilters={!!(selectedSource || selectedType)} />
      )}
    </div>
  );
}
