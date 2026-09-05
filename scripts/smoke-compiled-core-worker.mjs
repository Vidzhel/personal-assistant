import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// No application imports above this boundary. The parent supplied a fresh env.
assert.equal(typeof process.send, 'function', 'Use the compiled smoke launcher');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.NEO4J_ENABLED, 'false');
for (const key of Object.keys(process.env)) {
  assert(
    !/^(TELEGRAM_|TICKTICK_|GMAIL_|GWS_|YNAB_|MONOBANK_|PRIVATBANK_|GOOGLE_API_KEY|ANTHROPIC_API_KEY)/.test(
      key,
    ),
    `Unexpected integration environment: ${key}`,
  );
}
const [phase, root] = process.argv.slice(2);
assert(['create', 'restart'].includes(phase));
assert(
  root && isAbsolute(root) && resolve(root) === process.cwd(),
  'Launcher must provide an isolated working directory',
);
const tempRelative = relative(realpathSync(tmpdir()), realpathSync(root));
assert(
  tempRelative &&
    !tempRelative.startsWith(`..${sep}`) &&
    tempRelative !== '..' &&
    !isAbsolute(tempRelative),
  'Smoke root must be a dedicated temporary directory',
);
assert(basename(root).startsWith('raven-compiled-smoke-') && !lstatSync(root).isSymbolicLink());
const repoRoot = resolve(import.meta.dirname, '..');
const coreDist = join(repoRoot, 'packages/core/dist');
const compiled = (file) => import(pathToFileURL(join(coreDist, file)).href);
const { initializeRuntime } = await import(
  pathToFileURL(join(repoRoot, 'deployment/runtime-init.mjs')).href
);
await initializeRuntime({ root, seedDir: join(repoRoot, 'deployment/seeds') });
const { createRaven } = await compiled('raven.js');
const { loadConfig } = await compiled('config.js');
const { createMemoryStore } = await compiled('agent-memory/memory-store.js');
const { gitAutoCommit } = await import(
  pathToFileURL(join(repoRoot, 'packages/shared/dist/index.js')).href
);

const paths = {
  dataDir: root,
  dbPath: join(root, 'data/smoke.db'),
  projectsDir: join(root, 'projects'),
  libraryDir: join(root, 'library'),
  configDir: join(root, 'config'),
};
const config = {
  ...loadConfig(),
  DATABASE_PATH: paths.dbPath,
  SESSION_PATH: join(root, 'data/sessions'),
};
assert.equal(config.NEO4J_ENABLED, false);
let backendCalls = 0;
const agentBackend = async (options) => {
  backendCalls++;
  assert.deepEqual(Object.keys(options.agents), []);
  assert.deepEqual(Object.keys(options.mcpServers).sort(), ['memory', 'raven']);
  options.onAssistantMessage('Compiled smoke response.');
  return {
    sessionId: 'compiled-smoke-session',
    result: 'Compiled smoke response.',
    estimatedCostUsd: 0,
    success: true,
    errors: [],
  };
};
const statePath = join(root, 'data/smoke-state.json');
const memoryText = '# Compiled smoke memory\n\nThis note must survive a fresh process.\n';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let raven;

async function request(path, method = 'GET', body, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${raven.port}${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status,
    expectedStatus,
    `${method} ${path}: ${await response.clone().text()}`,
  );
  return response.json();
}

async function checkChat(projectId) {
  let timer;
  const completion = new Promise((resolveTask, reject) => {
    timer = setTimeout(() => reject(new Error('Fake backend chat did not complete')), 10_000);
    raven.eventBus.once('agent:task:complete', resolveTask);
  });
  try {
    await request(`/api/projects/${projectId}/chat`, 'POST', {
      message: 'Verify the packaged runtime.',
    });
    const event = await completion;
    assert.equal(event.payload.success, true);
    assert.equal(backendCalls, 1);
    return event.payload.taskId;
  } finally {
    clearTimeout(timer);
  }
}

