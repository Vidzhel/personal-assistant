import { createLogger, gitAutoCommit, type RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('config-committer');

export interface ConfigCommitter {
  start: () => void;
  stop: () => Promise<void>;
}

const CONFIG_EVENT_TYPES = [
  'agent:config:created',
  'agent:config:updated',
  'agent:config:deleted',
] as const;

export function createConfigCommitter(deps: { eventBus: EventBus; cwd: string }): ConfigCommitter {
  const { eventBus } = deps;
  let handler: ((event: RavenEvent) => void) | null = null;
  const pending = new Set<Promise<void>>();

  return {
    start(): void {
      if (handler) return;
      handler = (event: RavenEvent): void => {
        if (
          event.type !== 'agent:config:created' &&
          event.type !== 'agent:config:updated' &&
          event.type !== 'agent:config:deleted'
        ) {
          return;
        }

        const { payload } = event;
        if (!payload.filePaths?.length) return;
        const work = gitAutoCommit(
          payload.filePaths,
          `chore: update agent config — ${payload.name}`,
          deps.cwd,
        ).catch((err: unknown) => {
          log.warn(`Git auto-commit failed: ${err}`);
        });
        pending.add(work);
        void work.then(() => pending.delete(work));
      };

      for (const eventType of CONFIG_EVENT_TYPES) {
        eventBus.on(eventType, handler);
      }

      log.info('Config committer listening for agent config changes');
    },

    async stop(): Promise<void> {
      if (handler) {
        for (const eventType of CONFIG_EVENT_TYPES) eventBus.off(eventType, handler);
        handler = null;
      }
      await Promise.allSettled([...pending]);
      log.info('Config committer stopped');
    },
  };
}
