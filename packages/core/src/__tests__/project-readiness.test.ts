import Fastify from 'fastify';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInterface, NamedAgent } from '@raven/shared';
import { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import { registerProjectReadinessRoute } from '../api/routes/project-readiness.ts';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import {
  inspectProjectReadiness,
  resolveExecutable,
  sanitizeReadinessError,
  type ProjectReadinessDeps,
} from '../diagnostics/project-readiness.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { createWorkspaceExecutionResolver } from '../project-manager/workspace-execution.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';

const roots: string[] = [];

interface Fixture {
  root: string;
  projectsDir: string;
  projectHome: string;
  library: CapabilityLibrary;
  registry: ProjectRegistry;
  deps: ProjectReadinessDeps;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'raven-readiness-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(
  libraryDir: string,
  input: { name: string; systemDeps?: string[]; mcps?: string[] },
): void {
  const directory = join(libraryDir, 'skills', 'test', input.name);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, 'config.json'), {
    name: input.name,
    displayName: input.name.toUpperCase(),
    description: `${input.name} test skill`,
    systemDeps: input.systemDeps ?? [],
    mcps: input.mcps ?? [],
  });
  writeFileSync(join(directory, 'skill.md'), `# ${input.name}\n`);
}

function fakeAgent(skills: string[]): NamedAgent {
  return {
    id: 'raven',
    name: 'raven',
    definitionRevision: 'agent-revision',
    description: 'Test agent',
    instructions: null,
    skills,
    model: 'sonnet',
    maxTurns: 20,
    isDefault: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function fakeAgentStore(agent: NamedAgent): NamedAgentStore {
  return {
    getAgent: (id: string) => (id === agent.id ? agent : undefined),
    getAgentByName: (name: string) => (name === agent.name ? agent : undefined),
    getDefaultAgent: () => agent,
  } as unknown as NamedAgentStore;
}

function fakeExecutionLogger(): ExecutionLogger {
  return {
    queryTasks: () => [],
  } as unknown as ExecutionLogger;
}

async function makeFixture(
  input: {
    skills?: Array<{ name: string; systemDeps?: string[]; mcps?: string[] }>;
    agentSkills?: string[];
    mcp?:
      | { name: string; command: string; args?: string[]; env?: Record<string, string> }
      | { name: string; type: 'http'; url: string; headers: Record<string, string> };
    probeHttpMcp?: ProjectReadinessDeps['probeHttpMcp'];
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Fixture> {
  const root = temporaryRoot();
  const projectsDir = join(root, 'projects');
  const projectHome = join(projectsDir, 'alpha');
  const libraryDir = join(root, 'library');
  mkdirSync(projectHome, { recursive: true });
  mkdirSync(join(libraryDir, 'mcps'), { recursive: true });
  writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
  writeFileSync(join(projectHome, 'context.md'), '# Alpha\n');
  for (const skill of input.skills ?? []) writeSkill(libraryDir, skill);
  if (input.mcp) {
    writeJson(join(libraryDir, 'mcps', `${input.mcp.name}.json`), {
      displayName: input.mcp.name.toUpperCase(),
      ...input.mcp,
    });
  }
  const registry = new ProjectRegistry();
  await registry.load(projectsDir);
  const workspaceStore = createProjectWorkspaceStore({
    projectsDir,
    projectRegistry: registry,
    projectRoot: root,
  });
  const agent = fakeAgent(input.agentSkills ?? input.skills?.map((skill) => skill.name) ?? []);
  const namedAgentStore = fakeAgentStore(agent);
  const library = new CapabilityLibrary();
  await library.load(libraryDir);
  const agentResolver = createAgentResolver({ capabilityLibrary: library });
  const workspaceExecution = createWorkspaceExecutionResolver({
    workspaceStore,
    projectRegistry: registry,
    namedAgentStore,
  });
  return {
    root,
    projectsDir,
    projectHome,
    library,
    registry,
    deps: {
      workspaceExecution,
      workspaceStore,
      namedAgentStore,
      agentResolver,
      capabilityLibrary: library,
      executionLogger: fakeExecutionLogger(),
      projectRegistry: registry,
      projectRoot: root,
      env: input.env ?? {},
      probeHttpMcp: input.probeHttpMcp,
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project readiness', () => {
  it('checks configured HTTP authentication once for shared capability bindings', async () => {
    const probe = vi
      .fn()
      .mockResolvedValue({ state: 'verified', toolNames: ['list_projects', 'search_task'] });
    const fixture = await makeFixture({
      skills: [
        { name: 'planning', mcps: ['ticktick'] },
        { name: 'review', mcps: ['ticktick'] },
      ],
      mcp: {
        name: 'ticktick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      },
      env: { TICKTICK_MCP_TOKEN: 'fake-local-token' },
      probeHttpMcp: probe,
    });
    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(report.capabilities.every((capability) => capability.state === 'verified')).toBe(true);
    expect(probe).toHaveBeenCalledWith({
      url: 'https://mcp.ticktick.com',
      headers: { Authorization: 'Bearer fake-local-token' },
      signal: undefined,
    });
    expect(report.capabilities[0]?.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'authentication', state: 'verified' }),
        expect.objectContaining({ kind: 'tools', state: 'verified', toolCount: 2 }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('fake-local-token');
  });

  it('does not call an empty remote capability usable after initialization alone', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'planning', mcps: ['remote'] }],
      mcp: { name: 'remote', type: 'http', url: 'https://example.com/mcp', headers: {} },
      probeHttpMcp: async () => ({ state: 'verified', toolNames: [] }),
    });
    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    expect(report.capabilities[0]?.state).toBe('failed');
    expect(report.capabilities[0]?.requirements).toContainEqual(
      expect.objectContaining({
        kind: 'tools',
        state: 'failed',
        toolCount: 0,
        correction: expect.stringContaining('no tools'),
      }),
    );
  });

  it('reports missing required tools even when authentication succeeded', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'ticktick', mcps: ['ticktick'] }],
      mcp: {
        name: 'ticktick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      },
      env: { TICKTICK_MCP_TOKEN: 'fake-local-token' },
      probeHttpMcp: async () => ({
        state: 'verified',
        toolNames: ['list_projects', 'new_unmapped_tool'],
      }),
    });
    const configPath = join(fixture.root, 'library/skills/test/ticktick/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.actions = [
      {
        name: 'ticktick:search-task',
        description: 'Search',
        defaultTier: 'green',
        reversible: true,
      },
    ];
    writeJson(configPath, config);
    await fixture.library.load(join(fixture.root, 'library'));
    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    expect(report.capabilities[0]?.state).toBe('failed');
    expect(report.capabilities[0]?.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'authentication', state: 'verified' }),
        expect.objectContaining({
          kind: 'tools',
          state: 'failed',
          toolCount: 2,
          correction: expect.stringContaining('missing 1 tools'),
        }),
      ]),
    );
  });

  it('omits remote checks with missing credentials and preserves unrelated capabilities', async () => {
    const probe = vi.fn();
    const fixture = await makeFixture({
      skills: [{ name: 'planning', mcps: ['ticktick'] }, { name: 'writing' }],
      mcp: {
        name: 'ticktick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      },
      probeHttpMcp: probe,
    });
    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    expect(probe).not.toHaveBeenCalled();
    expect(report.capabilities[0]?.state).toBe('unavailable');
    expect(report.capabilities[1]?.state).toBe('verified');
    expect(report.capabilities[0]?.requirements).toContainEqual(
      expect.objectContaining({
        name: 'TICKTICK_MCP_TOKEN',
        correction: expect.stringContaining('Set TICKTICK_MCP_TOKEN'),
      }),
    );
  });

  it('cancels in-flight remote readiness work before closing the API', async () => {
    let began: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let cancelled = false;
    const fixture = await makeFixture({
      skills: [{ name: 'planning', mcps: ['ticktick'] }],
      mcp: {
        name: 'ticktick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      },
      env: { TICKTICK_MCP_TOKEN: 'fake-local-token' },
      probeHttpMcp: async ({ signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              cancelled = true;
              resolve({ state: 'failed', stage: 'connection', reason: 'Cancelled' });
            },
            { once: true },
          );
          began();
        }),
    });
    const app = Fastify();
    registerProjectReadinessRoute(app, fixture.deps);
    const request = app.inject('/api/projects/alpha/readiness');
    await started;
    await app.close();
    await request;
    expect(cancelled).toBe(true);
  });

  it.each(['connection', 'tools'] as const)(
    'does not mislabel %s failure as rejected credentials',
    async (stage) => {
      const fixture = await makeFixture({
        skills: [{ name: 'planning', mcps: ['remote'] }],
        mcp: { name: 'remote', type: 'http', url: 'https://example.com/mcp', headers: {} },
        probeHttpMcp: async () => ({
          state: 'failed',
          stage,
          reason: 'The provider check failed.',
        }),
      });
      const report = await inspectProjectReadiness(fixture.deps, 'alpha');
      expect(report.capabilities[0]?.requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'authentication', state: 'unverified' }),
          expect.objectContaining({ kind: stage, state: 'failed' }),
        ]),
      );
      expect(report.findings.some((item) => item.code === 'authentication-failed')).toBe(false);
    },
  );

  it('discloses a rejected remote connection without changing workspace readiness', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'planning', mcps: ['ticktick'] }],
      mcp: {
        name: 'ticktick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      },
      env: { TICKTICK_MCP_TOKEN: 'fake-local-token' },
      probeHttpMcp: async () => ({
        state: 'failed',
        stage: 'authentication',
        reason: 'Authentication rejected. Replace the API token.',
      }),
    });
    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    expect(report.status).toBe('degraded');
    expect(report.workspace.state).toBe('verified');
    expect(report.capabilities[0]?.state).toBe('failed');
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'authentication-failed', severity: 'warning' }),
    );
  });

  it('separates executable, configuration and authentication evidence', async () => {
    const root = temporaryRoot();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'connector-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fixture = await makeFixture({
      skills: [{ name: 'connected', systemDeps: ['connector-cli'], mcps: ['remote'] }],
      mcp: { name: 'remote', command: 'connector-cli', env: { TOKEN: '${REMOTE_TOKEN}' } },
      env: { PATH: bin, REMOTE_TOKEN: 'do-not-return-this-secret' },
    });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report).toMatchObject({
      checkedAt: '2026-09-06T12:00:00.000Z',
      status: 'degraded',
      workspace: { state: 'verified', mode: 'default' },
      agent: { state: 'verified', name: 'raven', skills: ['connected'] },
    });
    expect(report.workspace.blockedOperations).toContain('Bash');
    expect(report.capabilities[0]).toMatchObject({ name: 'connected', state: 'unverified' });
    expect(report.capabilities[0]?.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'executable', name: 'connector-cli', state: 'verified' },
        { kind: 'configuration', name: 'REMOTE_TOKEN', state: 'configured' },
        expect.objectContaining({ kind: 'authentication', name: 'remote', state: 'unverified' }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('do-not-return-this-secret');
  });

  it('isolates an unavailable optional capability from the valid workspace and siblings', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'available' }, { name: 'renderer', systemDeps: ['missing-renderer'] }],
    });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report.status).toBe('degraded');
    expect(report.workspace.state).toBe('verified');
    expect(report.capabilities).toEqual([
      expect.objectContaining({ name: 'available', state: 'verified' }),
      expect.objectContaining({ name: 'renderer', state: 'unavailable' }),
    ]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'executable-unavailable',
        severity: 'warning',
        scope: 'capability:renderer',
        correction: expect.stringContaining('missing-renderer'),
      }),
    );
  });

  it('checks an anchored literal MCP script entrypoint', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'renderer', mcps: ['renderer'] }],
      mcp: { name: 'renderer', command: 'node', args: ['missing-renderer.js'] },
      env: { PATH: process.env.PATH },
    });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report.capabilities[0]).toMatchObject({ name: 'renderer', state: 'unavailable' });
    expect(report.capabilities[0]?.requirements).toContainEqual(
      expect.objectContaining({
        name: expect.stringMatching(/MCP entrypoint: .*\/missing-renderer\.js$/),
        state: 'unavailable',
      }),
    );
  });

  it('blocks a missing selected mount without inventing a fallback cwd', async () => {
    const fixture = await makeFixture();
    const attached = join(fixture.root, 'attached');
    mkdirSync(attached);
    const source = await fixture.deps.workspaceStore.createDataSource('alpha', {
      uri: attached,
      label: 'Repository',
      sourceType: 'folder',
    });
    await fixture.deps.workspaceStore.updateWorkspace('alpha', {
      execution: { mode: 'auto', sourceId: source.id },
    });
    rmSync(attached, { recursive: true });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report.status).toBe('blocked');
    expect(report.workspace).toMatchObject({
      state: 'unavailable',
      mode: 'auto',
      sourceId: source.id,
    });
    expect(report.workspace).not.toHaveProperty('cwd');
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'workspace-unavailable',
        severity: 'blocking',
        correction: expect.stringContaining('mount'),
      }),
    );
  });

  it('reports configured missing context indexes through scoped file checks', async () => {
    const fixture = await makeFixture();
    const attached = join(fixture.root, 'attached');
    mkdirSync(attached);
    mkdirSync(join(attached, 'directory.md'));
    writeFileSync(join(attached, 'README.md'), '# Repository\n');
    const source = await fixture.deps.workspaceStore.createDataSource('alpha', {
      uri: attached,
      label: 'Repository',
      sourceType: 'folder',
      contextFiles: ['README.md', 'missing.md', 'directory.md'],
    });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report.workspace.sources).toContainEqual(
      expect.objectContaining({
        id: source.id,
        state: 'verified',
        contextIndexes: [
          { path: 'README.md', state: 'verified' },
          { path: 'missing.md', state: 'unavailable' },
          { path: 'directory.md', state: 'unavailable' },
        ],
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'context-index-unavailable', severity: 'warning' }),
    );
  });

  it('reports unavailable and unverified sources without changing sibling capability state', async () => {
    const fixture = await makeFixture({ skills: [{ name: 'available' }] });
    const attached = join(fixture.root, 'attached');
    mkdirSync(attached);
    const folder = await fixture.deps.workspaceStore.createDataSource('alpha', {
      uri: attached,
      label: 'Detached repository',
      sourceType: 'folder',
    });
    rmSync(attached, { recursive: true });

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');

    expect(report.status).toBe('blocked');
    expect(report.workspace.state).toBe('unavailable');
    expect(report.capabilities).toEqual([
      expect.objectContaining({ name: 'available', state: 'verified' }),
    ]);
    expect(report.workspace.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: folder.id, state: 'unavailable' })]),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'source-unavailable', severity: 'warning' }),
    );

    const remoteFixture = await makeFixture({ skills: [{ name: 'available' }] });
    const remote = await remoteFixture.deps.workspaceStore.createDataSource('alpha', {
      uri: 'https://example.test/source',
      label: 'Remote source',
      sourceType: 'url',
    });
    const remoteReport = await inspectProjectReadiness(remoteFixture.deps, 'alpha');
    expect(remoteReport.status).toBe('degraded');
    expect(remoteReport.workspace.state).toBe('verified');
    expect(remoteReport.capabilities).toEqual([
      expect.objectContaining({ name: 'available', state: 'verified' }),
    ]);
    expect(remoteReport.workspace.sources).toContainEqual(
      expect.objectContaining({ id: remote.id, state: 'unverified' }),
    );
    expect(remoteReport.findings).toContainEqual(
      expect.objectContaining({ code: 'source-unverified', severity: 'info' }),
    );
  });

  it('sanitizes JSON credentials and URL userinfo without scanning task history', async () => {
    const fixture = await makeFixture({
      skills: [{ name: 'connected' }],
    });
    fixture.deps.agentResolver = {
      resolveAgentCapabilities: () => {
        throw new Error(
          '{"refresh_token":"json-secret","client_secret":"client-secret"} ' +
            'password="two words" https://owner:url-secret@provider.example.test',
        );
      },
    };
    const queryTasks = vi.fn(() => {
      throw new Error('Readiness must not scan task history');
    });
    fixture.deps.executionLogger = { queryTasks } as unknown as ExecutionLogger;

    const report = await inspectProjectReadiness(fixture.deps, 'alpha');
    const serialized = JSON.stringify(report);

    expect(report.recentFailures).toEqual([]);
    expect(queryTasks).not.toHaveBeenCalled();
    expect(serialized).toContain('[redacted]');
    expect(serialized).not.toContain('json-secret');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('two words');
    expect(serialized).not.toContain('owner:url-secret');
  });

  it('redacts an unterminated quoted secret after bounded input truncation', () => {
    const sanitized = sanitizeReadinessError(`{"token":"${'SECRET '.repeat(20_000)}`);

    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('SECRET');
    expect(sanitized.length).toBeLessThanOrEqual(240);
  });
});

