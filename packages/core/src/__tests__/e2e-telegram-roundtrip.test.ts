import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Grammy from 'grammy';
import type { Update } from 'grammy/types';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

interface TelegramApiCall {
  method: string;
  payload: Record<string, unknown>;
  messageId?: number;
}

const telegram = vi.hoisted(() => ({
  bot: undefined as Grammy.Bot | undefined,
  calls: [] as TelegramApiCall[],
  nextMessageId: 500,
}));

vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof Grammy>();
  const botInfo = {
    id: 42,
    is_bot: true as const,
    first_name: 'Raven Test Bot',
    username: 'raven_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };

  class FakePollingBot extends actual.Bot {
    constructor(token: string, config: ConstructorParameters<typeof actual.Bot>[1] = {}) {
      super(token, { ...config, botInfo });
      telegram.bot = this;
      this.api.config.use(async (_previous, method, payload) => {
        const call: TelegramApiCall = {
          method,
          payload: payload as Record<string, unknown>,
        };
        telegram.calls.push(call);
        if (method === 'getMe') return { ok: true, result: botInfo } as never;
        if (method === 'sendMessage' || method === 'sendDocument') {
          call.messageId = telegram.nextMessageId++;
          return {
            ok: true,
            result: {
              message_id: call.messageId,
              date: 1,
              chat: { id: Number(call.payload.chat_id), type: 'private' },
              text: call.payload.text,
            },
          } as never;
        }
        if (method === 'getChat') {
          return {
            ok: true,
            result: { id: Number(call.payload.chat_id), type: 'private' },
          } as never;
        }
        if (method === 'createForumTopic') {
          return { ok: true, result: { message_thread_id: 77, name: 'Test' } } as never;
        }
        return { ok: true, result: true } as never;
      });
    }

    override async start(options: Parameters<Grammy.Bot['start']>[0] = {}): Promise<void> {
      await options.onStart?.(botInfo);
    }

    override async stop(): Promise<void> {}
  }

  return { ...actual, Bot: FakePollingBot };
});

const OWNER_ID = 123;
const DISABLED_SERVICES = [
  'maintenance-runner',
  'briefing-formatter',
  'imap-watcher',
  'reply-composer',
  'email-triage',
  'action-extractor',
  'transaction-sync',
  'voice-transcriber',
  'email-watcher',
  'drive-watcher',
  'engagement-tracker',
  'snooze-suggester',
  'media-router',
  'data-collector',
  'insight-processor',
  'cross-domain-detector',
  'autonomous-manager',
  'ticktick-sync',
  'intent-matcher',
].join(',');

