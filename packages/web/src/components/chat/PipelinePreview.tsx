'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';

type PreviewState = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

function extractPipelineName(yaml: string): string | null {
  const match = /^name:\s*(.+)$/m.exec(yaml);
  return match ? match[1].trim() : null;
}

function SavedIndicator() {
  return (
    <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>
      Saved
    </span>
  );
}

function SavingIndicator() {
  return (
    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
      Saving...
    </span>
  );
}

function ActionButtons({
  onSave,
  onEdit,
  onCancel,
  errorMsg,
}: {
  onSave: () => void;
  onEdit: () => void;
  onCancel: () => void;
  errorMsg: string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onSave}
        className="px-3 py-1 rounded text-xs font-medium"
        style={{ background: 'var(--accent)', color: 'white' }}
      >
        Save
      </button>
      <button
        onClick={onEdit}
        className="px-3 py-1 rounded text-xs font-medium"
        style={{ background: 'var(--bg-hover)', color: 'var(--text)' }}
      >
        Edit
      </button>
      <button
        onClick={onCancel}
        className="px-3 py-1 rounded text-xs font-medium"
        style={{ color: 'var(--text-muted)' }}
      >
        Cancel
      </button>
      {errorMsg && (
        <span className="text-xs" style={{ color: 'var(--error)' }}>
          {errorMsg}
        </span>
      )}
    </div>
  );
}

function PreviewActions({
  state,
  onSave,
  onEdit,
  onCancel,
  errorMsg,
}: {
  state: PreviewState;
  onSave: () => void;
  onEdit: () => void;
  onCancel: () => void;
  errorMsg: string | null;
}) {
  if (state === 'saved') return <SavedIndicator />;
  if (state === 'saving') return <SavingIndicator />;
  return <ActionButtons onSave={onSave} onEdit={onEdit} onCancel={onCancel} errorMsg={errorMsg} />;
}

function YamlEditor({ yaml, onChange }: { yaml: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={yaml}
      onChange={(e) => onChange(e.target.value)}
      className="w-full p-3 font-mono text-xs"
      style={{
        background: 'var(--bg-card)',
        color: 'var(--text)',
        minHeight: '200px',
        resize: 'vertical',
        outline: 'none',
      }}
    />
  );
}

function YamlDisplay({ yaml }: { yaml: string }) {
  return (
    <pre
      className="p-3 overflow-x-auto font-mono text-xs whitespace-pre-wrap"
      style={{ color: 'var(--text)' }}
    >
      {yaml}
    </pre>
  );
}

function usePipelineSave(initialYaml: string, onDismiss: () => void) {
  const [state, setState] = useState<PreviewState>('idle');
  const [yaml, setYaml] = useState(initialYaml);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSave = async () => {
    const name = extractPipelineName(yaml);
    if (!name) {
      setErrorMsg('Missing pipeline name');
      setState('error');
      return;
    }
    setState('saving');
    setErrorMsg(null);
    try {
      await api.savePipeline(name, yaml);
      setState('saved');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
      setState('error');
    }
  };

  const handleEdit = () => setState('editing');
  const handleCancel = () => {
    if (state === 'editing') {
      setYaml(initialYaml);
      setState('idle');
    } else {
      onDismiss();
    }
  };

  return { state, yaml, setYaml, errorMsg, handleSave, handleEdit, handleCancel };
}

export function PipelinePreview({
  yaml: initialYaml,
  onDismiss,
}: {
  yaml: string;
  onDismiss: () => void;
}) {
  const { state, yaml, setYaml, errorMsg, handleSave, handleEdit, handleCancel } = usePipelineSave(
    initialYaml,
    onDismiss,
  );

  return (
    <div
      className="rounded-lg overflow-hidden text-sm"
      style={{ border: '1px solid var(--border)', background: 'var(--bg-card)' }}
    >
      <PreviewHeader
        state={state}
        onSave={handleSave}
        onEdit={handleEdit}
        onCancel={handleCancel}
        errorMsg={errorMsg}
      />
      {state === 'editing' ? (
        <YamlEditor yaml={yaml} onChange={setYaml} />
      ) : (
        <YamlDisplay yaml={yaml} />
      )}
    </div>
  );
}

function PreviewHeader(props: {
  state: PreviewState;
  onSave: () => void;
  onEdit: () => void;
  onCancel: () => void;
  errorMsg: string | null;
}) {
  return (
    <div
      className="flex items-center justify-between px-3 py-1.5"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)' }}
    >
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        Pipeline YAML
      </span>
      <PreviewActions {...props} />
    </div>
  );
}
