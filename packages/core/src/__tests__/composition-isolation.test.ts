import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaven, type RavenOverrides } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import { projectRoot } from '../config.ts';

describe('default composition boundary', () => {
  const roots: string[] = [];
  function temp(): string {
    const root = mkdtempSync(join(tmpdir(), 'raven-isolation-'));
    roots.push(root);
    return root;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects an explicitly supplied real SDK backend before startup', async () => {
    const root = temp();
    const fixture = createRavenTestFixture(root);
    await expect(
      createRaven(buildTestConfig(), { ...fixture, agentBackend: createSdkBackend() }),
    ).rejects.toThrow('real SDK agentBackend is forbidden');
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(existsSync(fixture.dbPath)).toBe(false);
  });

  it('rejects fixture construction in the checkout or a non-temporary root', () => {
    expect(() => createRavenTestFixture(projectRoot)).toThrow('dedicated temporary directory');
    expect(() => createRavenTestFixture('/')).toThrow('dedicated temporary directory');
  });

  it('rejects fixture symlinks before writing any definitions through them', () => {
    const root = temp();
    const owner = temp();
    writeFileSync(join(owner, 'sentinel'), 'owner state');
    symlinkSync(owner, join(root, 'projects'));
    expect(() => createRavenTestFixture(root)).toThrow('must not contain symlinks');
    expect(readdirSync(root)).toEqual(['projects']);
    expect(readdirSync(owner)).toEqual(['sentinel']);
    expect(readFileSync(join(owner, 'sentinel'), 'utf8')).toBe('owner state');
  });

  it.each(['agentBackend', 'dataDir', 'dbPath', 'projectsDir', 'libraryDir', 'configDir'] as const)(
    'rejects missing %s before creating runtime files',
    async (field) => {
      const root = temp();
      const overrides = {
        ...createRavenTestFixture(root),
        agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
      };
      const incomplete: RavenOverrides = { ...overrides, [field]: undefined };
      const before = readdirSync(root);
      await expect(createRaven(buildTestConfig(), incomplete)).rejects.toThrow(
        'Unsafe createRaven test',
      );
      expect(readdirSync(root)).toEqual(before);
      expect(existsSync(join(root, 'data'))).toBe(false);
    },
  );

  it.each(['projectsDir', 'libraryDir', 'configDir', 'dbPath'] as const)(
    'rejects %s outside the isolated root without touching the owner sentinel',
    async (field) => {
      const root = temp();
      const owner = temp();
      writeFileSync(join(owner, 'sentinel'), 'owner state');
      const overrides = {
        ...createRavenTestFixture(root),
        agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
        [field]: field === 'dbPath' ? join(owner, 'db.sqlite') : owner,
      };
      await expect(createRaven(buildTestConfig(), overrides)).rejects.toThrow(
        'must stay inside dataDir',
      );
      expect(readdirSync(owner)).toEqual(['sentinel']);
      expect(readFileSync(join(owner, 'sentinel'), 'utf8')).toBe('owner state');
      expect(existsSync(join(root, 'data'))).toBe(false);
    },
  );

  it('rejects absolute session escape and nested symlinks, including dangling ones', async () => {
    const root = temp();
    const owner = temp();
    const overrides = {
      ...createRavenTestFixture(root),
      agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
    };
    await expect(
      createRaven({ ...buildTestConfig(), SESSION_PATH: join(owner, 'sessions') }, overrides),
    ).rejects.toThrow('must stay inside dataDir');
    symlinkSync(join(owner, 'not-created'), join(overrides.libraryDir, 'linked'));
    await expect(createRaven(buildTestConfig(), overrides)).rejects.toThrow(
      'must not contain symlinks',
    );
    expect(readdirSync(owner)).toEqual([]);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('rejects a canonical root escape through a directory symlink', async () => {
    const root = temp();
    const owner = temp();
    const overrides = {
      ...createRavenTestFixture(root),
      agentBackend: async () => ({ result: 'ok', success: true, errors: [] }),
    };
    symlinkSync(owner, join(root, 'owner-link'));
    await expect(
      createRaven(buildTestConfig(), {
        ...overrides,
        dbPath: join(root, 'owner-link', 'db.sqlite'),
      }),
    ).rejects.toThrow('must not contain symlinks');
    expect(readdirSync(owner)).toEqual([]);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });
});
