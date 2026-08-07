import { createLogger, gitAutoCommit, type RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('config-committer');

export interface ConfigCommitter {
  start: () => void;
  stop: () => void;
}

const CONFIG_EVENT_TYPES = [
  'agent:config:created',
  'agent:config:updated',
  'agent:config:deleted',
] as const;

export function createConfigCommitter(deps: { eventBus: EventBus }): ConfigCommitter {
  const { eventBus } = deps;
  // Held so stop() can unsubscribe the exact handler start() registered —
  // this is the only resource the committer holds (no timers, no files).
  let handler: ((event: RavenEvent) => void) | null = null;

  return {
    start(): void {
      handler = (event: RavenEvent): void => {
        if (
          event.type !== 'agent:config:created' &&
          event.type !== 'agent:config:updated' &&
          event.type !== 'agent:config:deleted'
        ) {
          return;
        }

        const payload = event.payload as { name: string; filePath?: string };
        if (!payload.filePath) return;
        gitAutoCommit([payload.filePath], `chore: update agent config — ${payload.name}`).catch(
          (err: unknown) => {
            log.warn(`Git auto-commit failed: ${err}`);
          },
        );
      };

      for (const eventType of CONFIG_EVENT_TYPES) {
        eventBus.on(eventType, handler);
      }

      log.info('Config committer listening for agent config changes');
    },

    stop(): void {
      if (!handler) return;
      for (const eventType of CONFIG_EVENT_TYPES) {
        eventBus.off(eventType, handler);
      }
      handler = null;
      log.info('Config committer stopped');
    },
  };
}
