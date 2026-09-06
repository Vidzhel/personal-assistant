'use client';

import { useId } from 'react';
import type { ModelCatalogEntry, ModelConfig } from '@raven/shared';
import type { useModelCatalog } from '@/hooks/useModelCatalog';
import { EFFORT_LEVELS, type ModelConfigDraft } from '@/lib/model-config';

const MODEL_PRESET_ALIASES = ['haiku', 'sonnet', 'opus'] as const;

function CatalogRefreshButton({ refresh }: { refresh: () => void }) {
  return (
    <button type="button" onClick={refresh} className="mt-1 text-xs underline">
      Refresh model catalog
    </button>
  );
}

export function ModelCatalogStatus({
  catalog,
  loading,
  error,
  refresh,
}: ReturnType<typeof useModelCatalog>) {
  if (loading)
    return (
      <p role="status" className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Loading reported model capabilities…
      </p>
    );
  if (error)
    return (
      <div role="alert" className="text-xs" style={{ color: 'var(--error)' }}>
        <p>
          Model catalog unavailable: {error} Default model selection remains available. Effort and
          thinking choices need capability data.
        </p>
        <CatalogRefreshButton refresh={refresh} />
      </div>
    );
  if (!catalog) return null;
  if (catalog.stale || catalog.error)
    return (
      <div role="status" className="text-xs" style={{ color: 'var(--warning, #d97706)' }}>
        <p>
          Model catalog is stale{catalog.error ? `: ${catalog.error}` : '.'} The selection is
          validated against cached capability data when saved.
        </p>
        <CatalogRefreshButton refresh={refresh} />
      </div>
    );
  return (
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
      Reported availability is not an entitlement check. Raven validates the selection when saved.
    </p>
  );
}

function ModelField(props: {
  id: string;
  draft: ModelConfigDraft;
  models: ModelCatalogEntry[];
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const { id, draft, models, disabled, onChange } = props;
  const presetOptions = MODEL_PRESET_ALIASES.filter(
    (alias) => !models.some((model) => model.id === alias),
  );
  const selectedHasOption =
    models.some((model) => model.id === draft.model) ||
    presetOptions.includes(draft.model as (typeof MODEL_PRESET_ALIASES)[number]);
  return (
    <label htmlFor={`${id}-model`} className="space-y-1 text-xs">
      <span className="block font-medium">Model</span>
      <select
        id={`${id}-model`}
        value={draft.model}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
      >
        <option value="">Inherit model</option>
        {draft.model && !selectedHasOption && (
          <option value={draft.model}>Current: {draft.model}</option>
        )}
        {presetOptions.map((alias) => (
          <option key={alias} value={alias}>
            {alias[0].toUpperCase() + alias.slice(1)} preset
          </option>
        ))}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

function EffortField(props: {
  id: string;
  draft: ModelConfigDraft;
  selected?: ModelCatalogEntry;
  disabled: boolean;
  onChange: (effort: ModelConfigDraft['effort']) => void;
}) {
  const { id, draft, selected, disabled, onChange } = props;
  const supports = (effort: NonNullable<ModelConfig['effort']>) =>
    !selected ||
    (selected.supportsEffort === true && selected.supportedEffortLevels?.includes(effort) === true);
  return (
    <label htmlFor={`${id}-effort`} className="space-y-1 text-xs">
      <span className="block font-medium">Effort</span>
      <select
        id={`${id}-effort`}
        value={draft.effort}
        onChange={(event) => onChange(event.target.value as ModelConfigDraft['effort'])}
        disabled={disabled}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
      >
        <option value="">Inherit setting</option>
        {EFFORT_LEVELS.map((effort) => (
          <option key={effort} value={effort} disabled={!supports(effort)}>
            {effort}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThinkingField(props: {
  id: string;
  draft: ModelConfigDraft;
  selected?: ModelCatalogEntry;
  disabled: boolean;
  onChange: (thinking: ModelConfigDraft['thinking']) => void;
}) {
  const { id, draft, selected, disabled, onChange } = props;
  return (
    <label htmlFor={`${id}-thinking`} className="space-y-1 text-xs">
      <span className="block font-medium">
        Thinking{selected?.mandatoryThinking ? ' (required)' : ''}
      </span>
      <select
        id={`${id}-thinking`}
        value={draft.thinking}
        onChange={(event) => onChange(event.target.value as ModelConfigDraft['thinking'])}
        disabled={disabled}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
      >
        <option value="">Inherit setting</option>
        <option
          value="adaptive"
          disabled={selected !== undefined && selected.supportsAdaptiveThinking !== true}
        >
          Adaptive
        </option>
        <option value="disabled" disabled={selected?.mandatoryThinking === true}>
          Disabled
        </option>
      </select>
    </label>
  );
}

export function ModelConfigFields(props: {
  draft: ModelConfigDraft;
  models: ModelCatalogEntry[];
  selected?: ModelCatalogEntry;
  disabled: boolean;
  onChange: (patch: Partial<ModelConfigDraft>) => void;
}) {
  const { draft, models, selected, disabled, onChange } = props;
  const id = useId();
  return (
    <>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <ModelField
          {...{ id, draft, models, disabled }}
          onChange={(model) => onChange({ model })}
        />
        <EffortField
          {...{ id, draft, selected, disabled }}
          onChange={(effort) => onChange({ effort })}
        />
        <ThinkingField
          {...{ id, draft, selected, disabled }}
          onChange={(thinking) => onChange({ thinking })}
        />
      </div>
      {selected?.description && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {selected.description}
        </p>
      )}
    </>
  );
}
