# Telegram Topic Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Telegram bot from creating duplicate forum topics for agents/projects on every boot by persisting topic mappings in SQLite.

**Architecture:** Agent→topic and project→topic mappings currently live only in in-memory `Map`s inside `suites/notifications/services/telegram-bot.ts`, so every restart re-creates all topics. We add a `telegram_topics` table (migration 024), a small `topic-store.ts` module over `DatabaseInterface`, consult it in `ensureAgentTopic`/`ensureProjectTopic` before creating, persist after creating, delete on project-topic close, and invalidate stale mappings when Telegram reports "message thread not found" on send (next ensure recreates — once, lazily, never a loop). In-memory maps stay as per-process caches.

**Tech Stack:** TypeScript ESM, better-sqlite3 (via `DatabaseInterface`), grammy (mocked in tests), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-consolidated-orchestration-design.md` §1 (telegram_topics table), §5 (fix), §6, §7.

**Conventions reminders:** `.ts` extensions in imports; `explicit-function-return-type` and `max-params: 3` are errors in src (test files relaxed); no chained shell commands — run them one by one; `npm run check` must pass at the end.

---

### Task 1: Migration + topic-store module

**Files:**
- Create: `migrations/024-telegram-topics.sql`
- Create: `suites/notifications/services/topic-store.ts`
- Create: `suites/notifications/__tests__/helpers/test-db.ts`
- Test: `suites/notifications/__tests__/topic-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `suites/notifications/__tests__/helpers/test-db.ts`:

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseInterface } from '@raven/shared';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '../../../../migrations/024-telegram-topics.sql',
);

// In-memory DatabaseInterface with the telegram_topics migration applied.
// Also creates a minimal named_agents table so the bot's bootstrap query works.
export function createTestDb(): DatabaseInterface {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  raw.exec('CREATE TABLE IF NOT EXISTS named_agents (name TEXT PRIMARY KEY)');
  return {
    run: (sql: string, ...params: unknown[]): void => {
      raw.prepare(sql).run(...params);
    },
    get: <T>(sql: string, ...params: unknown[]): T | undefined =>
      raw.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]): T[] => raw.prepare(sql).all(...params) as T[],
  };
}
```

Note the path: `helpers/` is one level deeper than `__tests__/`, so it's four `../` up to the repo root.

Create `suites/notifications/__tests__/topic-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseInterface } from '@raven/shared';
import { createTestDb } from './helpers/test-db.ts';
import {
  getStoredTopic,
  saveStoredTopic,
  deleteStoredTopic,
} from '../services/topic-store.ts';

describe('topic-store', () => {
  let db: DatabaseInterface;
  const ref = { scope: 'agent' as const, key: 'raven', groupId: '-100123' };

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns undefined when no mapping stored', () => {
    expect(getStoredTopic(db, ref)).toBeUndefined();
  });

  it('returns stored topic id after save', () => {
    saveStoredTopic(db, ref, 42);
    expect(getStoredTopic(db, ref)).toBe(42);
  });

  it('upserts on duplicate save (same scope/key/group)', () => {
    saveStoredTopic(db, ref, 42);
    saveStoredTopic(db, ref, 99);
    expect(getStoredTopic(db, ref)).toBe(99);
  });

  it('scopes lookups by scope, key, and groupId', () => {
    saveStoredTopic(db, ref, 42);
    expect(getStoredTopic(db, { ...ref, scope: 'project' })).toBeUndefined();
    expect(getStoredTopic(db, { ...ref, key: 'other' })).toBeUndefined();
    expect(getStoredTopic(db, { ...ref, groupId: '-999' })).toBeUndefined();
  });

  it('deletes a stored mapping', () => {
    saveStoredTopic(db, ref, 42);
    deleteStoredTopic(db, ref);
    expect(getStoredTopic(db, ref)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run suites/notifications/__tests__/topic-store.test.ts`
Expected: FAIL — cannot resolve `../services/topic-store.ts` (and the migration file read fails until it exists).

- [ ] **Step 3: Create the migration**

Create `migrations/024-telegram-topics.sql`:

```sql
CREATE TABLE IF NOT EXISTS telegram_topics (
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'project')),
  key TEXT NOT NULL,
  group_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key, group_id)
);
```

- [ ] **Step 4: Write the topic-store implementation**

Create `suites/notifications/services/topic-store.ts`:

```ts
import type { DatabaseInterface } from '@raven/shared';

