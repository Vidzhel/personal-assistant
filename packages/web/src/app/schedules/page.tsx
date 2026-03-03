'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';

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
          <div
            key={s.id}
            className="p-4 rounded-lg flex justify-between items-center"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <div>
              <h3 className="font-semibold">{s.name}</h3>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                <span className="font-mono">{s.cron}</span> &middot; {s.skillName} &middot;{' '}
                {s.timezone}
              </p>
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
