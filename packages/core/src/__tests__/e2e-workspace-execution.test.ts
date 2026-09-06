import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskCompleteEvent, Project } from '@raven/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const execFileAsync = promisify(execFile);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function commandEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: root,
    env: commandEnvironment(root),
  });
  return result.stdout;
}

async function initializeRepository(
  root: string,
  repository: string,
  remote: string,
): Promise<void> {
  mkdirSync(repository, { recursive: true });
  mkdirSync(remote, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Raven workspace test']);
  await git(repository, ['config', 'user.email', 'raven-workspace-test@example.invalid']);
  await git(remote, ['init', '--bare', '-b', 'main']);
  await git(repository, ['remote', 'add', 'origin', remote]);
}

async function invokeTool(
  options: BackendOptions,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = randomUUID(),
): Promise<unknown> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error('Workspace backend did not receive a PreToolUse hook');
  const signal = options.signal ?? new AbortController().signal;
  return hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'workspace-test-session',
      transcript_path: join(options.cwd ?? process.cwd(), 'transcript.jsonl'),
      cwd: options.cwd ?? process.cwd(),
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    },
    toolUseId,
    { signal },
  );
}

async function invokePreToolUse(options: BackendOptions, command: string): Promise<unknown> {
  return invokeTool(options, 'Bash', { command });
}

async function runWorkspaceCommand(
  options: BackendOptions,
  executable: string,
  args: string[],
  command: string,
): Promise<void> {
  const result = (await invokePreToolUse(options, command)) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  const decision = result.hookSpecificOutput?.permissionDecision;
  if (decision === 'deny') {
    throw new Error(result.hookSpecificOutput?.permissionDecisionReason ?? 'Bash command denied');
  }
  await execFileAsync(executable, args, {
    cwd: options.cwd,
    env: commandEnvironment(options.cwd ?? process.cwd()),
  });
}

async function writeWorkspaceMemory(options: BackendOptions, content: string): Promise<void> {
  const server = options.mcpServers.memory as McpSdkServerConfigWithInstance | undefined;
  if (!server?.instance) throw new Error('Workspace backend did not receive memory MCP');
  const client = new Client({ name: 'workspace-execution-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: 'memory_write',
      arguments: { path: 'workspace-note.md', content },
    });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.instance.close();
  }
}