export type TopicScope = 'agent' | 'project';

export interface TopicRef {
  scope: TopicScope;
  key: string; // agent name or project id
  groupId: string;
}

export function getStoredTopic(db: DatabaseInterface, ref: TopicRef): number | undefined {
  const row = db.get<{ topic_id: number }>(
    'SELECT topic_id FROM telegram_topics WHERE scope = ? AND key = ? AND group_id = ?',
    ref.scope,
    ref.key,
    ref.groupId,
  );
  return row?.topic_id;
}

export function saveStoredTopic(db: DatabaseInterface, ref: TopicRef, topicId: number): void {
  db.run(
    `INSERT INTO telegram_topics (scope, key, group_id, topic_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key, group_id) DO UPDATE SET topic_id = excluded.topic_id`,
    ref.scope,
    ref.key,
    ref.groupId,
    topicId,
  );
}

export function deleteStoredTopic(db: DatabaseInterface, ref: TopicRef): void {
  db.run(
    'DELETE FROM telegram_topics WHERE scope = ? AND key = ? AND group_id = ?',
    ref.scope,
    ref.key,
    ref.groupId,
  );
}
```

(`TopicRef` keeps every function at ≤3 params — `max-params` is an error-level rule.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run suites/notifications/__tests__/topic-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/024-telegram-topics.sql suites/notifications/services/topic-store.ts suites/notifications/__tests__/topic-store.test.ts suites/notifications/__tests__/helpers/test-db.ts
git commit -m "feat(telegram): add telegram_topics table and topic-store module"
```

---

### Task 2: Persist agent topics in ensureAgentTopic

**Files:**
- Modify: `suites/notifications/services/telegram-bot.ts:936-961` (`ensureAgentTopic`) and imports at top
- Test: `suites/notifications/__tests__/telegram-bot.test.ts` (new describe block; also add `createForumTopic` to `MockBot`)

- [ ] **Step 1: Extend the grammy mock**

In `suites/notifications/__tests__/telegram-bot.test.ts`, add next to the other mock fns (top of file):

```ts
const mockCreateForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 42 });
const mockCloseForumTopic = vi.fn().mockResolvedValue(true);
```

Add both to `MockBot`'s `api` object (line ~27):

```ts
api = {
  sendMessage: mockSendMessage,
  sendDocument: mockSendDocument,
  getChat: mockGetChat,
  editMessageReplyMarkup: mockEditMessageReplyMarkup,
  editMessageText: mockEditMessageText,
  deleteMessage: mockDeleteMessage,
  createForumTopic: mockCreateForumTopic,
  closeForumTopic: mockCloseForumTopic,
};
```

And reset them in the existing `beforeEach` alongside the others:

```ts
mockCreateForumTopic.mockResolvedValue({ message_thread_id: 42 });
mockCloseForumTopic.mockResolvedValue(true);
```

- [ ] **Step 2: Write the failing tests**

Add a new describe block at the end of `describe('telegram-bot service', ...)`:

