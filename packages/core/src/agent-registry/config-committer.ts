import { createLogger, gitAutoCommit, type RavenEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const log = createLogger('config-committer');

export interface ConfigCommitter {
  start: () => void;
}

export function createConfigCommitter(deps: {
  eventBus: EventBus;
  configFilePath: string;
}): ConfigCommitter {
  const { eventBus, configFilePath } = deps;

  return {
    start(): void {
      const handler = (event: RavenEvent): void => {
        if (
          event.type !== 'agent:config:created' &&
          event.type !== 'agent:config:updated' &&
          event.type !== 'agent:config:deleted'
        ) {
          return;
        }

        const payload = event.payload as { name: string };
        gitAutoCommit([configFilePath], `chore: update agent config — ${payload.name}`).catch(
          (err: unknown) => {
            log.warn(`Git auto-commit failed: ${err}`);
          },
        );
      };

      for (const eventType of [
        'agent:config:created',
        'agent:config:updated',
        'agent:config:deleted',
      ] as const) {
        eventBus.on(eventType, handler);
      }

      log.info('Config committer listening for agent config changes');
    },
  };
}
