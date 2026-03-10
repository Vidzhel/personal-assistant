import type {
  SkillContext,
  EventBusInterface,
  DatabaseInterface,
  LoggerInterface,
} from '../../packages/shared/src/types/skills.ts';

export interface MockLogger extends LoggerInterface {
  messages: Array<{ level: string; msg: string; args: unknown[] }>;
}

function createMockLogger(): MockLogger {
  const messages: MockLogger['messages'] = [];
  const log =
    (level: string) =>
    (msg: string, ...args: unknown[]): void => {
      messages.push({ level, msg, args });
    };
  return {
    messages,
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  };
}

function createMockEventBus(): EventBusInterface {
  return {
    emit: () => {},
    on: () => {},
    off: () => {},
  };
}

function createMockDatabase(): DatabaseInterface {
  return {
    run: () => {},
    get: () => undefined,
    all: () => [],
  };
}

export function createMockContext(
  config: Record<string, unknown> = {},
): SkillContext & { logger: MockLogger } {
  return {
    eventBus: createMockEventBus(),
    db: createMockDatabase(),
    config,
    logger: createMockLogger(),
    getSkillData: async () => null,
  };
}
