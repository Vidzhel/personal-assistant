import type { ModelCatalogEntry, ModelConfig } from '@raven/shared';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ModelConfigDraft = {
  model: string;
  effort: NonNullable<ModelConfig['effort']> | '';
  thinking: NonNullable<ModelConfig['thinking']> | '';
};

export function draftFromModelConfig(config?: ModelConfig): ModelConfigDraft {
  return {
    model: config?.model ?? '',
    effort: config?.effort ?? '',
    thinking: config?.thinking ?? '',
  };
}

export function modelConfigFromDraft(draft: ModelConfigDraft): ModelConfig | null {
  const config: ModelConfig = {
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
  };
  return Object.keys(config).length === 0 ? null : config;
}

export function selectedCatalogModel(
  models: ModelCatalogEntry[],
  model: string,
): ModelCatalogEntry | undefined {
  return models.find((entry) => entry.id === model || entry.aliases.includes(model));
}

export function modelForCapabilityLookup(draft: ModelConfigDraft, effective?: ModelConfig): string {
  return draft.model || effective?.model || '';
}

export function modelConfigError(
  draft: ModelConfigDraft,
  selected: ModelCatalogEntry | undefined,
): string | undefined {
  if (!selected) return undefined;
  return effortError(draft, selected) ?? thinkingError(draft, selected);
}

function effortError(draft: ModelConfigDraft, selected: ModelCatalogEntry): string | undefined {
  if (draft.effort && selected.supportsEffort !== true) {
    return `${selected.displayName} does not support effort controls.`;
  }
  if (draft.effort && !selected.supportedEffortLevels?.includes(draft.effort)) {
    return `${selected.displayName} does not support ${draft.effort} effort.`;
  }
  return undefined;
}

function thinkingError(draft: ModelConfigDraft, selected: ModelCatalogEntry): string | undefined {
  if (draft.thinking === 'adaptive' && selected.supportsAdaptiveThinking !== true) {
    return `${selected.displayName} does not support adaptive thinking.`;
  }
  if (draft.thinking === 'disabled' && selected.mandatoryThinking) {
    return `${selected.displayName} requires thinking and cannot turn it off.`;
  }
  return undefined;
}

export function describeModelConfig(config: ModelConfig): string {
  return [
    config.model ?? 'inherited model',
    config.effort ? `${config.effort} effort` : 'inherited effort',
    config.thinking ? `${config.thinking} thinking` : 'inherited thinking',
  ].join(' · ');
}

export function hasModelConfig(config?: ModelConfig): config is ModelConfig {
  return Boolean(config && Object.keys(config).length > 0);
}
