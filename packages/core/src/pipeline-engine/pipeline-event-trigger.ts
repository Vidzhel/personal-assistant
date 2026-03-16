import { createLogger } from '@raven/shared';
import type { RavenEvent, RavenEventType } from '@raven/shared';
import type { PipelineEngine } from './pipeline-engine.ts';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('pipeline-event-trigger');

export interface PipelineEventTrigger {
  registerPipelines: () => void;
  shutdown: () => void;
}

export interface PipelineEventTriggerDeps {
  pipelineEngine: PipelineEngine;
  eventBus: EventBus;
}

export function matchesFilter(
  eventPayload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, filterValue]) => {
    const payloadValue = eventPayload[key];
    if (payloadValue === undefined) return false;
    if (typeof filterValue === 'string' && typeof payloadValue === 'string') {
      return payloadValue.includes(filterValue);
    }
    return payloadValue === filterValue;
  });
}

// eslint-disable-next-line max-lines-per-function -- factory function that manages event listener lifecycle for pipeline triggers
export function createPipelineEventTrigger(deps: PipelineEventTriggerDeps): PipelineEventTrigger {
  const { pipelineEngine, eventBus } = deps;
  const handlers: Array<{ eventType: RavenEventType; handler: (event: RavenEvent) => void }> = [];

  function unsubscribeAll(): void {
    for (const { eventType, handler } of handlers) {
      eventBus.off(eventType, handler);
    }
    handlers.length = 0;
  }

  function registerEventListeners(): void {
    const pipelines = pipelineEngine.getAllPipelines();
    let count = 0;

    for (const pipeline of pipelines) {
      const { config } = pipeline;
      if (!config.enabled) continue;
      if (config.trigger.type !== 'event') continue;

      const { event: eventType, filter } = config.trigger;
      const name = config.name;

      const handler = (event: RavenEvent): void => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;

        if (filter && !matchesFilter(payload, filter)) {
          log.debug(`Event filter mismatch for pipeline ${name}`);
          return;
        }

        log.info(`Event ${eventType} matched pipeline: ${name}`);
        try {
          const { execution } = pipelineEngine.triggerPipeline(name, 'event');
          execution.catch((err: unknown) => {
            log.error(`Pipeline ${name} failed: ${err}`);
          });
        } catch (err: unknown) {
          log.error(`Failed to trigger pipeline ${name}: ${err}`);
        }
      };

      handlers.push({ eventType: eventType as RavenEventType, handler });
      eventBus.on(eventType as RavenEventType, handler);
      count++;
    }

    log.info(`Registered ${count} event triggers`);
  }

  function onPipelinesReloaded(): void {
    log.info('Pipelines reloaded — re-registering event triggers');
    unsubscribeAll();
    registerEventListeners();
  }

  return {
    registerPipelines(): void {
      eventBus.on('config:pipelines:reloaded', onPipelinesReloaded);
      registerEventListeners();
    },

    shutdown(): void {
      unsubscribeAll();
      eventBus.off('config:pipelines:reloaded', onPipelinesReloaded);
      log.info('Pipeline event trigger stopped');
    },
  };
}
