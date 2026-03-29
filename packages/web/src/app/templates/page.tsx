'use client';

import { useEffect, useState, useRef } from 'react';
import {
  api,
  type TemplateRecord,
  type TemplateDetailRecord,
} from '@/lib/api-client';

const POLL_INTERVAL_MS = 10000;

// eslint-disable-next-line max-lines-per-function -- page component with template grid and trigger dialog
export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<TemplateDetailRecord | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchTemplates = async () => {
    try {
      const data = await api.getTemplates();
      setTemplates(data);
    } catch {
      /* polling failure */
    }
  };

  useEffect(() => {
    void fetchTemplates();
    timerRef.current = setInterval(() => void fetchTemplates(), POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const openTriggerDialog = async (name: string) => {
    try {
      const detail = await api.getTemplate(name);
      setTriggerTarget(detail);
      setTriggerParams({});
      setTriggerResult(null);
    } catch {
      /* */
    }
  };

  const handleTrigger = async () => {
    if (!triggerTarget) return;
    setTriggering(true);
    try {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(triggerParams)) {
        if (v) params[k] = v;
      }
      const result = await api.triggerTemplate(
        triggerTarget.name,
        Object.keys(params).length > 0 ? params : undefined,
      );
      setTriggerResult(`Task tree created: ${result.treeId}`);
    } catch (err) {
      setTriggerResult(`Error: ${(err as Error).message}`);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Templates</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Reusable task tree templates with configurable triggers.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t) => (
          <div
            key={t.name}
            className="p-4 rounded-lg space-y-3"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <div>
              <h3 className="font-semibold text-sm">{t.displayName}</h3>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {t.name}
              </p>
            </div>
            {t.description && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {t.description}
              </p>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(59,130,246,0.2)', color: 'rgb(96,165,250)' }}
              >
                {t.taskCount} tasks
              </span>
              {t.triggers.map((tr, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(168,85,247,0.2)', color: 'rgb(192,132,252)' }}
                >
                  {tr.type}
                </span>
              ))}
            </div>
            <button
              onClick={() => void openTriggerDialog(t.name)}
              className="w-full px-3 py-1.5 rounded text-xs font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              Trigger
            </button>
          </div>
        ))}
      </div>

      {templates.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          No templates found. Define templates in your project config files.
        </div>
      )}

      {/* Trigger Dialog */}
      {triggerTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <div
            className="rounded-lg border p-6 w-full max-w-md"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          >
            <h2 className="text-lg font-bold mb-1">Trigger: {triggerTarget.displayName}</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              {triggerTarget.description}
            </p>

            {Object.keys(triggerTarget.params).length > 0 && (
              <div className="space-y-3 mb-4">
                <p className="text-xs font-medium">Parameters:</p>
                {Object.entries(triggerTarget.params).map(([key, param]) => (
                  <div key={key}>
                    <label className="block text-xs font-medium mb-1">
                      {key}
                      {param.required && <span style={{ color: '#ef4444' }}> *</span>}
                    </label>
                    {param.description && (
                      <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                        {param.description}
                      </p>
                    )}
                    <input
                      type="text"
                      value={triggerParams[key] ?? (param.default != null ? String(param.default) : '')}
                      onChange={(e) =>
                        setTriggerParams((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={param.type}
                      className="w-full px-3 py-1.5 rounded border text-sm"
                      style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                    />
                  </div>
                ))}
              </div>
            )}

            {triggerResult && (
              <p
                className="text-xs mb-3 px-3 py-2 rounded"
                style={{
                  background: triggerResult.startsWith('Error')
                    ? 'rgba(239,68,68,0.1)'
                    : 'rgba(34,197,94,0.1)',
                  color: triggerResult.startsWith('Error') ? '#ef4444' : '#22c55e',
                }}
              >
                {triggerResult}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setTriggerTarget(null)}
                className="px-4 py-2 rounded text-sm"
                style={{ color: 'var(--text-muted)' }}
              >
                Close
              </button>
              <button
                onClick={() => void handleTrigger()}
                disabled={triggering}
                className="px-4 py-2 rounded text-sm font-medium text-white"
                style={{ background: triggering ? 'var(--text-muted)' : 'var(--accent)' }}
              >
                {triggering ? 'Triggering...' : 'Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
