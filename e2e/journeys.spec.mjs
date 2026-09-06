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

test('mobile settings distinguish accepted, failed, uncertain and partial Telegram delivery', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await request.post(`${CONTROL}/delivery-evidence`);
  expect(fixture.ok()).toBeTruthy();
  const response = await request.get(`${API}/notifications/deliveries?limit=25`);
  expect(response.ok()).toBeTruthy();
  const { deliveries } = await response.json();
  expect(deliveries.filter((item) => item.source === 'browser-delivery-fixture')).toHaveLength(4);
  await page.goto('/settings');
  await expect(
    page.getByRole('heading', { name: 'Notification Delivery', exact: true }),
  ).toBeVisible();
  for (const outcome of ['delivered', 'failed', 'unknown', 'partial']) {
    const card = page.getByRole('article', { name: `Browser delivery ${outcome}`, exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(outcome, { exact: true })).toBeVisible();
  }
  const partial = page.getByRole('article', { name: 'Browser delivery partial', exact: true });
  await expect(partial.getByText('Telegram ID 104', { exact: false })).toBeVisible();
  const error = partial.getByText('Attachment was rejected after text acceptance', { exact: true });
  await error.scrollIntoViewIfNeeded();
  await expect(error).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.browser-test-output/telegram-deliveries-mobile.png' });
  await page.reload();
  await expect(
    page.getByRole('article', { name: 'Browser delivery unknown', exact: true }),
  ).toBeVisible();
});

