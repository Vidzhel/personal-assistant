'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ModelConfig } from '@raven/shared';
import { Button } from '@/components/ui/Button';
import { ModelCatalogStatus, ModelConfigFields } from './ModelConfigFields';
import { useModelCatalog } from '@/hooks/useModelCatalog';
import {
  describeModelConfig,
  draftFromModelConfig,
  hasModelConfig,
  modelForCapabilityLookup,
  modelConfigError,
  modelConfigFromDraft,
  selectedCatalogModel,
  type ModelConfigDraft,
} from '@/lib/model-config';

interface ModelConfigControlProps {
  scope: 'session' | 'project';
  value?: ModelConfig;
  effectiveValue?: ModelConfig;
  disabled?: boolean;
  active?: boolean;
  onCatalogLoaded?: () => void;
  onSave: (config: ModelConfig | null) => Promise<boolean | undefined>;
}

function scopeCopy(scope: ModelConfigControlProps['scope']): {
  title: string;
  inherited: string;
} {
  return scope === 'session'
    ? { title: 'Session model', inherited: 'Project, agent, or installation settings' }
    : { title: 'Project model default', inherited: 'Agent or installation settings' };
}

function CurrentModelConfig({
  scope,
  value,
  effectiveValue,
}: Pick<ModelConfigControlProps, 'scope' | 'value' | 'effectiveValue'>) {
  const copy = scopeCopy(scope);
  return (
    <div className="space-y-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
      <p>
        <strong style={{ color: 'var(--text)' }}>
          {hasModelConfig(value) ? 'Override' : 'Inherited'}:
        </strong>{' '}
        {hasModelConfig(value) ? describeModelConfig(value) : copy.inherited}
      </p>
      {hasModelConfig(effectiveValue) && <p>Effective: {describeModelConfig(effectiveValue)}</p>}
    </div>
  );
}

function useModelConfigEditor(
  value: ModelConfig | undefined,
  onSave: ModelConfigControlProps['onSave'],
) {
  const model = value?.model;
  const effort = value?.effort;
  const thinking = value?.thinking;
  const [draft, setDraft] = useState(() => draftFromModelConfig(value));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; saved?: string }>({});
  useEffect(() => {
    setDraft(draftFromModelConfig({ model, effort, thinking }));
    setFeedback({});
  }, [model, effort, thinking]);
  const updateDraft = (patch: Partial<ModelConfigDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFeedback({});
  };
  const save = async (config: ModelConfig | null) => {
    setSaving(true);
    setFeedback({});
    try {
      const result = await onSave(config);
      if (result === false) {
        setFeedback({ error: 'The setting was not saved. Review the project error and retry.' });
        return;
      }
      setFeedback({ saved: 'Saved. This applies to the next turn.' });
    } catch (cause) {
      setFeedback({
        error: cause instanceof Error ? cause.message : 'Could not save model settings.',
      });
    } finally {
      setSaving(false);
    }
  };
  return { draft, saving, feedback, updateDraft, save };
}

function ModelConfigNotices({
  catalogState,
  active,
  validationError,
  feedback,
}: {
  catalogState: ReturnType<typeof useModelCatalog>;
  active: boolean;
  validationError?: string;
  feedback: { error?: string; saved?: string };
}) {
  return (
    <>
      <ModelCatalogStatus {...catalogState} />
      {active && (
        <p role="status" className="text-xs" style={{ color: 'var(--text-muted)' }}>
          The active response keeps its admitted settings. Changes apply to the next turn.
        </p>
      )}
      {validationError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>
          {validationError}
        </p>
      )}
      <span aria-live="polite" className="text-xs">
        {feedback.error && <span style={{ color: 'var(--error)' }}>{feedback.error}</span>}
        {feedback.saved && <span style={{ color: 'var(--text-muted)' }}>{feedback.saved}</span>}
      </span>
    </>
  );
}

function ModelConfigActions({
  value,
  draft,
  disabled,
  saving,
  validationError,
  onSave,
}: {
  value?: ModelConfig;
  draft: ModelConfigDraft;
  disabled: boolean;
  saving: boolean;
  validationError?: string;
  onSave: (config: ModelConfig | null) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() => void onSave(modelConfigFromDraft(draft))}
        disabled={disabled || saving || Boolean(validationError)}
        loading={saving}
      >
        Save for next turn
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void onSave(null)}
        disabled={disabled || saving || !hasModelConfig(value)}
      >
        Clear override
      </Button>
    </div>
  );
}

function ModelConfigBody(props: ModelConfigControlProps) {
  const { scope, value, effectiveValue, disabled = false, active = false, onSave } = props;
  const catalogState = useModelCatalog(props.onCatalogLoaded);
  const models = catalogState.catalog?.models ?? [];
  const editor = useModelConfigEditor(value, onSave);
  const selected = useMemo(
    () => selectedCatalogModel(models, modelForCapabilityLookup(editor.draft, effectiveValue)),
    [editor.draft, effectiveValue, models],
  );
  const validationError = modelConfigError(editor.draft, selected);

  return (
    <div className="mt-3 space-y-3">
      <CurrentModelConfig scope={scope} value={value} effectiveValue={effectiveValue} />
      <ModelConfigFields
        draft={editor.draft}
        models={models}
        selected={selected}
        disabled={disabled || editor.saving}
        onChange={editor.updateDraft}
      />
      <ModelConfigNotices
        catalogState={catalogState}
        active={active}
        validationError={validationError}
        feedback={editor.feedback}
      />
      <ModelConfigActions
        value={value}
        draft={editor.draft}
        disabled={disabled}
        saving={editor.saving}
        validationError={validationError}
        onSave={editor.save}
      />
    </div>
  );
}

export function ModelConfigControl(props: ModelConfigControlProps) {
  return (
    <details className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
      <summary className="cursor-pointer text-sm font-medium">
        {scopeCopy(props.scope).title}
      </summary>
      <ModelConfigBody {...props} />
    </details>
  );
}