describe('e2e: workspace execution grants and revision lineage', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    try {
      await raven?.stop();
    } finally {
      raven = undefined;
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(raven!.port)}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  }

  async function createWorkspaceProject(options: { gmailActions?: boolean } = {}): Promise<{
    fixture: ReturnType<typeof createRavenTestFixture>;
    project: Project;
    repository: string;
    remote: string;
  }> {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-workspace-execution-'));
    const fixture = createRavenTestFixture(root, options);
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      apiHost: '127.0.0.1',
      skipSuites: true,
      agentBackend: async () => ({ result: 'unused', success: true, errors: [] }),
    });
    await raven.start();
    const projectResponse = await request('/api/projects', 'POST', {
      name: 'Workspace execution project',
    });
    expect(projectResponse.status).toBe(200);
    const project = (await projectResponse.json()) as Project;
    const repository = join(root, 'repository');
    const remote = join(root, 'remote.git');
    await initializeRepository(root, repository, remote);
    return { fixture, project, repository, remote };
  }

  async function configureFolder(project: Project, repository: string): Promise<string> {
    const base = `/api/projects/${project.id}`;
    const sourceResponse = await request(`${base}/data-sources`, 'POST', {
      uri: repository,
      label: 'Workspace repository',
      sourceType: 'folder',
    });
    expect(sourceResponse.status).toBe(201);
    const source = (await sourceResponse.json()) as { id: string };
    const workspaceResponse = await request(`${base}/workspace`, 'PUT', {
      execution: { mode: 'full', sourceId: source.id },
    });
    expect(workspaceResponse.status).toBe(200);
    return source.id;
  }

  it('executes in the selected folder, pushes an artifact, isolates memory, and resumes by revision', async () => {
    const calls: BackendOptions[] = [];
    const completions: AgentTaskCompleteEvent[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      options.onSessionId?.('sdk-workspace');
      if (calls.length === 1) {
        await writeWorkspaceMemory(options, 'only the workspace project can read this');
        await runWorkspaceCommand(
          options,
          'sh',
          ['-c', "printf '%s\\n' 'generated by Raven' > artifact.txt"],
          "printf '%s\\n' 'generated by Raven' > artifact.txt",
        );
        await runWorkspaceCommand(options, 'git', ['add', 'artifact.txt'], 'git add artifact.txt');
        await runWorkspaceCommand(
          options,
          'git',
          ['commit', '-m', 'Add generated artifact'],
          'git commit -m "Add generated artifact"',
        );
        await runWorkspaceCommand(
          options,
          'git',
          ['push', 'origin', 'HEAD:main'],
          'git push origin HEAD:main',
        );
      }
      options.onAssistantMessage(`workspace reply ${String(calls.length)}`);
      return { sessionId: 'sdk-workspace', result: 'completed', success: true, errors: [] };
    };

    const setup = await createWorkspaceProject();
    await raven!.stop();
    raven = await createRaven(buildTestConfig(), {
      ...setup.fixture,
      apiHost: '127.0.0.1',
      skipSuites: true,
      agentBackend: backend,
    });
    await raven.start();
    const sourceId = await configureFolder(setup.project, setup.repository);
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });
    const base = `/api/projects/${setup.project.id}`;
    const sessionResponse = await request(`${base}/sessions`, 'POST');
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { id: string };

    expect(
      (
        await request(`${base}/chat`, 'POST', {
          message: 'create the artifact',
          sessionId: session.id,
        })
      ).status,
    ).toBe(200);
    await waitFor(() => completions.length === 1);
    expect(calls[0]).toMatchObject({
      cwd: setup.repository,
      permissionMode: 'bypassPermissions',
      settingSources: ['project', 'local'],
    });
    expect(calls[0].additionalDirectories).toContain(
      join(setup.fixture.projectsDir, setup.project.fsPath!),
    );
    expect(calls[0].resume).toBeUndefined();
    expect(await git(setup.remote, ['show', 'main:artifact.txt'])).toContain('generated by Raven');
    const artifactQuery = new URLSearchParams({ sourceId, path: 'artifact.txt' });
    const artifactInfoResponse = await request(`${base}/files/info?${artifactQuery}`);
    expect(artifactInfoResponse.status).toBe(200);
    const artifactInfo = (await artifactInfoResponse.json()) as { revision: string };
    artifactQuery.set('revision', artifactInfo.revision);
    const artifactResponse = await request(`${base}/files/content?${artifactQuery}`);
    expect(artifactResponse.status).toBe(200);
    expect(await artifactResponse.text()).toBe('generated by Raven\n');
    const memoryPath = join(
      setup.fixture.projectsDir,
      setup.project.fsPath!,
      'memory',
      'workspace-note.md',
    );
    expect(readFileSync(memoryPath, 'utf8')).toContain('only the workspace project');
    expect(existsSync(join(setup.fixture.projectsDir, 'memory', 'workspace-note.md'))).toBe(false);

    expect(
      (await request(`${base}/chat`, 'POST', { message: 'continue', sessionId: session.id }))
        .status,
    ).toBe(200);
    await waitFor(() => completions.length === 2);
    expect(calls[1].resume).toBe('sdk-workspace');
    const storedRevision = raven.db.get<{ sdk_resume_revision: string }>(
      'SELECT sdk_resume_revision FROM sessions WHERE id = ?',
      session.id,
    );
    expect(storedRevision?.sdk_resume_revision).toMatch(/^[a-f0-9]{64}$/);

    await raven.stop();
    raven = await createRaven(buildTestConfig(), {
      ...setup.fixture,
      apiHost: '127.0.0.1',
      skipSuites: true,
      agentBackend: backend,
    });
    await raven.start();
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });
    expect(
      (
        await request(`${base}/chat`, 'POST', {
          message: 'continue after restart',
          sessionId: session.id,
        })
      ).status,
    ).toBe(200);
    await waitFor(() => completions.length === 3);
    expect(calls[2].resume).toBe('sdk-workspace');
    const restartedArtifact = await request(`${base}/files/content?${artifactQuery}`);
    expect(restartedArtifact.status).toBe(200);
    expect(await restartedArtifact.text()).toBe('generated by Raven\n');

    const modeChange = await request(`${base}/workspace`, 'PUT', {
      execution: { mode: 'auto', sourceId },
    });
    expect(modeChange.status).toBe(200);
    expect((await request(`${base}/files/content?${artifactQuery}`)).status).toBe(409);
    expect(
      (
        await request(`${base}/chat`, 'POST', {
          message: 'continue after mode change',
          sessionId: session.id,
        })
      ).status,
    ).toBe(200);
    await waitFor(() => completions.length === 4);
    expect(calls[3]).toMatchObject({ cwd: setup.repository, permissionMode: 'auto' });
    expect(calls[3].resume).toBeUndefined();

    const secondRepository = join(root!, 'repository-two');
    mkdirSync(secondRepository);
    await configureFolder(setup.project, secondRepository);
    expect(
      (
        await request(`${base}/chat`, 'POST', {
          message: 'use the new folder',
          sessionId: session.id,
        })
      ).status,
    ).toBe(200);
    await waitFor(() => completions.length === 5);
    expect(calls[4].cwd).toBe(secondRepository);
    expect(calls[4].resume).toBeUndefined();
    expect(sourceId).toBeTruthy();
  }, 20000);

  it('denies a native command after a running task loses its workspace revision', async () => {
    const setup = await createWorkspaceProject();
    const secondRepository = join(root!, 'repository-two');
    mkdirSync(secondRepository);
    const calls: BackendOptions[] = [];
    const started = deferred<BackendOptions>();
    const release = deferred<boolean>();
    const completions: AgentTaskCompleteEvent[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      started.resolve(options);
      await release.promise;
      return { sessionId: 'sdk-held', result: 'late result', success: true, errors: [] };
    };
    await raven?.stop();
    raven = await createRaven(buildTestConfig(), {
      ...setup.fixture,
      apiHost: '127.0.0.1',
      skipSuites: true,
      agentBackend: backend,
    });
    await raven.start();
    const sourceId = await configureFolder(setup.project, setup.repository);
    const base = `/api/projects/${setup.project.id}`;
    const secondSourceResponse = await request(`${base}/data-sources`, 'POST', {
      uri: secondRepository,
      label: 'Second repository',
      sourceType: 'folder',
    });
    expect(secondSourceResponse.status).toBe(201);
    const secondSource = (await secondSourceResponse.json()) as { id: string };
    const sessionResponse = await request(`${base}/sessions`, 'POST');
    const session = (await sessionResponse.json()) as { id: string };
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });
    try {
      expect(
        (await request(`${base}/chat`, 'POST', { message: 'hold', sessionId: session.id })).status,
      ).toBe(200);
      const options = await started.promise;
      const update = await request(`${base}/workspace`, 'PUT', {
        execution: { mode: 'full', sourceId: secondSource.id },
      });
      expect(update.status).toBe(200);
      const denied = (await invokePreToolUse(options, 'printf stale > stale.txt')) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(existsSync(join(setup.repository, 'stale.txt'))).toBe(false);
      expect(existsSync(join(secondRepository, 'stale.txt'))).toBe(false);
      release.resolve(true);
      await waitFor(() => completions.length === 1);
      expect(completions[0].payload.success).toBe(false);
      expect(
        raven.db.get<{ sdk_session_id: string | null }>(
          'SELECT sdk_session_id FROM sessions WHERE id = ?',
          session.id,
        )?.sdk_session_id,
      ).toBeNull();
    } finally {
      release.resolve(true);
    }
    expect(sourceId).toBeTruthy();
    expect(calls).toHaveLength(1);
  }, 20000);

  it('keeps composed Bash and integration permissions aligned across workspace modes', async () => {
    const calls: BackendOptions[] = [];
    const defaultBash: unknown[] = [];
    const fullBash: unknown[] = [];
    const autoBash: unknown[] = [];
    const gmailHook: unknown[] = [];
    const gmailCallback: unknown[] = [];
    const completions: AgentTaskCompleteEvent[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        defaultBash.push(await invokePreToolUse(options, 'printf default > default.txt'));
      } else if (calls.length === 2) {
        const toolUseId = randomUUID();
        const input = { to: 'test@example.invalid', subject: 'blocked' };
        gmailHook.push(await invokeTool(options, 'mcp__gmail__send_email', input, toolUseId));
        gmailCallback.push(
          await options.canUseTool!('mcp__gmail__send_email', input, {
            signal: options.signal ?? new AbortController().signal,
            toolUseID: toolUseId,
            requestId: `workspace-test:${toolUseId}`,
          }),
        );
        fullBash.push(await invokePreToolUse(options, 'printf full > full.txt'));
      } else {
        autoBash.push(await invokePreToolUse(options, 'printf auto > auto.txt'));
      }
      options.onAssistantMessage(`permission mode ${String(options.permissionMode)}`);
      return { sessionId: 'sdk-permission-modes', result: 'done', success: true, errors: [] };
    };

    const setup = await createWorkspaceProject({ gmailActions: true });
    await raven!.stop();
    raven = await createRaven(buildTestConfig(), {
      ...setup.fixture,
      apiHost: '127.0.0.1',
      skipSuites: true,
      agentBackend: backend,
    });
    await raven.start();
    const base = `/api/projects/${setup.project.id}`;
    const sessionResponse = await request(`${base}/sessions`, 'POST');
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { id: string };
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });

    expect(
      (await request(`${base}/chat`, 'POST', { message: 'default', sessionId: session.id })).status,
    ).toBe(200);
    await waitFor(() => completions.length === 1);
    expect(calls[0].permissionMode).toBe('default');
    expect(
      (defaultBash[0] as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision,
    ).toBe('deny');

    const sourceId = await configureFolder(setup.project, setup.repository);
    expect(
      (await request(`${base}/chat`, 'POST', { message: 'full', sessionId: session.id })).status,
    ).toBe(200);
    await waitFor(() => completions.length === 2);
    expect(calls[1]).toMatchObject({ cwd: setup.repository, permissionMode: 'bypassPermissions' });
    expect((fullBash[0] as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
    expect(
      (gmailHook[0] as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
    ).toBe('deny');
    expect(gmailCallback[0]).toMatchObject({ behavior: 'deny' });

    const pending = raven.db.all<{ action_name: string }>(
      'SELECT action_name FROM pending_approvals WHERE resolution IS NULL AND action_name = ?',
      'gmail:send-email',
    );
    const audits = raven.db.all<{ action_name: string }>(
      'SELECT action_name FROM audit_log WHERE action_name = ?',
      'gmail:send-email',
    );
    expect(pending).toHaveLength(1);
    expect(audits).toHaveLength(1);

    const modeChange = await request(`${base}/workspace`, 'PUT', {
      execution: { mode: 'auto', sourceId },
    });
    expect(modeChange.status).toBe(200);
    expect(
      (await request(`${base}/chat`, 'POST', { message: 'auto', sessionId: session.id })).status,
    ).toBe(200);
    await waitFor(() => completions.length === 3);
    expect(calls[2]).toMatchObject({ cwd: setup.repository, permissionMode: 'auto' });
    expect((autoBash[0] as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined();
  }, 20000);
});