describe('readiness executable checks', () => {
  it('requires a regular executable and treats shell syntax as a literal name', () => {
    const root = temporaryRoot();
    const bin = join(root, 'bin');
    const marker = join(root, 'must-not-exist');
    mkdirSync(bin);
    const command = join(bin, 'tool');
    writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o600 });

    expect(resolveExecutable('tool', { projectRoot: root, path: bin })).toBeUndefined();
    chmodSync(command, 0o755);
    expect(resolveExecutable('tool', { projectRoot: root, path: bin })).toBe(command);
    expect(
      resolveExecutable(`tool;touch ${marker}`, { projectRoot: root, path: bin }),
    ).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts a PATH symlink whose target is a regular executable', () => {
    const root = temporaryRoot();
    const bin = join(root, 'bin');
    const target = join(root, 'runtime');
    mkdirSync(bin);
    writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    symlinkSync(target, join(bin, 'runtime'));

    expect(resolveExecutable('runtime', { projectRoot: root, path: bin })).toBe(
      join(bin, 'runtime'),
    );
  });
});

describe('project readiness route', () => {
  it('serves current project reports and rejects unknown projects', async () => {
    const fixture = await makeFixture();
    const app = Fastify();
    registerProjectReadinessRoute(app, fixture.deps);

    const current = await app.inject('/api/projects/alpha/readiness');
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ projectId: 'alpha', status: 'ready' });

    const missing = await app.inject('/api/projects/missing/readiness');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Project not found' });
    await app.close();
  });

  it('returns actionable diagnostics for a project omitted after a malformed reload', async () => {
    const fixture = await makeFixture();
    writeFileSync(
      join(fixture.projectHome, 'context.md'),
      '---\nravenProject: [malformed\n---\nBroken\n',
    );
    await fixture.registry.load(fixture.projectsDir);
    const app = Fastify();
    registerProjectReadinessRoute(app, fixture.deps);

    const response = await app.inject('/api/projects/alpha/readiness');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: 'alpha',
      status: 'blocked',
      workspace: { state: 'unavailable' },
      definitionDiagnostics: [expect.objectContaining({ path: 'alpha/context.md' })],
    });
    await app.close();
  });

  it('maps a cached stable ID only to its currently invalid filesystem project path', async () => {
    const fixture = await makeFixture();
    writeFileSync(
      join(fixture.projectHome, 'context.md'),
      '---\nravenProject: [malformed\n---\nBroken\n',
    );
    await fixture.registry.load(fixture.projectsDir);
    fixture.deps.db = {
      run: vi.fn(),
      get: vi.fn((_sql: string, id: unknown) =>
        id === 'stable-alpha'
          ? { fs_path: 'alpha' }
          : id === 'archived-project'
            ? { fs_path: 'archived' }
            : undefined,
      ),
      all: vi.fn(() => []),
    } as unknown as DatabaseInterface;
    const app = Fastify();
    registerProjectReadinessRoute(app, fixture.deps);

    const currentInvalid = await app.inject('/api/projects/stable-alpha/readiness');
    expect(currentInvalid.statusCode).toBe(200);
    expect(currentInvalid.json()).toMatchObject({
      projectId: 'stable-alpha',
      status: 'blocked',
      definitionDiagnostics: [expect.objectContaining({ path: 'alpha/context.md' })],
    });
    const archived = await app.inject('/api/projects/archived-project/readiness');
    expect(archived.statusCode).toBe(404);
    await app.close();
  });
});
