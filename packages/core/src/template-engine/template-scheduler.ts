import { Cron } from 'croner';
import { createLogger, generateId } from '@raven/shared';
import type { EventBusInterface, TaskTemplate } from '@raven/shared';

import type { TemplateRegistry } from './template-registry.ts';
import type { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import { instantiateTemplate } from './template-instantiator.ts';

const logger = createLogger('template-scheduler');

export interface TemplateSchedulerDeps {
  templateRegistry: TemplateRegistry;
  executionEngine: TaskExecutionEngine;
  eventBus: EventBusInterface;
}

export interface TemplateScheduler {
  start: () => void;
  stop: () => void;
  triggerTemplate: (name: string, params?: Record<string, unknown>) => Promise<string>;
}

// eslint-disable-next-line max-lines-per-function -- factory function with start/stop/trigger
export function createTemplateScheduler(deps: TemplateSchedulerDeps): TemplateScheduler {
  const { templateRegistry, executionEngine, eventBus } = deps;

  const cronJobs: Cron[] = [];
  const eventHandlers: Array<{ eventType: string; handler: (event: unknown) => void }> = [];

  function triggerFromTemplate(template: TaskTemplate, params: Record<string, unknown>): string {
    const treeId = generateId();
    const { nodes, errors } = instantiateTemplate(template, params);

    if (errors.length > 0) {
      logger.warn(`Template "${template.name}" instantiation had errors: ${errors.join(', ')}`);
    }

    if (nodes.length === 0) {
      throw new Error(`Template "${template.name}" produced zero tasks`);
    }

    executionEngine.createTree({
      id: treeId,
      plan: template.description,
      tasks: nodes,
    });

    if (template.plan.approval === 'auto') {
      executionEngine.startTree(treeId).catch((err: unknown) => {
        logger.error(`Failed to auto-start tree ${treeId}: ${err}`);
      });
    }

    logger.info(
      `Template "${template.name}" triggered → tree ${treeId} (${String(nodes.length)} tasks, approval=${template.plan.approval})`,
    );

    return treeId;
  }

  function start(): void {
    const templates = templateRegistry.getAllTemplates();

    for (const template of templates) {
      for (const trigger of template.trigger) {
        if (trigger.type === 'schedule') {
          const job = new Cron(trigger.cron, { timezone: trigger.timezone }, () => {
            logger.info(`Cron triggered template: ${template.name}`);
            try {
              triggerFromTemplate(template, {});
            } catch (err) {
              logger.error(`Cron trigger failed for "${template.name}": ${err}`);
            }
          });
          cronJobs.push(job);
          logger.info(`Registered cron job for template "${template.name}": ${trigger.cron}`);
        } else if (trigger.type === 'event') {
          const eventType = trigger.eventType;
          const handler = (event: unknown): void => {
            logger.info(`Event "${eventType}" triggered template: ${template.name}`);
            try {
              triggerFromTemplate(template, { event });
            } catch (err) {
              logger.error(`Event trigger failed for "${template.name}": ${err}`);
            }
          };
          eventBus.on(eventType, handler);
          eventHandlers.push({ eventType, handler });
          logger.info(`Registered event handler for template "${template.name}": ${eventType}`);
        }
        // 'manual' triggers are not auto-registered
      }
    }

    const scheduleCount = cronJobs.length;
    const eventCount = eventHandlers.length;
    logger.info(
      `Template scheduler started: ${String(scheduleCount)} cron, ${String(eventCount)} event triggers`,
    );
  }

  function stop(): void {
    for (const job of cronJobs) {
      job.stop();
    }
    cronJobs.length = 0;

    for (const { eventType, handler } of eventHandlers) {
      eventBus.off(eventType, handler);
    }
    eventHandlers.length = 0;

    logger.info('Template scheduler stopped');
  }

  async function triggerTemplate(name: string, params?: Record<string, unknown>): Promise<string> {
    const template = templateRegistry.getTemplate(name);
    if (!template) {
      throw new Error(`Template not found: "${name}"`);
    }
    return triggerFromTemplate(template, params ?? {});
  }

  return { start, stop, triggerTemplate };
}