function seedInterruptedTree(project) {
  const id = 'compiled-interrupted-tree';
  const now = new Date().toISOString();
  const directory = join(paths.projectsDir, project.fsPath, 'tasks/trees');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${id}.yaml`),
    stringify({
      id,
      projectId: project.id,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      tasks: [
        {
          id: 'done',
          parentTaskId: id,
          status: 'completed',
          retryCount: 0,
          node: {
            id: 'done',
            type: 'agent',
            title: 'Previous work',
            prompt: 'Done',
            blockedBy: [],
          },
          artifacts: [{ type: 'data', label: 'Retained output', data: { result: 42 } }],
        },
        {
          id: 'interrupted',
          parentTaskId: id,
          status: 'in_progress',
          retryCount: 0,
          node: {
            id: 'interrupted',
            type: 'agent',
            title: 'Interrupted work',
            prompt: 'Resume',
            blockedBy: ['done'],
          },
          agentTaskId: 'previous-process-attempt',
          artifacts: [],
        },
      ],
    }),
  );
  return id;
}

async function verifyInterruptedTree(id) {
  const tree = await request(`/api/task-trees/${id}`);
  assert.equal(tree.status, 'pending_approval');
  assert.equal(tree.tasks.find((task) => task.id === 'interrupted').status, 'blocked');
  assert.deepEqual(tree.tasks.find((task) => task.id === 'done').artifacts, [
    { type: 'data', label: 'Retained output', data: { result: 42 } },
  ]);
  assert.equal(backendCalls, 1, 'Restart must not automatically replay interrupted work');
  await request(`/api/task-trees/${id}/approve`, 'POST');
  const deadline = Date.now() + 10_000;
  while ((await request(`/api/task-trees/${id}`)).status !== 'completed') {
    assert(Date.now() < deadline, 'Deliberately resumed tree did not complete');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(backendCalls, 2, 'Deliberate approval must dispatch exactly one new attempt');
}

async function seedState(migrations) {
  const project = await request('/api/projects', 'POST', {
    name: 'Packaged Smoke Project',
    description: 'Compiled restart fixture',
    systemPrompt: 'Use the compiled smoke conventions.',
    skills: [],
  });
  const runId = await checkChat(project.id);
  const runBytes = readFileSync(
    join(paths.projectsDir, project.fsPath, 'tasks/runs', `${runId}.yaml`),
    'utf8',
  );
  assert(runBytes.includes(runId));
  assert.equal((await request(`/api/agent-tasks/${runId}`)).status, 'completed');
  assert.equal(
    raven.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tasks'"),
    undefined,
  );
  const store = createMemoryStore({ projectsDir: paths.projectsDir });
  assert.equal((await store.write('raven', 'smoke.md', memoryText)).ok, true);
  const memoryPath = join(paths.projectsDir, 'agents/raven/memory/smoke.md');
  await gitAutoCommit([memoryPath], 'test: persist compiled smoke memory', root);
  const context = readFileSync(join(paths.projectsDir, project.fsPath, 'context.md'), 'utf8');
  assert(context.includes(project.id));
  assert.equal(git('show', `HEAD:projects/${project.fsPath}/context.md`), context.trim());
  const task = await request(
    '/api/tasks',
    'POST',
    {
      projectId: project.id,
      title: 'Compiled task persistence',
      description: 'Project-local task survives a new process.',
    },
    201,
  );
  const taskPath = join(paths.projectsDir, project.fsPath, 'tasks/board', `${task.id}.yaml`);
  const taskBytes = readFileSync(taskPath, 'utf8');
  assert(taskBytes.includes(task.id));
  writeFileSync(
    statePath,
    JSON.stringify({
      project,
      context,
      task,
      taskBytes,
      runId,
      runBytes,
      treeId: seedInterruptedTree(project),
      head: git('rev-parse', 'HEAD'),
      migrations,
    }),
  );
}

async function verifyState(migrations) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(git('rev-parse', 'HEAD'), state.head, 'Restart must reattach existing Git history');
  assert.deepEqual(migrations, state.migrations);
  const project = await request(`/api/projects/${state.project.id}`);
  assert.equal(project.id, state.project.id);
  assert.equal(project.fsPath, state.project.fsPath);
  assert.equal(project.systemPrompt, state.project.systemPrompt);
  assert.equal(
    readFileSync(join(paths.projectsDir, project.fsPath, 'context.md'), 'utf8'),
    state.context,
  );
  const agents = await request('/api/agents');
  const agent = agents.find((item) => item.name === 'raven');
  assert(agent, 'Seeded default agent must survive restart');
  const memories = await request(`/api/agents/${agent.id}/memory`);
  assert(memories.some((item) => item.file === 'smoke.md' && item.content === memoryText));
  assert.equal(git('show', 'HEAD:projects/agents/raven/memory/smoke.md'), memoryText.trim());
  assert((await request(`/api/projects/${project.id}/sessions`)).length > 0);
  const task = await request(`/api/tasks/${state.task.id}`);
  assert.equal(task.title, state.task.title);
  assert.equal(task.projectId, project.id);
  assert.equal(
    readFileSync(join(paths.projectsDir, project.fsPath, 'tasks/board', `${task.id}.yaml`), 'utf8'),
    state.taskBytes,
  );
  const run = await request(`/api/agent-tasks/${state.runId}`);
  assert.equal(run.status, 'completed');
  assert.equal(run.projectId, project.id);
  assert.equal(
    readFileSync(
      join(paths.projectsDir, project.fsPath, 'tasks/runs', `${state.runId}.yaml`),
      'utf8',
    ),
    state.runBytes,
  );
  assert.equal(
    raven.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tasks'"),
    undefined,
  );
  await checkChat(project.id);
  await verifyInterruptedTree(state.treeId);
}

try {
  raven = await createRaven(config, { ...paths, agentBackend, apiHost: '127.0.0.1' });
  await raven.start();
  const health = await request('/api/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.knowledge, 'unavailable');
  assert(health.services.loaded > 0, 'Real background services must start');
  assert.equal(health.services.loaded, health.services.configured);
  const migrations = raven.db
    .all('SELECT name FROM _migrations ORDER BY name')
    .map((row) => row.name);
  const packagedMigrations = readdirSync(join(coreDist, 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.replace(/\.sql$/, ''))
    .sort();
  assert(packagedMigrations.length > 0);
  assert.deepEqual(migrations, packagedMigrations, 'All packaged SQL migrations must run');
  assert(existsSync(join(root, 'data/definition-history')));
  if (phase === 'create') await seedState(migrations);
  else await verifyState(migrations);
  await raven.stop();
  raven = undefined;
  process.send?.({ ok: true, migrations: migrations.length, services: health.services.loaded });
} catch (error) {
  console.error('Compiled smoke verification failed:', error);
  throw error;
} finally {
  await raven?.stop();
  // No process.exit(): the launcher requires the runtime to release its own handles.
  process.disconnect?.();
}
