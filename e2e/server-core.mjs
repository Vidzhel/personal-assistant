import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspaceFixture } from './workspace-fixture.mjs';

const root = process.argv[2];
assert(root && realpathSync(root) === process.cwd());
assert(basename(root).startsWith('raven-browser-e2e-'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.NEO4J_ENABLED, 'false');
const repo = resolve(import.meta.dirname, '..');
const compiled = (file) => import(pathToFileURL(join(repo, 'packages/core/dist', file)).href);
const { initializeRuntime } = await import('../deployment/runtime-init.mjs');
await initializeRuntime({ root, seedDir: join(repo, 'deployment/seeds') });
const workspaceFixture = await createWorkspaceFixture(root);
function write(relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}
write('projects/course/context.md', '# Course\n\nBrowser fixture parent.\n');
write('projects/course/one/context.md', '# Nested Course\n\nBrowser fixture only.\n');
write('projects/course/one/project.yaml', { version: 1 });
write('projects/course/memory/research/notes.md', 'Course private memory sentinel.');
write('projects/course/one/memory/MEMORY.md', 'Nested project memory sentinel.');
write('projects/course/one/artifacts/research.md', '# Retained browser research artifact\n');
const treeTime = new Date().toISOString();
write('projects/course/one/tasks/trees/browser-interrupted-tree.yaml', {
  id: 'browser-interrupted-tree',
  projectId: 'course/one',
  plan: 'Resume reviewed browser work',
  status: 'running',
  createdAt: treeTime,
  updatedAt: treeTime,
  tasks: [
    {
      id: 'done',
      parentTaskId: 'browser-interrupted-tree',
      status: 'completed',
      retryCount: 0,
      node: {
        id: 'done',
        type: 'agent',
        title: 'Retained research',
        prompt: 'Done',
        blockedBy: [],
      },
      summary: 'Earlier research is retained.',
      artifacts: [
        { type: 'data', label: 'Research result', data: { value: 42 } },
        {
          type: 'file',
          label: 'Research document',
          sourceId: 'home',
          filePath: 'artifacts/research.md',
        },
      ],
    },
    {
      id: 'resume',
      parentTaskId: 'browser-interrupted-tree',
      status: 'in_progress',
      retryCount: 0,
      node: {
        id: 'resume',
        type: 'agent',
        title: 'Finish reviewed work',
        prompt: 'resume-browser-tree',
        blockedBy: ['done'],
      },
      artifacts: [],
      agentTaskId: 'old-browser-attempt',
    },
  ],
});
write('library/skills/browser-fixture/config.json', {
  name: 'browser-fixture',
  displayName: 'Browser fixture',
  description: 'Fake action only',
  mcps: [],
  actions: [
    {
      name: 'browser-fixture:confirm',
      description: 'Confirm fake action',
      defaultTier: 'red',
      reversible: false,
    },
  ],
});
write('library/skills/browser-fixture/skill.md', 'A fake browser acceptance-test action.');
const { createRaven } = await compiled('raven.js');
const { loadConfig } = await compiled('config.js');
const { getDb } = await compiled('db/database.js');
const { createPendingApprovals } = await compiled('permission-engine/pending-approvals.js');
const calls = [];
const events = [];
const agentBackend = async (options) => {
  const number = calls.length + 1;
  const sessionId = options.resume ?? `browser-sdk-${number}`;
  const call = {
    number,
    prompt: options.prompt,
    resume: options.resume,
    sessionId,
    aborted: false,
  };
  calls.push(call);
  options.onSessionId?.(sessionId);
  if (options.prompt.includes('workspace-artifact-browser')) {
    await workspaceFixture.generate(options);
  }
  if (options.prompt.includes('hold-browser')) {
    await new Promise((resolveCall) => {
      if (options.signal.aborted) resolveCall();
      else options.signal.addEventListener('abort', resolveCall, { once: true });
    });
    call.aborted = true;
    return { sessionId, result: '', success: false, errors: ['cancelled'], estimatedCostUsd: 0 };
  }
  const result = `Browser reply ${number}`;
  options.onAssistantMessage(result);
  return { sessionId, result, success: true, errors: [], estimatedCostUsd: 0 };
};
const raven = await createRaven(
  {
    ...loadConfig(),
    DATABASE_PATH: join(root, 'data/browser.db'),
    SESSION_PATH: join(root, 'data/sessions'),
  },
  {
    dataDir: root,
    dbPath: join(root, 'data/browser.db'),
    projectsDir: join(root, 'projects'),
    libraryDir: join(root, 'library'),
    configDir: join(root, 'config'),
    agentBackend,
    apiHost: '127.0.0.1',
  },
);
raven.eventBus.on('*', (event) => {
  events.push(event);
  if (events.length > 500) events.shift();
});
await raven.start();
const pending = createPendingApprovals(getDb());
// Fixture control is separate from Raven's production API and only binds loopback.
const control = createServer(async (req, res) => {
  try {
    let result;
    if (req.method === 'GET' && req.url === '/workspace') {
      result = await workspaceFixture.state();
    } else if (req.method === 'GET' && req.url === '/state') {
      result = {
        calls,
        events,
        approvals: getDb().prepare('SELECT id, resolution FROM pending_approvals').all(),
      };
    } else if (req.method === 'POST' && req.url === '/invalid-definition') {
      write('projects/schedules/browser-invalid.yaml', {
        name: 'browser-invalid',
        cron: 'invalid cron',
        timezone: 'UTC',
        enabled: true,
        run: { kind: 'job', ref: 'self-test' },
      });
      result = { written: true };
    } else if (req.method === 'POST' && req.url === '/repair-definition') {
      rmSync(join(root, 'projects/schedules/browser-invalid.yaml'), { force: true });
      result = { repaired: true };
    } else if (req.method === 'POST' && req.url === '/approval') {
      result = pending.insert({
        actionName: 'browser-fixture:confirm',
        skillName: 'browser-fixture',
        details: 'Only the fake browser backend will run.',
      });
    } else if (req.method === 'POST' && req.url === '/invalid-approval') {
      result = pending.insert({
        actionName: 'unavailable-skill:confirm',
        skillName: 'unavailable-skill',
        details: 'Missing bindings must prevent dispatch.',
      });
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((resolveControl, reject) => {
  control.once('error', reject);
  control.listen(4422, '127.0.0.1', resolveControl);
});
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  await new Promise((resolveControl) => control.close(resolveControl));
  await raven.stop();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
