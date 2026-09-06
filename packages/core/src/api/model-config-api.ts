import type { ModelConfig } from '@raven/shared';

export interface ModelConfigApiContext {
  projectId: string;
  sessionId?: string;
  project?: ModelConfig | null;
  session?: ModelConfig | null;
}

export type ModelConfigValidator = (
  config: ModelConfig | null,
  context: ModelConfigApiContext,
) => void | Promise<void>;

export type EffectiveModelConfigResolver = (context: ModelConfigApiContext) => ModelConfig;

export interface EffectiveModelConfigProjection {
  effectiveModelConfig?: ModelConfig;
  modelConfigError?: string;
}

export function effectiveModelConfigProjection(
  resolver: EffectiveModelConfigResolver | undefined,
  context: ModelConfigApiContext,
): EffectiveModelConfigProjection {
  if (!resolver) return {};
  try {
    return { effectiveModelConfig: resolver(context) };
  } catch (error) {
    return { modelConfigError: error instanceof Error ? error.message : String(error) };
  }
}
