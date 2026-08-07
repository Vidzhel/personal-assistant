import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServiceRunner } from '../../services/runner.ts';
import type { ServiceDefinition } from '../../services/registry.ts';
import type { ServiceContext } from '../../services/types.ts';

function makeDef(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    name: 'test-service',
    description: 'A test service',
    requiresEnv: [],
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

function makeContext(): ServiceContext {
  return {
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {},
    projectRoot: '/tmp',
    integrationsConfig: {} as ServiceContext['integrationsConfig'],
    jobRegistry: { register: vi.fn() } as unknown as ServiceContext['jobRegistry'],
  };
}

describe('createServiceRunner', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.RAVEN_DISABLED_SERVICES;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('starts a service with no env requirements and no disable list', async () => {
    const runner = createServiceRunner();
    const def = makeDef();

    await runner.startServices([def], makeContext());

    expect(def.start).toHaveBeenCalledTimes(1);
    expect(runner.getRunningCount()).toBe(1);
  });

  // M12
  it('skips a service named in RAVEN_DISABLED_SERVICES, even with satisfied requiresEnv', async () => {
    process.env.RAVEN_DISABLED_SERVICES = 'autonomous-manager,drive-watcher';
    const runner = createServiceRunner();
    const def = makeDef({ name: 'autonomous-manager' });

    await runner.startServices([def], makeContext());

    expect(def.start).not.toHaveBeenCalled();
    expect(runner.getRunningCount()).toBe(0);
  });

  it('trims whitespace around names in RAVEN_DISABLED_SERVICES', async () => {
    process.env.RAVEN_DISABLED_SERVICES = ' autonomous-manager , drive-watcher ';
    const runner = createServiceRunner();
    const def = makeDef({ name: 'autonomous-manager' });

    await runner.startServices([def], makeContext());

    expect(def.start).not.toHaveBeenCalled();
  });

  it('does not skip a service whose name is not in RAVEN_DISABLED_SERVICES', async () => {
    process.env.RAVEN_DISABLED_SERVICES = 'some-other-service';
    const runner = createServiceRunner();
    const def = makeDef({ name: 'autonomous-manager' });

    await runner.startServices([def], makeContext());

    expect(def.start).toHaveBeenCalledTimes(1);
  });

  it('still skips on missing requiresEnv when not disabled', async () => {
    const runner = createServiceRunner();
    const def = makeDef({ requiresEnv: ['SOME_UNSET_ENV_VAR_XYZ'] });

    await runner.startServices([def], makeContext());

    expect(def.start).not.toHaveBeenCalled();
    expect(runner.getRunningCount()).toBe(0);
  });

  it('RAVEN_DISABLED_SERVICES check runs before requiresEnv gating', async () => {
    process.env.RAVEN_DISABLED_SERVICES = 'test-service';
    const runner = createServiceRunner();
    // Would also fail requiresEnv — disabling should short-circuit before that.
    const def = makeDef({ requiresEnv: ['SOME_UNSET_ENV_VAR_XYZ'] });

    await runner.startServices([def], makeContext());

    expect(def.start).not.toHaveBeenCalled();
  });

  it('an empty RAVEN_DISABLED_SERVICES disables nothing', async () => {
    process.env.RAVEN_DISABLED_SERVICES = '';
    const runner = createServiceRunner();
    const def = makeDef();

    await runner.startServices([def], makeContext());

    expect(def.start).toHaveBeenCalledTimes(1);
  });

  it('stopAll stops running services and getRunningCount drops to 0', async () => {
    const runner = createServiceRunner();
    const def = makeDef();

    await runner.startServices([def], makeContext());
    expect(runner.getRunningCount()).toBe(1);

    await runner.stopAll();

    expect(def.stop).toHaveBeenCalledTimes(1);
    expect(runner.getRunningCount()).toBe(0);
  });
});
