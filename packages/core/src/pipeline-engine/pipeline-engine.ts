import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, generateId, gitAutoCommit, PipelineConfigSchema } from '@raven/shared';
import type { PipelineConfig } from '@raven/shared';
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
import { validateDag } from './dag-validator.ts';

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
  savePipeline: (name: string, yamlContent: string) => { config: PipelineConfig };
  deletePipeline: (name: string) => boolean;
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
  let storedConfigDir: string | null = null;

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
      storedConfigDir = configDir;
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

    savePipeline(name: string, yamlContent: string): { config: PipelineConfig } {
      if (!storedConfigDir) {
        throw new Error('Pipeline engine not initialized');
      }
      const parsed: unknown = parseYaml(yamlContent);
      const result = PipelineConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`Validation failed: ${result.error.message}`);
      }
      if (result.data.name !== name) {
        throw new Error('Pipeline name in body must match URL parameter');
      }
      const dagResult = validateDag(result.data.nodes, result.data.connections);
      if (!dagResult.valid) {
        throw new Error(`DAG validation failed: ${dagResult.error}`);
      }
      const filePath = join(storedConfigDir, `${name}.yaml`);
      writeFileSync(filePath, yamlContent, 'utf-8');
      loader?.reloadPipeline(filePath);
      gitAutoCommit([filePath], `chore: update pipeline ${name}`);
      return { config: result.data };
    },

    deletePipeline(name: string): boolean {
      if (!storedConfigDir) {
        throw new Error('Pipeline engine not initialized');
      }
      const filePath = join(storedConfigDir, `${name}.yaml`);
      if (!existsSync(filePath)) {
        return false;
      }
      unlinkSync(filePath);
      loader?.removePipeline(name);
      gitAutoCommit([filePath], `chore: remove pipeline ${name}`);
      return true;
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
