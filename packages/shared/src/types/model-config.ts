import { z } from 'zod';

// The SDK uses [1m] on both aliases and canonical extended-context model IDs.
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\[1m\])?$/;
const MAX_MODEL_ID_LENGTH = 128;

export const MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const MODEL_THINKING_MODES = ['adaptive', 'disabled'] as const;
export const MODEL_PRESET_ALIASES = ['haiku', 'sonnet', 'opus'] as const;

export type ModelEffort = (typeof MODEL_EFFORT_LEVELS)[number];
export type ModelThinking = (typeof MODEL_THINKING_MODES)[number];
export type ModelPresetAlias = (typeof MODEL_PRESET_ALIASES)[number];

/** Open model identifier validated independently of the provider SDK. */
export const ModelIdSchema = z
  .string()
  .min(1)
  .max(MAX_MODEL_ID_LENGTH)
  .regex(MODEL_ID_PATTERN, 'Invalid model identifier');

export const ModelEffortSchema = z.enum(MODEL_EFFORT_LEVELS);
export const ModelThinkingSchema = z.enum(MODEL_THINKING_MODES);

/** A stored override. Omitted properties inherit from the next lower layer. */
export const ModelConfigSchema = z
  .object({
    model: ModelIdSchema.optional(),
    effort: ModelEffortSchema.optional(),
    thinking: ModelThinkingSchema.optional(),
  })
  .strict();

/** Patch fields use null to reset the complete override atomically. */
export const ModelConfigOverrideSchema = ModelConfigSchema.nullable();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** Provider-neutral capability metadata exposed by Raven's model catalog. */
export interface ModelCatalogEntry {
  id: string;
  aliases: string[];
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ModelEffort[];
  supportsAdaptiveThinking?: boolean;
  /** True when Raven's documented model-family policy forbids disabling thinking. */
  mandatoryThinking?: boolean;
}

export interface ModelCatalogSnapshot {
  models: ModelCatalogEntry[];
  fetchedAt: string | null;
  revision: number;
  stale: boolean;
  error: string | null;
}
