'use client';

import { useState, useEffect } from 'react';
import { useAgentStore } from '@/stores/agent-store';
import { CreateSuiteForm } from './CreateSuiteForm';

// eslint-disable-next-line max-lines-per-function, complexity -- React form component
export function AgentFormModal() {
  const {
    agents,
    availableSuites,
    editingAgentId,
    loading,
    error,
    closeForm,
    createAgent,
    updateAgent,
    fetchSuites,
  } = useAgentStore();

  const editing = editingAgentId ? agents.find((a) => a.id === editingAgentId) : null;

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [instructions, setInstructions] = useState(editing?.instructions ?? '');
  const [selectedSuites, setSelectedSuites] = useState<Set<string>>(
    new Set(editing?.suiteIds ?? []),
  );
  const [showCreateSuite, setShowCreateSuite] = useState(false);
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setDescription(editing.description ?? '');
      setInstructions(editing.instructions ?? '');
      setSelectedSuites(new Set(editing.suiteIds));
    }
  }, [editing]);

  function validateName(value: string) {
    if (!value) {
      setNameError('Name is required');
      return false;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      setNameError('Must be kebab-case (lowercase letters, numbers, hyphens)');
      return false;
    }
    setNameError('');
    return true;
  }

  function toggleSuite(suiteName: string) {
    setSelectedSuites((prev) => {
      const next = new Set(prev);
      if (next.has(suiteName)) {
        next.delete(suiteName);
      } else {
        next.add(suiteName);
      }
      return next;
    });
  }

  async function handleSubmit() {
    if (!validateName(name)) return;
    const data = {
      name,
      description: description || undefined,
      instructions: instructions || undefined,
      suiteIds: Array.from(selectedSuites),
    };

    if (editing) {
      await updateAgent(editing.id, data);
    } else {
      await createAgent(data);
    }
  }

  function handleSuiteCreated() {
    setShowCreateSuite(false);
    void fetchSuites();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
    >
      <div
        className="rounded-lg border p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <h2 className="text-lg font-bold mb-4">{editing ? 'Edit Agent' : 'Create Agent'}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                validateName(e.target.value);
              }}
              onBlur={() => validateName(name)}
              placeholder="my-agent"
              className="w-full px-3 py-2 rounded border text-sm"
              style={{
                borderColor: nameError ? '#ef4444' : 'var(--border)',
                background: 'var(--bg-card)',
              }}
              disabled={editing?.isDefault}
            />
            {nameError && (
              <p className="text-xs mt-1" style={{ color: '#ef4444' }}>
                {nameError}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent does..."
              className="w-full px-3 py-2 rounded border text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Instructions</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Additional system prompt instructions for this agent..."
              rows={4}
              className="w-full px-3 py-2 rounded border text-sm resize-y"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Suite Bindings</label>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              No suites selected = access to all suites
            </p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {availableSuites.map((suite) => (
                <label key={suite.name} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedSuites.has(suite.name)}
                    onChange={() => toggleSuite(suite.name)}
                  />
                  <span>{suite.displayName}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    ({suite.name})
                  </span>
                </label>
              ))}
            </div>
            <button
              onClick={() => setShowCreateSuite(true)}
              className="text-xs mt-2 underline"
              style={{ color: 'var(--accent)' }}
            >
              + Create New Suite
            </button>
          </div>

          {showCreateSuite && (
            <CreateSuiteForm
              onCreated={handleSuiteCreated}
              onCancel={() => setShowCreateSuite(false)}
            />
          )}
        </div>

        {error && (
          <p
            className="text-xs mt-2 px-3 py-2 rounded"
            style={{ color: '#ef4444', background: 'rgba(239,68,68,0.1)' }}
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={closeForm}
            className="px-4 py-2 rounded text-sm"
            style={{ color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={loading}
            className="px-4 py-2 rounded text-sm font-medium text-white"
            style={{ background: loading ? 'var(--text-muted)' : 'var(--accent)' }}
          >
            {loading ? 'Saving...' : editing ? 'Save Changes' : 'Create Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