```ts
describe('topic persistence', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '123';
    process.env.TELEGRAM_GROUP_ID = '-1001234567890';
    delete process.env.TELEGRAM_TOPIC_GENERAL;
    delete process.env.TELEGRAM_TOPIC_SYSTEM;
    delete process.env.TELEGRAM_TOPIC_MAP;
  });

  it('creates and persists a new agent topic', async () => {
    const { createTestDb } = await import('./helpers/test-db.ts');
    const { getStoredTopic } = await import('../services/topic-store.ts');
    const db = createTestDb();
    const mod = await loadService();
    await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

    const threadId = await mod.ensureAgentTopic('raven');

    expect(threadId).toBe(42);
    expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
    expect(
      getStoredTopic(db, { scope: 'agent', key: 'raven', groupId: '-1001234567890' }),
    ).toBe(42);
  });

  it('reuses a persisted agent topic across restarts (no duplicate creation)', async () => {
    const { createTestDb } = await import('./helpers/test-db.ts');
    const db = createTestDb();
    const mod = await loadService();
    await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
    await mod.ensureAgentTopic('raven');
    expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);

    // Simulate restart: stop clears in-memory maps, same DB persists
    await service.stop();
    await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

    const threadId = await mod.ensureAgentTopic('raven');
    expect(threadId).toBe(42);
    expect(mockCreateForumTopic).toHaveBeenCalledTimes(1); // still 1 — no duplicate
  });

  it('bootstrap does not re-create topics that are already persisted', async () => {
    const { createTestDb } = await import('./helpers/test-db.ts');
    const { saveStoredTopic } = await import('../services/topic-store.ts');
    const db = createTestDb();
    db.run('INSERT INTO named_agents (name) VALUES (?)', 'raven');
    saveStoredTopic(db, { scope: 'agent', key: 'raven', groupId: '-1001234567890' }, 42);

    await loadService();
    await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

    // bootstrap runs fire-and-forget; give microtasks a chance
    await new Promise((r) => setTimeout(r, 10));
    expect(mockCreateForumTopic).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: the three new tests FAIL (`getStoredTopic` returns undefined; `createForumTopic` called twice in the restart test; bootstrap test calls `createForumTopic`). Pre-existing tests still PASS.

- [ ] **Step 4: Implement persistence in ensureAgentTopic**

In `suites/notifications/services/telegram-bot.ts`, add to the imports near the top:

```ts
import { getStoredTopic, saveStoredTopic, deleteStoredTopic } from './topic-store.ts';
```

(`deleteStoredTopic` is used in Tasks 3-4; if lint complains about an unused import before then, add it in the task that uses it instead.)

Replace `ensureAgentTopic` (currently lines 936-961) with:

```ts
export async function ensureAgentTopic(agentName: string): Promise<number | undefined> {
  if (operatingMode !== 'group' || !bot) return undefined;

  // Check if already mapped in this process
  const existing = agentTopicMap.get(agentName);
  if (existing !== undefined) return existing;

  // Check if a topic already exists in the static config
  const staticId = topicConfig.topicMap[agentName];
  if (staticId !== undefined) {
    agentTopicMap.set(agentName, staticId);
    return staticId;
  }

  // Check the persistent store (survives restarts)
  if (dbRef) {
    const storedId = getStoredTopic(dbRef, { scope: 'agent', key: agentName, groupId });
    if (storedId !== undefined) {
      agentTopicMap.set(agentName, storedId);
      return storedId;
    }
  }

  // Create a new forum topic for this agent
  try {
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    const result = await bot.api.createForumTopic(groupId, `Agent: ${displayName}`);
    agentTopicMap.set(agentName, result.message_thread_id);
    if (dbRef) {
      saveStoredTopic(
        dbRef,
        { scope: 'agent', key: agentName, groupId },
        result.message_thread_id,
      );
    }
    logger.info(
      `Created Telegram topic for agent "${agentName}" (thread: ${result.message_thread_id})`,
    );
    return result.message_thread_id;
  } catch (err) {
    logger.warn(`Failed to create Telegram topic for agent "${agentName}": ${err}`);
    return undefined;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add suites/notifications/services/telegram-bot.ts suites/notifications/__tests__/telegram-bot.test.ts
git commit -m "fix(telegram): persist agent topic mappings, stop duplicate topics on boot"
```

---

### Task 3: Persist project topics, delete on close

**Files:**
- Modify: `suites/notifications/services/telegram-bot.ts:964-1006` (`ensureProjectTopic`, `closeProjectTopic`)
- Test: `suites/notifications/__tests__/telegram-bot.test.ts` (extend `topic persistence` block)

- [ ] **Step 1: Write the failing tests**

Add inside the `topic persistence` describe block:

```ts
it('reuses a persisted project topic across restarts', async () => {
  const { createTestDb } = await import('./helpers/test-db.ts');
  const db = createTestDb();
  const mod = await loadService();
  await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
  await mod.ensureProjectTopic('proj-1', 'My Project');
  expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);

  await service.stop();
  await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

  const threadId = await mod.ensureProjectTopic('proj-1', 'My Project');
  expect(threadId).toBe(42);
  expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
});

it('deletes the persisted mapping when a project topic is closed', async () => {
  const { createTestDb } = await import('./helpers/test-db.ts');
  const { getStoredTopic } = await import('../services/topic-store.ts');
  const db = createTestDb();
  const mod = await loadService();
  await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
  await mod.ensureProjectTopic('proj-1', 'My Project');

  await mod.closeProjectTopic('proj-1');

  expect(mockCloseForumTopic).toHaveBeenCalledTimes(1);
  expect(
    getStoredTopic(db, { scope: 'project', key: 'proj-1', groupId: '-1001234567890' }),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: the restart test FAILS (`createForumTopic` called twice); the close test FAILS only if the mapping was never persisted — both assert behavior that doesn't exist yet.

- [ ] **Step 3: Implement**

Replace `ensureProjectTopic` and `closeProjectTopic` (currently lines 964-1006) with:

```ts
export async function ensureProjectTopic(
  projectId: string,
  projectName: string,
): Promise<number | undefined> {
  if (operatingMode !== 'group' || !bot) return undefined;

  // Meta-project uses the System topic
  if (projectId === META_PROJECT_ID) return topicConfig.systemTopicId;

  // Check if already tracked in this process
  const existing = projectTopicMap.get(projectId);
  if (existing !== undefined) return existing;

  // Check the persistent store (survives restarts)
  if (dbRef) {
    const storedId = getStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
    if (storedId !== undefined) {
      projectTopicMap.set(projectId, storedId);
      topicConfig.topicToProject[projectName] = projectId;
      topicConfig.reverseMap[storedId] = projectName;
      return storedId;
    }
  }

  try {
    const result = await bot.api.createForumTopic(groupId, projectName);
    projectTopicMap.set(projectId, result.message_thread_id);
    // Also update topicToProject mapping for incoming message routing
    topicConfig.topicToProject[projectName] = projectId;
    topicConfig.reverseMap[result.message_thread_id] = projectName;
    if (dbRef) {
      saveStoredTopic(
        dbRef,
        { scope: 'project', key: projectId, groupId },
        result.message_thread_id,
      );
    }
    logger.info(
      `Created Telegram topic for project "${projectName}" (thread: ${result.message_thread_id})`,
    );
    return result.message_thread_id;
  } catch (err) {
    logger.warn(`Failed to create Telegram topic for project "${projectName}": ${err}`);
    return undefined;
  }
}

export async function closeProjectTopic(projectId: string): Promise<void> {
  if (operatingMode !== 'group' || !bot) return;

  const threadId =
    projectTopicMap.get(projectId) ??
    (dbRef ? getStoredTopic(dbRef, { scope: 'project', key: projectId, groupId }) : undefined);
  if (threadId === undefined) return;

  try {
    await bot.api.closeForumTopic(groupId, threadId);
    projectTopicMap.delete(projectId);
    if (dbRef) {
      deleteStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
    }
    logger.info(`Closed Telegram topic for deleted project "${projectId}" (thread: ${threadId})`);
  } catch (err) {
    logger.warn(`Failed to close Telegram topic for project "${projectId}": ${err}`);
  }
}
```

(This is where the `deleteStoredTopic` import from Task 2 becomes used.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add suites/notifications/services/telegram-bot.ts suites/notifications/__tests__/telegram-bot.test.ts
git commit -m "fix(telegram): persist project topic mappings and clean up on close"
```

---

### Task 4: Invalidate stale topics on send failure

**Files:**
- Modify: `suites/notifications/services/telegram-bot.ts:199-219` (`sendMessageWithFallback`) + new helper near the topic functions
- Test: `suites/notifications/__tests__/telegram-bot.test.ts` (extend `topic persistence` block)

- [ ] **Step 1: Write the failing test**

```ts
it('invalidates a stale topic mapping when Telegram reports thread not found', async () => {
  const { createTestDb } = await import('./helpers/test-db.ts');
  const { getStoredTopic, saveStoredTopic } = await import('../services/topic-store.ts');
  const db = createTestDb();
  saveStoredTopic(db, { scope: 'agent', key: 'raven', groupId: '-1001234567890' }, 42);

  const mod = await loadService();
  await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
  await mod.ensureAgentTopic('raven'); // loads stale id 42 from store

  // Topic 42 was deleted in Telegram: sends to it fail, fallback (no thread) succeeds
  mockSendMessage.mockImplementation((_chat: string, _text: string, opts: any) => {
    if (opts?.message_thread_id === 42) {
      return Promise.reject(new Error('Bad Request: message thread not found'));
    }
    return Promise.resolve({});
  });

  const handler = eventHandlers['notification:deliver']?.[0];
  handler({
    type: 'notification',
    payload: { channel: 'telegram', title: 'Alert', body: 'Content', topicName: 'raven' },
  });

  await vi.waitFor(() => {
    // stale mapping removed from the persistent store
    expect(
      getStoredTopic(db, { scope: 'agent', key: 'raven', groupId: '-1001234567890' }),
    ).toBeUndefined();
  });

  // Next ensure recreates the topic exactly once
  mockCreateForumTopic.mockResolvedValue({ message_thread_id: 77 });
  const newId = await mod.ensureAgentTopic('raven');
  expect(newId).toBe(77);
  expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: FAIL — `getStoredTopic` still returns 42 (no invalidation logic exists).

- [ ] **Step 3: Implement invalidation**

In `telegram-bot.ts`, add near the topic management functions (after `agentTopicMap` declaration):

```ts
const THREAD_NOT_FOUND_RE = /thread not found/i;

function invalidateTopicByThreadId(threadId: number): void {
  for (const [agentName, id] of agentTopicMap) {
    if (id === threadId) {
      agentTopicMap.delete(agentName);
      if (dbRef) deleteStoredTopic(dbRef, { scope: 'agent', key: agentName, groupId });
      logger.warn(`Invalidated stale Telegram topic ${threadId} for agent "${agentName}"`);
    }
  }
  for (const [projectId, id] of projectTopicMap) {
    if (id === threadId) {
      projectTopicMap.delete(projectId);
      if (dbRef) deleteStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
      logger.warn(`Invalidated stale Telegram topic ${threadId} for project "${projectId}"`);
    }
  }
}
```

Note: `agentTopicMap` is declared at line ~934, *below* `sendMessageWithFallback`. Function declarations hoist, so `invalidateTopicByThreadId` can live next to the maps and still be called from `sendMessageWithFallback` above.

In `sendMessageWithFallback` (lines 199-219), extend the catch:

```ts
async function sendMessageWithFallback(
  text: string,
  parseMode?: 'MarkdownV2' | 'HTML',
  messageThreadId?: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await sendMessage(text, parseMode, messageThreadId, replyMarkup);
  } catch (err) {
    if (messageThreadId !== undefined) {
      if (THREAD_NOT_FOUND_RE.test(String(err))) {
        invalidateTopicByThreadId(messageThreadId);
      }
      logger.warn(`Topic send failed (thread ${messageThreadId}), falling back to non-topic send`);
      try {
        await sendMessage(text, parseMode, undefined, replyMarkup);
      } catch (fallbackErr) {
        logger.error(`Telegram fallback send failed: ${fallbackErr}`);
      }
    } else {
      logger.error(`Telegram send failed: ${err}`);
    }
  }
}
```

(`sendMessageWithFallback` already has 4 params; `max-params` only applies to new signatures you write — do not add params to it. If ESLint flags the pre-existing signature after modification, keep the change minimal inside the function body only.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run suites/notifications/__tests__/telegram-bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add suites/notifications/services/telegram-bot.ts suites/notifications/__tests__/telegram-bot.test.ts
git commit -m "fix(telegram): invalidate stale topic mappings on thread-not-found"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all projects PASS, no regressions.

- [ ] **Step 2: Run lint/format gate**

Run: `npm run check`
Expected: clean. If Prettier complains, run `npm run format`, re-run `npm run check`, and amend the relevant commit.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success — confirms `.ts` import rewrites compile.

- [ ] **Step 4: Commit any remaining fixes and push**

```bash
git push
```

**Manual follow-up for the user (one-time):** delete the existing duplicate topics in the Telegram group by hand. On the next boot, Raven creates one topic per agent and persists it; no further duplicates.