test('delivery diagnostics show a failed fetch instead of an empty successful history', async ({
  page,
}) => {
  await page.route('**/api/notifications/deliveries?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Delivery evidence temporarily unavailable' }),
    }),
  );
  await page.goto('/settings');
  await expect(
    page.getByText('Delivery evidence temporarily unavailable', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('No deliveries recorded.', { exact: true })).toHaveCount(0);
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
  await expect(page.getByText('Neo4j not available', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Project workspace', exact: true });
  await workspace.getByPlaceholder('Label', { exact: true }).fill('Reference note');
  await workspace
    .getByPlaceholder('Server folder path or URL')
    .fill('https://example.invalid/fixture');
  await workspace.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('url');
  await workspace.getByRole('button', { name: 'Attach source', exact: true }).click();
  await expect(workspace.getByText('Reference note', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await workspace.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(workspace.getByText('Reference note', { exact: true })).toHaveCount(0);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
  const persisted = await (await request.get(`${API}/projects/${encodeURIComponent(id)}`)).json();
  expect(persisted.name).toBe('Browser Created Project');
  expect(persisted.systemPrompt).toBe('Use concrete examples in every answer.');
  expect(
    await (await request.get(`${API}/projects/${encodeURIComponent(id)}/data-sources`)).json(),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('nested project links work in both grid and tree', async ({ page, request }) => {
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

test('model controls persist layered defaults and apply edits only to the next turn', async ({
  page,
  request,
}) => {
  await request.post(`${CONTROL}/model-discovery-success`);
  expect((await request.get(`${API}/models?refresh=true`)).ok()).toBeTruthy();
  const p = await project(request, 'Browser Model Controls');
  const s = await session(request, p.id, 'Model settings conversation');
  await session(request, p.id, 'Other model conversation');

  await page.goto(projectPath(p.id));
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Project workspace', exact: true });
  const projectModel = workspace.locator('details').filter({ hasText: 'Project model default' });
  await projectModel.getByText('Project model default', { exact: true }).click();
  await projectModel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('sonnet');
  await projectModel.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('high');
  await projectModel
    .getByRole('combobox', { name: 'Thinking', exact: true })
    .selectOption('adaptive');
  await projectModel.getByRole('button', { name: 'Save for next turn', exact: true }).click();
  await expect
    .poll(async () => {
      const current = await (await request.get(`${API}${projectPath(p.id)}/workspace`)).json();
      return current.execution.modelConfig;
    })
    .toEqual({ model: 'sonnet', effort: 'high', thinking: 'adaptive' });

  await chat(page, p.id);
  await page.getByRole('button', { name: /Model settings conversation/ }).click();
  const sessionModel = page.locator('details').filter({ hasText: 'Session model' });
  await sessionModel.getByText('Session model', { exact: true }).click();
  await sessionModel
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('claude-haiku-4-5');
  await page.getByRole('button', { name: /Other model conversation/ }).click();
  await sessionModel.getByText('Session model', { exact: true }).click();
  await expect(sessionModel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: /Model settings conversation/ }).click();
  await sessionModel.getByText('Session model', { exact: true }).click();
  await expect(sessionModel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('');
  await expect(sessionModel.getByText('Inherited:', { exact: false })).toBeVisible();
  await expect(
    sessionModel.getByText('Effective: claude-sonnet-5 · high effort · adaptive thinking'),
  ).toBeVisible();
  await sessionModel.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('xhigh');
  await sessionModel.getByRole('button', { name: 'Save for next turn', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(`${API}/sessions/${s.id}`)).json()).modelConfig)
    .toEqual({ effort: 'xhigh' });

  await page.reload();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toBeVisible();
  const reloadedModel = page.locator('details').filter({ hasText: 'Session model' });
  await reloadedModel.getByText('Session model', { exact: true }).click();
  await expect(reloadedModel.getByRole('combobox', { name: 'Effort', exact: true })).toHaveValue(
    'xhigh',
  );
  await expect(
    reloadedModel.getByText('Effective: claude-sonnet-5 · xhigh effort · adaptive thinking'),
  ).toBeVisible();

  await send(page, 'hold-browser model settings stay immutable');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect((await state(request)).calls.at(-1)).toMatchObject({
    model: 'claude-sonnet-5',
    effort: 'xhigh',
    thinking: 'adaptive',
  });
  await reloadedModel.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('low');
  await reloadedModel.getByRole('button', { name: 'Save for next turn', exact: true }).click();
  await expect(
    reloadedModel.getByText(
      'The active response keeps its admitted settings. Changes apply to the next turn.',
    ),
  ).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`${API}/sessions/${s.id}`)).json()).modelConfig)
    .toEqual({ effort: 'low' });
  expect((await state(request)).calls.at(-1).effort).toBe('xhigh');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped.', { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const current = await state(request);
      return current.calls.find((call) =>
        call.prompt.includes('hold-browser model settings stay immutable'),
      )?.aborted;
    })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

  const next = (await state(request)).calls.length + 1;
  await send(page, 'Model settings on the next turn');
  await expect(page.getByText(`Browser reply ${next}`, { exact: true })).toBeVisible();
  expect((await state(request)).calls.at(-1)).toMatchObject({
    model: 'claude-sonnet-5',
    effort: 'low',
    thinking: 'adaptive',
  });

  const model = reloadedModel.getByRole('combobox', { name: 'Model', exact: true });
  const effort = reloadedModel.getByRole('combobox', { name: 'Effort', exact: true });
  const thinking = reloadedModel.getByRole('combobox', { name: /Thinking/, exact: true });
  await model.selectOption('claude-haiku-4-5');
  await expect(effort.locator('option[value="high"]')).toHaveAttribute('disabled', '');
  await expect(thinking.locator('option[value="adaptive"]')).toHaveAttribute('disabled', '');
  await model.selectOption('claude-sonnet-5');
  await effort.selectOption('high');
  await thinking.selectOption('disabled');
  await model.selectOption('claude-fable-5-1');
  await expect(reloadedModel.getByText('Fable fixture requires thinking')).toBeVisible();
  await expect(
    reloadedModel.getByRole('button', { name: 'Save for next turn', exact: true }),
  ).toBeDisabled();
  await expect(thinking.locator('option[value="disabled"]')).toHaveAttribute('disabled', '');
  await reloadedModel.getByRole('button', { name: 'Clear override', exact: true }).click();
  await expect
    .poll(async () => (await (await request.get(`${API}/sessions/${s.id}`)).json()).modelConfig)
    .toBeUndefined();
  await expect(
    reloadedModel.getByText('Effective: claude-sonnet-5 · high effort · adaptive thinking'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const resetProjectModel = workspace
    .locator('details')
    .filter({ hasText: 'Project model default' });
  await resetProjectModel.getByText('Project model default', { exact: true }).click();
  await resetProjectModel.getByRole('button', { name: 'Clear override', exact: true }).click();
  await expect
    .poll(async () => {
      const current = await (await request.get(`${API}${projectPath(p.id)}/workspace`)).json();
      return current.execution.modelConfig;
    })
    .toBeUndefined();
});

test('model catalog and validation failures stay visible with an isolated retry', async ({
  page,
  request,
}) => {
  await request.post(`${CONTROL}/model-discovery-success`);
  expect((await request.get(`${API}/models?refresh=true`)).ok()).toBeTruthy();
  const p = await project(request, 'Browser Model Failure');
  await session(request, p.id, 'Model catalog failure');
  const catalogFailure = (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Catalog fixture fetch failed' }),
    });
  await page.route('**/api/models*', catalogFailure);
  await chat(page, p.id);
  const modelControl = page.locator('details').filter({ hasText: 'Session model' });
  await modelControl.getByText('Session model', { exact: true }).click();
  await expect(
    modelControl.getByText('Model catalog unavailable:', { exact: false }),
  ).toContainText('Catalog fixture fetch failed');
  await expect(
    modelControl.getByRole('option', { name: 'Sonnet preset', exact: true }),
  ).toHaveCount(1);
  await modelControl.getByRole('combobox', { name: 'Model', exact: true }).selectOption('sonnet');
  await page.unroute('**/api/models*', catalogFailure);
  await modelControl.getByRole('button', { name: 'Refresh model catalog', exact: true }).click();
  await expect(
    modelControl.getByText('Reported availability is not an entitlement check.', { exact: false }),
  ).toBeVisible();

  await request.post(`${CONTROL}/model-discovery-failure`);
  const failedRefresh = await request.get(`${API}/models?refresh=true`);
  expect(failedRefresh.ok()).toBeTruthy();
  expect((await failedRefresh.json()).error).toContain('Fixture model discovery unavailable');
  await page.reload();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const staleControl = page.locator('details').filter({ hasText: 'Session model' });
  await staleControl.getByText('Session model', { exact: true }).click();
  await expect(staleControl.getByText('Model catalog is stale', { exact: false })).toContainText(
    'Fixture model discovery unavailable',
  );
  await request.post(`${CONTROL}/model-discovery-success`);
  await staleControl.getByRole('button', { name: 'Refresh model catalog', exact: true }).click();
  await expect(
    staleControl.getByText('Reported availability is not an entitlement check.', { exact: false }),
  ).toBeVisible();
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
  await page
    .getByRole('combobox', { name: 'Knowledge project', exact: true })
    .selectOption('course');
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
  await page.getByRole('button', { name: 'View file', exact: true }).click();
  await expect(
    page.getByText('# Retained browser research artifact', { exact: false }),
  ).toBeVisible();
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

test('attachment errors stay in view after scrolling and preserve the source draft for correction', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await (await request.get(`${CONTROL}/workspace`)).json();
  const created = await project(request, 'Attachment error visibility');
  const sourcesUrl = `${API}${projectPath(created.id)}/data-sources`;
  for (let index = 0; index < 4; index++) {
    const response = await request.post(sourcesUrl, {
      data: {
        label: `Existing reference ${index}`,
        uri: `https://example.invalid/${index}`,
        sourceType: 'url',
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(projectPath(created.id));
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Project workspace', exact: true });
  const form = workspace.locator('section').filter({
    has: page.getByRole('heading', { name: 'Attach source', exact: true }),
  });
  const label = form.getByPlaceholder('Label', { exact: true });
  const folder = form.getByPlaceholder('Server folder path or URL');
  const context = workspace.getByPlaceholder('Context files, one relative path per line');
  await label.fill('Repository to attach');
  await folder.fill(`${fixture.repository}/missing`);
  await context.fill('AGENTS.md\nREADME.md');
  const response = page.waitForResponse(
    (r) => r.url() === sourcesUrl && r.request().method() === 'POST',
  );
  await workspace.getByRole('button', { name: 'Attach source', exact: true }).click();
  expect((await response).status()).toBe(400);
  const alert = workspace.getByRole('alert');
  await expect(alert).toContainText(`${fixture.repository}/missing`);
  await expect(alert).toContainText('/workspace/<repository>');
  await expect(alert).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.browser-test-output/attachment-error-mobile.png' });
  await expect(label).toHaveValue('Repository to attach');
  await expect(folder).toHaveValue(`${fixture.repository}/missing`);
  await expect(context).toHaveValue('AGENTS.md\nREADME.md');
  await alert.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(alert).toHaveCount(0);
  await expect(folder).toHaveValue(`${fixture.repository}/missing`);
  await folder.fill(fixture.repository);
  await workspace.getByRole('button', { name: 'Attach source', exact: true }).click();
  await expect(
    workspace.getByRole('listitem').filter({ hasText: 'Repository to attach' }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('mobile workspace runs a command, pushes real artifacts, and previews and downloads the outputs', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await (await request.get(`${CONTROL}/workspace`)).json();
  const created = await project(request, 'Browser repository workspace');
  await page.goto(projectPath(created.id));
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Project workspace', exact: true });
  await expect(workspace).toBeVisible();
  await workspace.getByPlaceholder('Label', { exact: true }).fill('Attached repository');
  const folderInput = workspace.getByPlaceholder('Server folder path or URL');
  await folderInput.fill(`${fixture.repository}/missing`);
  await workspace.getByRole('button', { name: 'Attach source', exact: true }).click();
  await expect(workspace.getByRole('alert')).toBeVisible();
  await expect(workspace.getByPlaceholder('Label', { exact: true })).toHaveValue(
    'Attached repository',
  );
  await expect(folderInput).toHaveValue(`${fixture.repository}/missing`);
  await folderInput.fill(fixture.repository);
  await workspace
    .getByPlaceholder('Context files, one relative path per line')
    .fill('AGENTS.md\nREADME.md');
  await workspace.getByRole('button', { name: 'Attach source', exact: true }).click();
  const sourceRow = workspace.getByRole('listitem').filter({ hasText: 'Attached repository' });
  await expect(sourceRow).toBeVisible();
  const executionReminder = workspace
    .getByRole('status')
    .filter({ hasText: 'For autonomous repository commands' });
  await expect(executionReminder).toBeVisible();
  const config = await (await request.get(`${API}${projectPath(created.id)}/workspace`)).json();
  const sourceId = config.sources[0].id;
  expect(config.sources[0].contextFiles).toEqual(['AGENTS.md', 'README.md']);
  await workspace
    .getByRole('combobox', { name: 'Working folder', exact: true })
    .selectOption(sourceId);
  await workspace.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('full');
  await workspace.getByRole('button', { name: 'Save execution settings', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${API}${projectPath(created.id)}/workspace`)).json()).execution,
    )
    .toEqual({ mode: 'full', sourceId });
  await expect(executionReminder).toHaveCount(0);
  await page.getByRole('button', { name: 'New Chat', exact: true }).click();
  await expect(page.getByPlaceholder('Ask Raven...')).toBeVisible();
  await send(
    page,
    'workspace-artifact-browser: create and verify the report, then commit and push',
  );
  await expect
    .poll(async () => (await (await request.get(`${CONTROL}/workspace`)).json()).artifact)
    .toContain('Generated by a Raven workspace command.');
  const pushed = await (await request.get(`${CONTROL}/workspace`)).json();
  expect(pushed.commit).toMatch(/^[a-f0-9]{40}$/);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const files = workspace.getByRole('region', { name: 'Project files', exact: true });
  await files.getByRole('combobox', { name: 'Source', exact: true }).selectOption(sourceId);
  await files.getByRole('button', { name: 'Refresh', exact: true }).click();
  const directPath = files.getByRole('textbox', { name: 'File or folder path', exact: true });
  await directPath.fill('missing-folder');
  await files.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(files.getByRole('alert')).toBeVisible();
  await directPath.fill('outputs');
  await files.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(files.getByRole('button', { name: /report # українська.md$/ })).toBeVisible();
  await directPath.fill('outputs/report # українська.md');
  await files.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    files.getByText('Generated by a Raven workspace command.', { exact: false }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await files.getByRole('link', { name: 'Download', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('report # українська.md');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(await download.path(), 'utf8')).toBe(pushed.artifact);
  await files.getByRole('button', { name: /chart.png$/ }).click();
  const image = files.getByRole('img', { name: 'chart.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBe(1);
  await files.getByRole('button', { name: /report.html$/ }).click();
  const html = files.locator('iframe[title="report.html"]');
  await expect(html).toHaveAttribute('sandbox', '');
  await expect(
    page
      .frameLocator('iframe[title="report.html"]')
      .getByRole('heading', { name: 'Workspace HTML preview' }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__artifactEscape)).toBeUndefined();
  const htmlQuery = new URLSearchParams({ sourceId, path: 'outputs/report.html' });
  const htmlInfo = await (
    await request.get(`${API}${projectPath(created.id)}/files/info?${htmlQuery}`)
  ).json();
  htmlQuery.set('revision', htmlInfo.revision);
  const htmlResponse = await request.get(
    `${API}${projectPath(created.id)}/files/content?${htmlQuery}`,
  );
  expect(htmlResponse.headers()['content-security-policy']).toContain('sandbox');
  await files.getByRole('button', { name: /invalid.pdf$/ }).click();
  await expect(files.getByRole('alert')).toBeVisible();
  await files.getByRole('button', { name: /report.pdf$/ }).click();
  const pdfCanvas = files.getByRole('img', { name: 'PDF page 1', exact: true });
  await expect(pdfCanvas).toHaveAttribute('data-rendered', 'true');
  expect(
    await pdfCanvas.evaluate((canvas) => {
      const context = canvas.getContext('2d');
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index + 3] &&
          pixels[index] < 100 &&
          pixels[index + 1] < 100 &&
          pixels[index + 2] < 100
        )
          dark++;
      }
      return dark;
    }),
  ).toBeGreaterThan(100);
  await pdfCanvas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.browser-test-output/workspace-pdf-mobile.png' });
  await files.getByRole('button', { name: 'Next PDF page', exact: true }).click();
  await expect(files.getByRole('img', { name: 'PDF page 2', exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
  );
  await expect(files.getByText('Page 2 of 2', { exact: true })).toBeVisible();
  await files.getByText('Page text', { exact: true }).click();
  await expect(files.getByText('Second page verified', { exact: true })).toBeVisible();
  await files.getByRole('button', { name: 'Previous PDF page', exact: true }).click();
  await expect(pdfCanvas).toHaveAttribute('data-rendered', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.reload();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(workspace.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('full');
  await expect(
    workspace.getByRole('combobox', { name: 'Working folder', exact: true }),
  ).toHaveValue(sourceId);
  page.once('dialog', (dialog) => dialog.accept());
  await sourceRow.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(sourceRow).toHaveCount(0);
  expect(
    (await request.get(`${API}${projectPath(created.id)}/files/content?${htmlQuery}`)).status(),
  ).toBe(404);
  expect((await (await request.get(`${CONTROL}/workspace`)).json()).artifact).toBe(pushed.artifact);
});

test('knowledge graph requires explicit project selection and keeps it when the project list reorders', async ({
  page,
  request,
}) => {
  const projects = await (await request.get(`${API}/projects`)).json();
  const selected = projects.filter((item) => ['course', 'course/one'].includes(item.id));
  expect(selected).toHaveLength(2);
  let reverse = false;
  const graphRequests = [];
  await page.route(`${API}/projects`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reverse ? [...selected].reverse() : selected),
    }),
  );
  await page.route(`${API}/knowledge/graph?**`, (route) => {
    graphRequests.push(new URL(route.request().url()).searchParams.get('projectId'));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: [], edges: [], view: 'links' }),
    });
  });
  await page.goto('/knowledge');
  const selector = page.getByRole('combobox', { name: 'Knowledge project', exact: true });
  await expect(selector).toHaveValue('');
  await expect(selector.locator('option')).toHaveCount(3);
  expect(graphRequests).toEqual([]);
  await selector.selectOption('course');
  await expect.poll(() => graphRequests.at(-1)).toBe('course');
  await expect(page).toHaveURL(/projectId=course$/);
  reverse = true;
  await page.reload();
  await expect(selector).toHaveValue('course');
  let delayedSearch;
  await page.route(`${API}/knowledge/search`, (route) => {
    delayedSearch = route;
  });
  await page.getByPlaceholder('Search knowledge...').fill('delayed project search');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect.poll(() => Boolean(delayedSearch)).toBe(true);
  await selector.selectOption('course/one');
  await expect.poll(() => graphRequests.at(-1)).toBe('course/one');
  const delayedResponse = page.waitForResponse(`${API}/knowledge/search`);
  await delayedSearch.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ results: [{ bubbleId: 'previous-project', score: 1 }] }),
  });
  await (await delayedResponse).finished();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.getByPlaceholder('Search knowledge...')).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Graph color', exact: true })).toHaveValue(
    'domain',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page).toHaveURL(/projectId=course%2Fone$/);
  await selector.selectOption('');
  await expect(page).toHaveURL('/knowledge');
  expect(graphRequests.every(Boolean)).toBe(true);
});