function privateTextUpdate(params: {
  updateId: number;
  messageId: number;
  text: string;
  senderId?: number;
  replyToMessageId?: number;
}): Update {
  return {
    update_id: params.updateId,
    message: {
      message_id: params.messageId,
      date: params.updateId,
      chat: { id: OWNER_ID, type: 'private', first_name: 'Owner' },
      from: {
        id: params.senderId ?? OWNER_ID,
        is_bot: false,
        first_name: params.senderId === undefined ? 'Owner' : 'Other',
      },
      text: params.text,
      ...(params.replyToMessageId === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: params.replyToMessageId,
              date: params.updateId - 1,
              chat: { id: OWNER_ID, type: 'private', first_name: 'Owner' },
              reply_to_message: undefined,
            },
          }),
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('Timed out waiting for Telegram roundtrip');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sentMessageContaining(text: string): TelegramApiCall | undefined {
  return telegram.calls.find(
    (call) => call.method === 'sendMessage' && String(call.payload.text).includes(text),
  );
}

describe('e2e: Telegram roundtrip over the real composition root', () => {
  const originalEnv = new Map<string, string | undefined>();
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  function setTestEnv(): void {
    for (const name of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'TELEGRAM_GROUP_ID',
      'RAVEN_DISABLED_SERVICES',
    ]) {
      if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
    }
    process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
    process.env.TELEGRAM_CHAT_ID = String(OWNER_ID);
    delete process.env.TELEGRAM_GROUP_ID;
    process.env.RAVEN_DISABLED_SERVICES = DISABLED_SERVICES;
  }

  function restoreEnv(): void {
    for (const [name, value] of originalEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    originalEnv.clear();
  }

  afterEach(async () => {
    if (raven) await raven.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
    telegram.bot = undefined;
    telegram.calls.length = 0;
    telegram.nextMessageId = 500;
    restoreEnv();
  });

  it('creates Inbox, persists delivery, starts /new, and resumes an older reply after restart', async () => {
    const backendCalls: BackendOptions[] = [];
    const backend: AgentBackend = async (options) => {
      backendCalls.push(options);
      const sdkSessionId =
        options.resume ?? (backendCalls.length === 1 ? 'sdk-original' : 'sdk-new');
      options.onSessionId?.(sdkSessionId);
      const result = `Telegram result ${String(backendCalls.length)}`;
      options.onAssistantMessage(result);
      return { sessionId: sdkSessionId, result, success: true, errors: [] };
    };

    setTestEnv();
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-telegram-'));
    const fixture = createRavenTestFixture(root);
    raven = await createRaven(buildTestConfig(), { ...fixture, agentBackend: backend });
    expect(telegram.bot).toBeDefined();

    await telegram.bot!.handleUpdate(
      privateTextUpdate({ updateId: 1, messageId: 100, text: 'Create my clean Inbox' }),
    );
    await waitFor(
      () => backendCalls.length === 1 && sentMessageContaining('Telegram result 1') !== undefined,
    );

    const firstReply = sentMessageContaining('Telegram result 1');
    expect(firstReply?.messageId).toBeDefined();
    expect(backendCalls[0].resume).toBeUndefined();
    expect(backendCalls[0].prompt).toContain('Create my clean Inbox');

    const inbox = raven.db.get<{ id: string; name: string; fs_path: string }>(
      'SELECT id, name, fs_path FROM projects WHERE id = ?',
      'telegram-default',
    );
    expect(inbox).toMatchObject({ id: 'telegram-default', name: 'Inbox / Today' });
    expect(existsSync(join(fixture.projectsDir, inbox!.fs_path, 'context.md'))).toBe(true);
    expect(existsSync(join(fixture.projectsDir, inbox!.fs_path, 'project.yaml'))).toBe(true);

    const firstIncoming = raven.db.get<{
      project_id: string;
      session_id: string;
      request_id: string;
      direction: string;
    }>(
      `SELECT project_id, session_id, request_id, direction
       FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?`,
      String(OWNER_ID),
      100,
    );
    expect(firstIncoming).toMatchObject({
      project_id: 'telegram-default',
      session_id: expect.any(String),
      request_id: expect.any(String),
      direction: 'incoming',
    });
    const originalSessionId = firstIncoming!.session_id;

    const firstDelivery = raven.db.get<{
      status: string;
      delivered_at: string | null;
      provider_message_id: string | null;
      reply_chat_id: string;
      reply_message_id: number;
      reply_session_id: string;
      reply_task_id: string;
    }>(
      `SELECT status, delivered_at, provider_message_id, reply_chat_id, reply_message_id,
              reply_session_id, reply_task_id
       FROM notification_queue WHERE source = 'telegram-chat-result'
       ORDER BY created_at ASC LIMIT 1`,
    );
    expect(firstDelivery).toMatchObject({
      status: 'delivered',
      delivered_at: expect.any(String),
      provider_message_id: String(firstReply!.messageId),
      reply_chat_id: String(OWNER_ID),
      reply_message_id: 100,
      reply_session_id: originalSessionId,
      reply_task_id: expect.any(String),
    });
    expect(
      raven.db.get(
        `SELECT outcome FROM notification_delivery_attempts
         WHERE notification_id = (
           SELECT id FROM notification_queue WHERE source = 'telegram-chat-result'
           ORDER BY created_at ASC LIMIT 1
         )`,
      ),
    ).toEqual({ outcome: 'accepted' });
    expect(
      raven.db.get(
        `SELECT project_id, session_id, direction FROM telegram_message_bindings
         WHERE chat_id = ? AND message_id = ?`,
        String(OWNER_ID),
        firstReply!.messageId,
      ),
    ).toEqual({
      project_id: 'telegram-default',
      session_id: originalSessionId,
      direction: 'outgoing',
    });

    await telegram.bot!.handleUpdate(
      privateTextUpdate({ updateId: 2, messageId: 101, text: '/new' }),
    );
    const conversation = raven.db.get<{ project_id: string; session_id: string }>(
      'SELECT project_id, session_id FROM telegram_conversations WHERE chat_id = ? AND topic_id = 0',
      String(OWNER_ID),
    );
    expect(conversation?.project_id).toBe('telegram-default');
    expect(conversation?.session_id).not.toBe(originalSessionId);
    const newSessionId = conversation!.session_id;

    await telegram.bot!.handleUpdate(
      privateTextUpdate({ updateId: 3, messageId: 102, text: 'Use the new conversation' }),
    );
    await waitFor(
      () => backendCalls.length === 2 && sentMessageContaining('Telegram result 2') !== undefined,
    );
    expect(backendCalls[1].resume).toBeUndefined();
    expect(
      raven.db.get(
        'SELECT session_id FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?',
        String(OWNER_ID),
        102,
      ),
    ).toEqual({ session_id: newSessionId });

    await raven.stop();
    raven = undefined;
    telegram.bot = undefined;

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(root),
      agentBackend: backend,
    });
    expect(telegram.bot).toBeDefined();

    await telegram.bot!.handleUpdate(
      privateTextUpdate({
        updateId: 4,
        messageId: 103,
        text: 'Continue the older conversation',
        replyToMessageId: firstReply!.messageId,
      }),
    );
    await waitFor(
      () => backendCalls.length === 3 && sentMessageContaining('Telegram result 3') !== undefined,
    );
    expect(backendCalls[2].resume).toBe('sdk-original');
    expect(
      raven.db.get(
        'SELECT session_id FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?',
        String(OWNER_ID),
        103,
      ),
    ).toEqual({ session_id: originalSessionId });

    await telegram.bot!.handleUpdate(
      privateTextUpdate({
        updateId: 5,
        messageId: 104,
        text: 'This sender must be ignored',
        senderId: 999,
      }),
    );
    expect(backendCalls).toHaveLength(3);
    expect(
      raven.db.get(
        'SELECT 1 AS present FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?',
        String(OWNER_ID),
        104,
      ),
    ).toBeUndefined();
  }, 30_000);

  it('delivers a manual retrospective to its Telegram session and clears processing status', async () => {
    const backendCalls: BackendOptions[] = [];
    const backend: AgentBackend = async (options) => {
      backendCalls.push(options);
      if (options.prompt.includes('session retrospective agent')) {
        return {
          result: JSON.stringify({
            summary: 'Retrospective reached its originating Telegram conversation.',
            decisions: ['Keep the original conversation association'],
            findings: [],
            actionItems: [],
            candidateBubbles: [],
            memoryCandidates: [],
          }),
          success: true,
          errors: [],
        };
      }
      options.onSessionId?.('sdk-retrospective-origin');
      options.onAssistantMessage('Initial Telegram conversation established');
      return {
        sessionId: 'sdk-retrospective-origin',
        result: 'Initial Telegram conversation established',
        success: true,
        errors: [],
      };
    };

    setTestEnv();
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-telegram-retro-'));
    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(root),
      agentBackend: backend,
    });

    await telegram.bot!.handleUpdate(
      privateTextUpdate({ updateId: 20, messageId: 200, text: 'Establish this conversation' }),
    );
    await waitFor(
      () => sentMessageContaining('Initial Telegram conversation established') !== undefined,
    );
    const session = raven.db.get<{ session_id: string }>(
      'SELECT session_id FROM telegram_conversations WHERE chat_id = ? AND topic_id = 0',
      String(OWNER_ID),
    );
    expect(session?.session_id).toEqual(expect.any(String));

    const callsBeforeRetrospective = telegram.calls.length;
    await telegram.bot!.handleUpdate(
      privateTextUpdate({ updateId: 21, messageId: 201, text: 'run retrospective' }),
    );
    const processing = telegram.calls
      .slice(callsBeforeRetrospective)
      .find((call) => call.method === 'sendMessage' && call.payload.text === 'Processing...');
    expect(processing?.messageId).toBeDefined();

    await waitFor(
      () =>
        sentMessageContaining('Retrospective reached its originating Telegram conversation') !==
        undefined,
    );
    expect(backendCalls.some((call) => call.prompt.includes('session retrospective agent'))).toBe(
      true,
    );
    expect(
      raven.db.get('SELECT status, summary FROM sessions WHERE id = ?', session!.session_id),
    ).toEqual({
      status: 'idle',
      summary: 'Retrospective reached its originating Telegram conversation.',
    });
    expect(
      raven.db.get(
        `SELECT status, reply_chat_id, reply_message_id, reply_session_id
         FROM notification_queue WHERE reply_message_id = ?`,
        201,
      ),
    ).toEqual({
      status: 'delivered',
      reply_chat_id: String(OWNER_ID),
      reply_message_id: 201,
      reply_session_id: session!.session_id,
    });
    expect(
      telegram.calls.some(
        (call) =>
          call.method === 'deleteMessage' && call.payload.message_id === processing!.messageId,
      ),
    ).toBe(true);
  }, 30_000);
});
