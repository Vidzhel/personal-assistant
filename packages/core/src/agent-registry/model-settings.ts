import {
  ModelConfigSchema,
  ModelIdSchema,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
  type ModelConfig,
  type ModelEffort,
  type ModelThinking,
} from '@raven/shared';

export const MODEL_ALIAS_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
} as const;

export type ModelConfigLayer = 'turn' | 'session' | 'project' | 'agent' | 'defaults';

export interface MandatoryThinkingPolicy {
  id: 'fable-5-1-adaptive-thinking';
  modelFamily: 'claude-fable-5-1';
  thinking: 'adaptive';
  documentedAt: '2026-09-06';
  documentationUrl: 'https://platform.claude.com/docs/en/models/fable-5-1/overview';
}

export interface ResolvedModelConfig {
  model: string;
  effort?: ModelEffort;
  thinking?: ModelThinking;
  metadata: ModelCatalogEntry | null;
  catalogRevision: number;
  source: {
    model: ModelConfigLayer;
    effort?: ModelConfigLayer;
    thinking?: ModelConfigLayer;
  };
  mandatoryThinkingPolicy: MandatoryThinkingPolicy | null;
}

export interface ResolveModelConfigInput {
  turn?: ModelConfig;
  session?: ModelConfig;
  project?: ModelConfig;
  agent?: ModelConfig;
  defaults: ModelConfig & { model: string };
}

export type ModelConfigValidator = (
  config: ModelConfig | null,
  context: { projectId: string; sessionId?: string },
) => void;

const FABLE_POLICY: MandatoryThinkingPolicy = {
  id: 'fable-5-1-adaptive-thinking',
  modelFamily: 'claude-fable-5-1',
  thinking: 'adaptive',
  documentedAt: '2026-09-06',
  documentationUrl: 'https://platform.claude.com/docs/en/models/fable-5-1/overview',
};

const FABLE_MODEL_PATTERN = /^claude-fable-5-1(?:$|[-.:]|\[1m\]$)/;

export function normalizeModelId(model: string): string {
  const parsed = ModelIdSchema.parse(model);
  return MODEL_ALIAS_IDS[parsed.toLowerCase() as keyof typeof MODEL_ALIAS_IDS] ?? parsed;
}

export function resolveModelConfig(
  input: ResolveModelConfigInput,
  snapshot: ModelCatalogSnapshot,
): ResolvedModelConfig {
  const layers = validatedLayers(input);
  const modelChoice = firstDefined(layers, 'model');
  if (!modelChoice) throw new Error('Installation model default is required');
  const effortChoice = firstDefined(layers, 'effort');
  const thinkingChoice = firstDefined(layers, 'thinking');
  const requestedModel = normalizeModelId(modelChoice.value);
  const metadata = findModelMetadata(snapshot, modelChoice.value, requestedModel);
  const model = metadata?.id ?? requestedModel;
  validateSelectedModel({ source: modelChoice.source, model, metadata, snapshot });
  validateEffort(model, effortChoice?.value, metadata);
  const policy = getMandatoryThinkingPolicy(model);
  const thinking = resolveThinking({ model, thinking: thinkingChoice?.value, metadata, policy });

  return {
    model,
    effort: effortChoice?.value,
    thinking,
    metadata,
    catalogRevision: snapshot.revision,
    source: {
      model: modelChoice.source,
      effort: effortChoice?.source,
      thinking: thinkingChoice?.source,
    },
    mandatoryThinkingPolicy: policy,
  };
}

function validatedLayers(input: ResolveModelConfigInput): Array<{
  source: ModelConfigLayer;
  config: ModelConfig;
}> {
  return [
    { source: 'turn', config: ModelConfigSchema.parse(input.turn ?? {}) },
    { source: 'session', config: ModelConfigSchema.parse(input.session ?? {}) },
    { source: 'project', config: ModelConfigSchema.parse(input.project ?? {}) },
    { source: 'agent', config: ModelConfigSchema.parse(input.agent ?? {}) },
    { source: 'defaults', config: ModelConfigSchema.parse(input.defaults) },
  ];
}

function firstDefined<K extends keyof ModelConfig>(
  layers: Array<{ source: ModelConfigLayer; config: ModelConfig }>,
  key: K,
): { source: ModelConfigLayer; value: NonNullable<ModelConfig[K]> } | undefined {
  for (const layer of layers) {
    const value = layer.config[key];
    if (value !== undefined) {
      return { source: layer.source, value: value as NonNullable<ModelConfig[K]> };
    }
  }
  return undefined;
}

function findModelMetadata(
  snapshot: ModelCatalogSnapshot,
  selectedModel: string,
  canonicalModel: string,
): ModelCatalogEntry | null {
  return (
    snapshot.models.find(
      (entry) =>
        normalizeModelId(entry.id) === canonicalModel ||
        entry.aliases.some(
          (alias) => alias === selectedModel || normalizeModelId(alias) === canonicalModel,
        ),
    ) ?? null
  );
}

function validateSelectedModel(params: {
  source: ModelConfigLayer;
  model: string;
  metadata: ModelCatalogEntry | null;
  snapshot: ModelCatalogSnapshot;
}): void {
  if (params.metadata || params.snapshot.models.length === 0 || params.source === 'defaults')
    return;
  throw new Error(
    `Model "${params.model}" is not present in catalog revision ${params.snapshot.revision}`,
  );
}

function validateEffort(
  model: string,
  effort: ModelEffort | undefined,
  metadata: ModelCatalogEntry | null,
): void {
  if (!effort) return;
  if (!metadata) throw new Error(`Cannot validate effort "${effort}" for model "${model}"`);
  if (!metadata.supportsEffort || !metadata.supportedEffortLevels?.includes(effort)) {
    throw new Error(`Model "${model}" does not support effort "${effort}"`);
  }
}

function resolveThinking(params: {
  model: string;
  thinking: ModelThinking | undefined;
  metadata: ModelCatalogEntry | null;
  policy: MandatoryThinkingPolicy | null;
}): ModelThinking | undefined {
  const { model, thinking, metadata, policy } = params;
  if (policy && thinking === 'disabled') {
    throw new Error(`Model "${model}" requires adaptive thinking`);
  }
  if (thinking === 'adaptive') {
    if (!metadata) throw new Error(`Cannot validate adaptive thinking for model "${model}"`);
    if (!metadata.supportsAdaptiveThinking) {
      throw new Error(`Model "${model}" does not support adaptive thinking`);
    }
  }
  if (thinking === 'disabled' && !metadata) {
    throw new Error(`Cannot validate disabled thinking for model "${model}"`);
  }
  return thinking ?? policy?.thinking;
}

export function getMandatoryThinkingPolicy(model: string): MandatoryThinkingPolicy | null {
  return FABLE_MODEL_PATTERN.test(model) ? FABLE_POLICY : null;
}
