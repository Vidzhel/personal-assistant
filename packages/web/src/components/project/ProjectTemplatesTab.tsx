'use client';

import { useEffect, useState } from 'react';
import { api, type TemplateRecord, type TemplateDetailRecord } from '@/lib/api-client';
import type { ProjectTabProps } from './project-tab-registry';

// eslint-disable-next-line max-lines-per-function -- project templates tab with trigger dialog
export function ProjectTemplatesTab({ projectId }: ProjectTabProps) {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<TemplateDetailRecord | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);

  useEffect(() => {
    void api.getTemplates().then((all) => {
      // Show all templates — project scoping can be filtered once API supports it
      setTemplates(all);
    });
  }, [projectId]);

  const openTrigger = async (name: string) => {
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
    <div className="p-6 space-y-4 overflow-y-auto h-full">
      <h2 className="text-sm font-semibold">Templates</h2>

      {templates.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No templates available.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map((t) => (
            <div
              key={t.name}
              className="p-3 rounded-lg border space-y-2"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
            >
              <div>
                <h3 className="text-sm font-medium">{t.displayName}</h3>
                <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  {t.name}
                </p>
              </div>
              {t.description && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t.description}
                </p>
              )}
              <div className="flex items-center gap-2">
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(59,130,246,0.2)', color: 'rgb(96,165,250)' }}
                >
                  {t.taskCount} tasks
                </span>
                {t.trigger.map((tr, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(168,85,247,0.2)', color: 'rgb(192,132,252)' }}
                  >
                    {tr.type}
                  </span>
                ))}
              </div>
              {t.trigger.some((tr) => tr.type === 'manual') && (
                <button
                  onClick={() => void openTrigger(t.name)}
                  className="w-full px-3 py-1 rounded text-xs font-medium"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  Trigger
                </button>
              )}
            </div>
          ))}
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

            {Object.keys(triggerTarget.params).length > 0 && (
              <div className="space-y-3 mb-4">
                {Object.entries(triggerTarget.params).map(([key, param]) => (
                  <div key={key}>
                    <label className="block text-xs font-medium mb-1">
                      {key}
                      {param.required && <span style={{ color: '#ef4444' }}> *</span>}
                    </label>
                    <input
                      type="text"
                      value={
                        triggerParams[key] ?? (param.default != null ? String(param.default) : '')
                      }
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
