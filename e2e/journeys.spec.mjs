import { test, expect } from '@playwright/test';

const API = 'http://127.0.0.1:4421/api';
const CONTROL = 'http://127.0.0.1:4422';
const projectPath = (id) => `/projects/${encodeURIComponent(id)}`;
async function state(request) {
  return (await request.get(`${CONTROL}/state`)).json();
}
async function project(request, name) {
  const response = await request.post(`${API}/projects`, { data: { name } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function session(request, projectId, name) {
  const response = await request.post(
    `${API}/projects/${encodeURIComponent(projectId)}/sessions/new`,
  );
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  expect(
    (await request.patch(`${API}/sessions/${created.id}`, { data: { name } })).ok(),
  ).toBeTruthy();
  return created;
}
async function chat(page, projectId) {
  await page.goto(projectPath(projectId));
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toBeVisible();
  await expect(page.getByText('Loading history...', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Connecting...', { exact: true })).toHaveCount(0);
}
async function send(page, message) {
  await page.getByPlaceholder('Ask Raven...').fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  // A wrong endpoint must fail here, never hit the owner's local app or internet.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' && ['4420', '4421'].includes(url.port)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**', async (socket) => {
    const url = new URL(socket.url());
    if (url.hostname === '127.0.0.1' && ['4420', '4421'].includes(url.port)) {
      socket.connectToServer();
    } else await socket.close({ code: 1008, reason: 'Outside the isolated browser fixture' });
  });
});

test('project task board persists completion and displays file-backed task details', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Task Files');
  const response = await request.post(`${API}/tasks`, {
    data: {
      title: 'Review task-file methods',
      projectId: p.id,
      description: 'Read assumptions and keep open questions.',
      artifacts: ['notes/methods.md'],
    },
  });
  expect(response.status()).toBe(201);
  const task = await response.json();
  await page.goto('/tasks');
  await page.getByPlaceholder('Search tasks…').fill(task.title);
  const card = page
    .getByRole('region', { name: 'To Do', exact: true })
    .locator('[draggable="true"]')
    .filter({ hasText: task.title });
  await expect(card).toBeVisible();
  await card.dragTo(page.getByRole('region', { name: 'Done', exact: true }));
  await expect(
    page.getByRole('region', { name: 'Done', exact: true }).getByText(task.title),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('region', { name: 'Done', exact: true }).getByText(task.title).click();
  await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await expect(
    page.getByText('Read assumptions and keep open questions.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('notes/methods.md', { exact: true })).toBeVisible();
  const persisted = await (await request.get(`${API}/tasks/${task.id}`)).json();
  expect(persisted.status).toBe('completed');
  expect(persisted.completedAt).toBeTruthy();
  expect(persisted.projectId).toBe(p.id);
});

test('create project, persist instructions, and manage data sources with knowledge disabled', async ({
  page,
  request,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/projects');
  // Client-loaded data proves hydration completed before clicking an SSR button.
  await expect(page.getByRole('heading', { name: 'Raven System', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New Project', exact: true }).click();
  await page.getByPlaceholder('Project name').fill('Browser Created Project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page
    .getByRole('link')
    .filter({ has: page.getByRole('heading', { name: 'Browser Created Project', exact: true }) })
    .click();
  await page.getByRole('button', { name: 'Set project memory...' }).click();
  await page
    .getByPlaceholder('Add project memory — instructions/context for all conversations...')
    .fill('Use concrete examples in every answer.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Use concrete examples in every answer.' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Use concrete examples in every answer.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Add Data Source', exact: true }).click();
  await page.getByPlaceholder('Label', { exact: true }).fill('Reference note');
  await page
    .getByPlaceholder('URI (file path, URL, or Google Drive link)')
    .fill('https://example.invalid/fixture');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Reference note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Reference note', { exact: true })).toHaveCount(0);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
  const persisted = await (await request.get(`${API}/projects/${encodeURIComponent(id)}`)).json();
  expect(persisted.name).toBe('Browser Created Project');
  expect(persisted.systemPrompt).toBe('Use concrete examples in every answer.');
  expect(
    await (await request.get(`${API}/projects/${encodeURIComponent(id)}/data-sources`)).json(),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('nested legacy project links work in both grid and tree', async ({ page, request }) => {
  const projects = await (await request.get(`${API}/projects`)).json();
  const nested = projects.find((item) => item.fsPath === 'course/one');
  expect(nested).toBeTruthy();
  expect(nested.id).toContain('/');
  for (const mode of ['Grid', 'Tree']) {
    await page.goto('/projects');
    await page.getByRole('button', { name: mode, exact: true }).click();
    await page
      .locator(`a[href="${projectPath(nested.id)}"]`)
      .last()
      .click();
    await expect(page.getByRole('heading', { name: nested.name, exact: true })).toBeVisible();
    await expect(page.getByText('Project not found.', { exact: true })).toHaveCount(0);
  }
});

test('chat persists replies and resumes the same backend conversation after reload', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Chat Resume');
  const s = await session(request, p.id, 'Resume conversation');
  await chat(page, p.id);
  let next = (await state(request)).calls.length + 1;
  await send(page, 'Browser first turn');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Sending...', { exact: true })).toHaveCount(0);
  const first = (await state(request)).calls.at(-1);
  expect(first.resume).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  next++;
  await send(page, 'Browser second turn');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  expect((await state(request)).calls.at(-1).resume).toBe(first.sessionId);
  const messages = await (await request.get(`${API}/sessions/${s.id}/messages`)).json();
  expect(messages.filter((message) => message.role === 'user')).toHaveLength(2);
  expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
});

test('switching sessions isolates active work, and Stop waits for a real terminal result', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Session Isolation');
  const a = await session(request, p.id, 'Conversation A');
  await session(request, p.id, 'Conversation B');
  await chat(page, p.id);
  await page.getByRole('button', { name: /Conversation A/ }).click();
  await send(page, 'hold-browser in conversation A');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByPlaceholder('Ask Raven...').fill('Unsent draft for conversation A');
  await page.getByRole('button', { name: /Conversation B/ }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toHaveValue('');
  await expect(page.getByText('hold-browser in conversation A', { exact: true })).toHaveCount(0);
  const next = (await state(request)).calls.length + 1;
  await send(page, 'Conversation B finishes independently');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Conversation A/ }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toHaveValue(
    'Unsent draft for conversation A',
  );
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toHaveCount(0);
  await page.route(
    '**/api/agent-tasks/*/cancel',
    (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Fixture cancellation refused' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Fixture cancellation refused' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const observed = await state(request);
  expect(
    observed.calls.find((call) => call.prompt.includes('hold-browser in conversation A')).aborted,
  ).toBe(true);
  expect(
    observed.events.some(
      (event) =>
        event.type === 'agent:task:complete' &&
        event.payload.sessionId === a.id &&
        event.payload.cancelled,
    ),
  ).toBe(true);
});

test('a rejected chat preserves a recoverable draft and never reaches the model', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Rejected Draft');
  await session(request, p.id, 'Rejected draft');
  await chat(page, p.id);
  const agents = await (await request.get(`${API}/agents`)).json();
  const agent = agents.find((item) => item.isDefault);
  const previous = (await state(request)).calls.length;
  try {
    expect(
      (
        await request.patch(`${API}/agents/${agent.id}`, {
          data: { skills: ['missing-browser-fixture'] },
        })
      ).ok(),
    ).toBeTruthy();
    await send(page, 'Keep this rejected draft');
    await expect(page.getByRole('alert').filter({ hasText: 'capability' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
    await expect(page.getByPlaceholder('Ask Raven...')).toHaveValue('Keep this rejected draft');
    expect((await state(request)).calls).toHaveLength(previous);
  } finally {
    expect(
      (await request.patch(`${API}/agents/${agent.id}`, { data: { skills: agent.skills } })).ok(),
    ).toBeTruthy();
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(`Browser reply ${previous + 1}`, { exact: true })).toBeVisible();
});

test('approval confirmation, approval execution, and denial persist their outcomes', async ({
  page,
  request,
}) => {
  const approval = await (await request.post(`${CONTROL}/approval`)).json();
  const previous = (await state(request)).calls.length;
  await page.goto('/');
  const inbox = page.locator('#approvals');
  await expect(inbox.getByText('browser-fixture:confirm', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await inbox.getByRole('button', { name: 'Approve', exact: true }).click();
  expect(
    (await state(request)).approvals.find((item) => item.id === approval.id).resolution,
  ).toBeNull();
  page.once('dialog', (dialog) => dialog.accept());
  await inbox.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await state(request)).approvals.find((item) => item.id === approval.id).resolution,
    )
    .toBe('approved');
  await expect.poll(async () => (await state(request)).calls.length).toBe(previous + 1);
  const denied = await (await request.post(`${CONTROL}/approval`)).json();
  await page.reload();
  await inbox.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect
    .poll(
      async () => (await state(request)).approvals.find((item) => item.id === denied.id).resolution,
    )
    .toBe('denied');
  expect((await state(request)).calls).toHaveLength(previous + 1);
  await page.reload();
  await expect(inbox.getByText('browser-fixture:confirm', { exact: true })).toHaveCount(0);
});

test('approved action admission failure is visible without offering a second approval', async ({
  page,
  request,
}) => {
  const approval = await (await request.post(`${CONTROL}/invalid-approval`)).json();
  const previous = (await state(request)).calls.length;
  await page.goto('/');
  const inbox = page.locator('#approvals');
  await expect(inbox.getByText('unavailable-skill:confirm', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await inbox.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(inbox.getByText(/Approval saved, but the action could not complete:/)).toBeVisible();
  await expect(inbox.getByText(/Unknown agent skill: unavailable-skill/)).toBeVisible();
  expect((await state(request)).approvals.find((item) => item.id === approval.id).resolution).toBe(
    'approved',
  );
  expect((await state(request)).calls).toHaveLength(previous);
  await expect(inbox.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(inbox.getByText('unavailable-skill:confirm', { exact: true })).toHaveCount(0);
});

test('project deletion explains existing references and removes an empty project', async ({
  page,
  request,
}) => {
  const empty = await project(request, 'Browser Empty Delete');
  await page.goto(projectPath(empty.id));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
  await expect(page).toHaveURL('/projects');
  expect((await request.get(`${API}/projects/${empty.id}`)).status()).toBe(404);
  const used = await project(request, 'Browser Refused Delete');
  await session(request, used.id, 'Keep this conversation');
  await page.goto(projectPath(used.id));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /sessions|references/ })).toBeVisible();
  expect((await request.get(`${API}/projects/${used.id}`)).ok()).toBeTruthy();
});

test('New Chat selects the newly created conversation', async ({ page, request }) => {
  const p = await project(request, 'Browser New Chat');
  const original = await session(request, p.id, 'Original conversation');
  await chat(page, p.id);
  const originalDraft = 'Original draft survives creating a conversation';
  const input = page.getByPlaceholder('Ask Raven...');
  await input.fill(originalDraft);
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let createStarted = false;
  await page.route(`${API}/projects/${encodeURIComponent(p.id)}/sessions/new`, async (route) => {
    createStarted = true;
    await createGate;
    await route.continue();
  });
  let sessionListStarted = false;
  let failSessionList = true;
  await page.route(`${API}/projects/${encodeURIComponent(p.id)}/sessions`, async (route) => {
    if (route.request().method() === 'GET' && !sessionListStarted) {
      sessionListStarted = true;
      if (failSessionList) {
        failSessionList = false;
        await route.fulfill({ status: 503, body: 'temporary session list failure' });
        return;
      }
    }
    await route.continue();
  });
  const newChatClick = page.getByRole('button', { name: 'New Chat', exact: true }).click();
  await expect.poll(() => createStarted).toBe(true);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  releaseCreate();
  await newChatClick;
  await expect.poll(() => sessionListStarted).toBe(true);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry loading sessions', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Retry loading sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const next = (await state(request)).calls.length + 1;
  await send(page, 'Only in the new conversation');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  const sessions = await (await request.get(`${API}/projects/${p.id}/sessions`)).json();
  expect(sessions).toHaveLength(2);
  expect(await (await request.get(`${API}/sessions/${original.id}/messages`)).json()).toEqual([]);
  const created = sessions.find((item) => item.id !== original.id);
  const messages = await (await request.get(`${API}/sessions/${created.id}/messages`)).json();
  expect(messages.some((message) => message.content === 'Only in the new conversation')).toBe(true);
  await page.getByRole('button', { name: /Original conversation/ }).click();
  await expect(input).toHaveValue(originalDraft);
});

test('failed New Chat creation keeps the original draft editable', async ({ page, request }) => {
  const p = await project(request, 'Browser Failed New Chat');
  await session(request, p.id, 'Original conversation');
  await chat(page, p.id);
  const input = page.getByPlaceholder('Ask Raven...');
  await input.fill('Keep this draft after create failure');
  await page.route(`${API}/projects/${encodeURIComponent(p.id)}/sessions/new`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'temporary create failure' }),
    });
  });
  await page.getByRole('button', { name: 'New Chat', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'temporary create failure' }),
  ).toBeVisible();
  await expect(input).toHaveValue('Keep this draft after create failure');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await input.fill('Edited draft remains available');
  await expect(input).toHaveValue('Edited draft remains available');
});

test('disconnected sends retain the draft and reconnect can deliver it once', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Disconnected Draft');
  await session(request, p.id, 'Offline conversation');
  let disconnected = false;
  const sockets = [];
  await page.routeWebSocket('ws://127.0.0.1:4421/ws', (socket) => {
    if (disconnected) socket.close({ code: 1012, reason: 'Fixture disconnect' });
    else {
      socket.connectToServer();
      sockets.push(socket);
    }
  });
  await chat(page, p.id);
  await expect.poll(() => sockets.length).toBeGreaterThan(0);
  disconnected = true;
  for (const socket of sockets) socket.close({ code: 1012, reason: 'Fixture disconnect' });
  await expect(page.getByText('Disconnected. Reconnecting...', { exact: true })).toBeVisible();
  const previous = (await state(request)).calls.length;
  await send(page, 'Keep this offline draft');
  await expect(page.getByPlaceholder('Ask Raven...')).toHaveValue('Keep this offline draft');
  expect((await state(request)).calls).toHaveLength(previous);
  disconnected = false;
  await expect(page.getByText('Disconnected. Reconnecting...', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Connecting...', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(`Browser reply ${previous + 1}`, { exact: true })).toBeVisible();
  expect((await state(request)).calls).toHaveLength(previous + 1);
});

test('reconnect reconciles a task that completed while the socket was down', async ({
  page,
  request,
}) => {
  const p = await project(request, 'Browser Missed Completion');
  const s = await session(request, p.id, 'Missed completion');
  let disconnected = false;
  const sockets = [];
  await page.routeWebSocket('ws://127.0.0.1:4421/ws', async (socket) => {
    if (disconnected) await socket.close({ code: 1012, reason: 'Fixture disconnect' });
    else {
      socket.connectToServer();
      sockets.push(socket);
    }
  });
  await chat(page, p.id);
  await send(page, 'hold-browser until connection drops');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  disconnected = true;
  for (const socket of sockets) await socket.close({ code: 1012, reason: 'Fixture disconnect' });
  await expect(page.getByText('Disconnected. Reconnecting...', { exact: true })).toBeVisible();
  const active = await (await request.get(`${API}/agent-tasks/active`)).json();
  const task = active.running.find((item) => item.sessionId === s.id);
  expect(task).toBeTruthy();
  expect((await request.post(`${API}/agent-tasks/${task.taskId}/cancel`)).ok()).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await state(request)).calls.find((call) =>
          call.prompt.includes('hold-browser until connection drops'),
        ).aborted,
    )
    .toBe(true);
  disconnected = false;
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  const next = (await state(request)).calls.length + 1;
  await send(page, 'Resume after missed completion');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
});

test('knowledge chat shows a real completion instead of an enqueue acknowledgement', async ({
  page,
  request,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/knowledge');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const next = (await state(request)).calls.length + 1;
  await send(page, 'Explain this knowledge context');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Done.', { exact: true })).toHaveCount(0);
  expect((await state(request)).calls.at(-1).prompt).toBe(
    '[Knowledge graph context]\n\nExplain this knowledge context',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('interrupted execution can be reviewed and deliberately resumed from mobile', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = 'browser-interrupted-tree';
  const before = await (await request.get(`${API}/task-trees/${id}`)).json();
  expect(before.status).toBe('pending_approval');
  expect(
    (await state(request)).calls.filter((call) => call.prompt.includes('resume-browser-tree')),
  ).toHaveLength(0);
  await page.goto('/tasks');
  const planCard = page
    .getByRole('region', { name: 'To Do', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Resume reviewed browser work' });
  await expect(planCard).toBeVisible();
  const planBounds = await planCard.boundingBox();
  expect(planBounds).toBeTruthy();
  expect(planBounds.x).toBeGreaterThanOrEqual(0);
  expect(planBounds.x + planBounds.width).toBeLessThanOrEqual(390);
  await planCard.getByText('Resume reviewed browser work', { exact: true }).click();
  await expect(page.getByText('Earlier research is retained.', { exact: true })).toBeVisible();
  await expect(page.getByText('Research result', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(`${API}/task-trees/${id}`)).json()).status)
    .toBe('completed');
  await page.reload();
  const completedPlanCard = page
    .getByRole('region', { name: 'Done', exact: true })
    .getByRole('button')
    .filter({ hasText: 'Resume reviewed browser work' });
  await expect(completedPlanCard).toBeVisible();
  const completedBounds = await completedPlanCard.boundingBox();
  expect(completedBounds).toBeTruthy();
  expect(completedBounds.x).toBeGreaterThanOrEqual(0);
  expect(completedBounds.x + completedBounds.width).toBeLessThanOrEqual(390);
  await completedPlanCard.getByText('Resume reviewed browser work', { exact: true }).click();
  await expect(page.getByText('Earlier research is retained.', { exact: true })).toBeVisible();
  expect(
    (await state(request)).calls.filter((call) => call.prompt.includes('resume-browser-tree')),
  ).toHaveLength(1);
});

test('mobile dashboard identifies rejected definitions and reload clears the correction', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await request.post('http://127.0.0.1:4422/invalid-definition')).ok()).toBe(true);
  try {
    expect((await request.post(`${API}/definitions/reload`)).ok()).toBe(true);
    const health = await (await request.get(`${API}/health`)).json();
    expect(health.status).toBe('degraded');
    expect(health.subsystems.definitions.diagnostics).toContainEqual(
      expect.objectContaining({
        path: 'schedules/browser-invalid.yaml',
        code: 'invalid-schedule-timing',
      }),
    );
    expect(
      (await (await request.get(`${API}/projects`)).json()).some(
        (project) => project.id === 'course',
      ),
    ).toBe(true);
    await page.goto('/');
    const issue = page.getByRole('region', { name: 'Definition issues' });
    await expect(issue.getByText('schedules/browser-invalid.yaml', { exact: true })).toBeVisible();
    const bounds = await issue.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect((await request.post('http://127.0.0.1:4422/repair-definition')).ok()).toBe(true);
    await issue.getByRole('button', { name: 'Reload definitions', exact: true }).click();
    await expect(page.getByText('schedules/browser-invalid.yaml', { exact: true })).toHaveCount(0);
    const repaired = await (await request.get(`${API}/health`)).json();
    expect(
      repaired.subsystems.definitions.diagnostics.some(
        (entry) => entry.path === 'schedules/browser-invalid.yaml',
      ),
    ).toBe(false);
  } finally {
    await request.post('http://127.0.0.1:4422/repair-definition');
    await request.post(`${API}/definitions/reload`);
  }
});

test('mobile agent memory requires a project and keeps nested project notes separate', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'raven', exact: true })).toBeVisible();
  await page.getByTitle('View Memory').first().click();
  await expect(page.getByRole('heading', { name: 'Project memory', exact: true })).toBeVisible();
  const selector = page.getByLabel('Project', { exact: true });
  await expect(selector).toHaveValue('');
  await expect(page.getByText('Course private memory sentinel.', { exact: true })).toHaveCount(0);
  await selector.selectOption('course');
  await expect(page.getByText('Course private memory sentinel.', { exact: true })).toBeVisible();
  await expect(page.getByText('research/notes.md', { exact: true })).toBeVisible();
  await selector.selectOption('course/one');
  await expect(page.getByText('Nested project memory sentinel.', { exact: true })).toBeVisible();
  await expect(page.getByText('Course private memory sentinel.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const response = await request.post(`${API}/agents`, {
    data: { name: 'browser-local-helper', skills: [], projectScope: 'course/one' },
  });
  expect(response.status()).toBe(201);
  const local = await response.json();
  expect(local.id).toBe('course/one::browser-local-helper');
  expect((await request.get(`${API}/agents/${encodeURIComponent(local.id)}`)).status()).toBe(200);
  await page.reload();
  const card = page.locator('div.rounded-lg.border').filter({
    has: page.getByRole('heading', { name: 'browser-local-helper', exact: true }),
  });
  await expect(card.getByText('one', { exact: true })).toBeVisible();
  await card.getByTitle('View Memory').click();
  await expect(selector).toHaveValue('course/one');
  await expect(page.getByText('Nested project memory sentinel.', { exact: true })).toBeVisible();
});
