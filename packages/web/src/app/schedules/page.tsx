'use client';

import { useEffect } from 'react';
import type { Schedule } from '@/lib/api-client';
import { useAppStore } from '@/stores/app-store';

function ScheduleRow({ s }: { s: Schedule }) {
  return (
    <div
      className="p-4 rounded-lg flex justify-between items-center"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{s.name}</h3>
          {!s.registered && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(234,179,8,0.1)', color: 'var(--warning, #ca8a04)' }}
            >
              not registered
            </span>
          )}
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          <span className="font-mono">{s.cron}</span> &middot; {s.kind}/{s.ref} &middot;{' '}
          {s.timezone}
        </p>
        {s.nextRun !== null && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            next: <span className="font-mono">{s.nextRun}</span>
          </p>
        )}
      </div>
      <span
        className="text-xs px-2 py-1 rounded"
        style={{
          background: s.enabled ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: s.enabled ? 'var(--success)' : 'var(--error)',
        }}
      >
        {s.enabled ? 'Active' : 'Disabled'}
      </span>
    </div>
  );
}

export default function SchedulesPage() {
  const { schedules, fetchSchedules } = useAppStore();

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Schedules</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Recurring tasks and automated jobs.
        </p>
      </div>

      <div className="space-y-3">
        {schedules.map((s) => (
          <ScheduleRow key={s.name} s={s} />
        ))}
        {schedules.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No schedules configured.
          </p>
        )}
      </div>
    </div>
  );
}
