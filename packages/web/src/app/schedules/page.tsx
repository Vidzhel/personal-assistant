'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Intent, type Schedule } from '@/lib/api-client';
import { useAppStore } from '@/stores/app-store';
import { Button } from '@/components/ui/Button';

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

function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString();
}

function IntentRow({ intent, onCancel }: { intent: Intent; onCancel: (id: string) => void }) {
  const pattern =
    intent.kind === 'event'
      ? `${intent.keywords.join(' + ')} (${intent.eventTypes.join(', ')})`
      : `at ${formatTimestamp(intent.nextFireAt)}`;
  const budgetRemaining = Math.max(0, intent.fireBudget - intent.firesUsed);

  return (
    <div
      className="p-4 rounded-lg flex justify-between items-center"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{intent.message}</h3>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' }}
          >
            {intent.kind}
          </span>
        </div>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {pattern}
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          budget remaining: {budgetRemaining}/{intent.fireBudget} &middot; expires:{' '}
          {formatTimestamp(intent.expiresAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="text-xs px-2 py-1 rounded"
          style={{
            background: intent.status === 'active' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            color: intent.status === 'active' ? 'var(--success)' : 'var(--error)',
          }}
        >
          {intent.status}
        </span>
        {intent.status === 'active' && (
          <Button size="sm" variant="danger" onClick={() => onCancel(intent.id)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function IntentsSection() {
  const [intents, setIntents] = useState<Intent[]>([]);

  const refresh = useCallback(() => {
    api
      .getIntents()
      .then(setIntents)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCancel = useCallback(
    (id: string) => {
      api
        .cancelIntent(id)
        .then(refresh)
        .catch(() => undefined);
    },
    [refresh],
  );

  const active = intents.filter((i) => i.status === 'active');

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Intents</h2>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Deterministic reminders created from chat — &quot;remind me when X&quot; / &quot;remind me
          at TIME&quot;. Created via chat only; cancel here.
        </p>
      </div>
      {active.map((intent) => (
        <IntentRow key={intent.id} intent={intent} onCancel={handleCancel} />
      ))}
      {active.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No active intents.
        </p>
      )}
    </div>
  );
}

export default function SchedulesPage() {
  const { schedules, fetchSchedules } = useAppStore();

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  return (
    <div className="p-8 space-y-8">
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

      <IntentsSection />
    </div>
  );
}
