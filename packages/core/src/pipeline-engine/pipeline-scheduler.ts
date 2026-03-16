import { Cron } from 'croner';
import { createLogger } from '@raven/shared';
import type { PipelineCompleteEvent, PipelineFailedEvent } from '@raven/shared';
import type { PipelineEngine } from './pipeline-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('pipeline-scheduler');

export interface PipelineScheduler {
  registerPipelines: () => void;
  shutdown: () => void;
}

export interface PipelineSchedulerDeps {
  pipelineEngine: PipelineEngine;
  eventBus: EventBus;
  timezone: string;
}

// eslint-disable-next-line max-lines-per-function -- factory function that manages cron job lifecycle for pipeline triggers
export function createPipelineScheduler(deps: PipelineSchedulerDeps): PipelineScheduler {
  const { pipelineEngine, eventBus, timezone } = deps;
  const cronJobs = new Map<string, Cron>();
  const runningPipelines = new Set<string>();

  function onPipelineComplete(event: PipelineCompleteEvent): void {
    runningPipelines.delete(event.payload.pipelineName);
  }

  function onPipelineFailed(event: PipelineFailedEvent): void {
    runningPipelines.delete(event.payload.pipelineName);
  }

  function onPipelinesReloaded(): void {
    log.info('Pipelines reloaded — re-registering cron jobs');
    stopAllJobs();
    runningPipelines.clear();
    registerCronJobs();
  }

  function stopAllJobs(): void {
    for (const job of cronJobs.values()) {
      job.stop();
    }
    cronJobs.clear();
  }

  function registerCronJobs(): void {
    const pipelines = pipelineEngine.getAllPipelines();
    let count = 0;

    for (const pipeline of pipelines) {
      const { config } = pipeline;
      if (!config.enabled) continue;
      if (config.trigger.type !== 'cron') continue;

      const { schedule } = config.trigger;
      const name = config.name;

      const job = new Cron(schedule, { timezone }, () => {
        if (runningPipelines.has(name)) {
          log.warn(`Skipping cron fire for ${name} — already running`);
          return;
        }

        log.info(`Cron fired for pipeline: ${name}`);
        runningPipelines.add(name);

        try {
          const { execution } = pipelineEngine.triggerPipeline(name, 'cron');
          execution.catch((err: unknown) => {
            log.error(`Pipeline ${name} failed: ${err}`);
          });
        } catch (err: unknown) {
          runningPipelines.delete(name);
          log.error(`Failed to trigger pipeline ${name}: ${err}`);
        }
      });

      cronJobs.set(name, job);
      count++;
    }

    log.info(`Registered ${count} cron jobs`);
  }

  return {
    registerPipelines(): void {
      eventBus.on('pipeline:complete', onPipelineComplete);
      eventBus.on('pipeline:failed', onPipelineFailed);
      eventBus.on('config:pipelines:reloaded', onPipelinesReloaded);
      registerCronJobs();
    },

    shutdown(): void {
      stopAllJobs();
      runningPipelines.clear();
      eventBus.off('pipeline:complete', onPipelineComplete);
      eventBus.off('pipeline:failed', onPipelineFailed);
      eventBus.off('config:pipelines:reloaded', onPipelinesReloaded);
      log.info('Pipeline scheduler stopped');
    },
  };
}
