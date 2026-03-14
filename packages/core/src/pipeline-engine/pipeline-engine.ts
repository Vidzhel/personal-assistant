import { createLogger } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import {
  createPipelineLoader,
  type PipelineLoader,
  type ValidatedPipeline,
} from './pipeline-loader.ts';

const log = createLogger('pipeline-engine');

export interface PipelineEngine {
  initialize: (configDir: string) => void;
  getPipeline: (name: string) => ValidatedPipeline | undefined;
  getAllPipelines: () => ValidatedPipeline[];
  shutdown: () => void;
}

export interface PipelineEngineDeps {
  eventBus: EventBus;
}

export function createPipelineEngine(deps: PipelineEngineDeps): PipelineEngine {
  let loader: PipelineLoader | null = null;

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

    shutdown(): void {
      if (loader) {
        loader.shutdown();
        loader = null;
        log.info('Pipeline engine shut down');
      }
    },
  };
}
