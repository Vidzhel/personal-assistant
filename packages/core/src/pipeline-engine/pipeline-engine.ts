import { createLogger, generateId } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { McpManager } from '../mcp-manager/mcp-manager.ts';
import {
  createPipelineLoader,
  type PipelineLoader,
  type ValidatedPipeline,
} from './pipeline-loader.ts';
import {
  createPipelineExecutor,
  type PipelineExecutor,
  type PipelineRunResult,
} from './pipeline-executor.ts';
import type { PipelineStore } from './pipeline-store.ts';

const log = createLogger('pipeline-engine');

export interface TriggerResult {
  runId: string;
  execution: Promise<PipelineRunResult>;
}

export interface PipelineEngine {
  initialize: (configDir: string) => void;
  getPipeline: (name: string) => ValidatedPipeline | undefined;
  getAllPipelines: () => ValidatedPipeline[];
  executePipeline: (name: string, triggerType: string) => Promise<PipelineRunResult>;
  triggerPipeline: (name: string, triggerType: string) => TriggerResult;
  shutdown: () => void;
}

export interface PipelineEngineDeps {
  eventBus: EventBus;
  suiteRegistry?: SuiteRegistry;
  mcpManager?: McpManager;
  pipelineStore?: PipelineStore;
}

export function createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine {
  let loader: PipelineLoader | null = null;
  let executor: PipelineExecutor | null = null;

  // Create executor if all deps are available
  if (deps.suiteRegistry && deps.mcpManager && deps.pipelineStore) {
    executor = createPipelineExecutor({
      eventBus: deps.eventBus,
      suiteRegistry: deps.suiteRegistry,
      mcpManager: deps.mcpManager,
      pipelineStore: deps.pipelineStore,
    });
  }

  return {
    initialize(configDir: string): void {
      loader = createPipelineLoader({ eventBus: deps.eventBus });
      loader.loadFromDirectory(configDir);
      loader.watch(configDir);
      log.info(`Pipeline engine initialized: ${configDir}`);
    },

    getPipeline(name: string): ValidatedPipeline | undefined {
      return loader?.getPipeline(name);
    },

    getAllPipelines(): ValidatedPipeline[] {
      return loader?.getAllPipelines() ?? [];
    },

    async executePipeline(name: string, triggerType: string): Promise<PipelineRunResult> {
      const pipeline = loader?.getPipeline(name);
      if (!pipeline) {
        throw new Error(`Pipeline not found: ${name}`);
      }
      if (!pipeline.config.enabled) {
        throw new Error(`Pipeline is disabled: ${name}`);
      }
      if (!executor) {
        throw new Error('Pipeline executor not initialized — missing dependencies');
      }
      return executor.executePipeline(pipeline, triggerType);
    },

    triggerPipeline(name: string, triggerType: string): TriggerResult {
      const pipeline = loader?.getPipeline(name);
      if (!pipeline) {
        throw new Error(`Pipeline not found: ${name}`);
      }
      if (!pipeline.config.enabled) {
        throw new Error(`Pipeline is disabled: ${name}`);
      }
      if (!executor) {
        throw new Error('Pipeline executor not initialized — missing dependencies');
      }
      const runId = generateId();
      const execution = executor.executePipeline(pipeline, triggerType, { runId });
      return { runId, execution };
    },

    shutdown(): void {
      if (loader) {
        loader.shutdown();
        loader = null;
        log.info('Pipeline engine shut down');
      }
    },
  };
}
