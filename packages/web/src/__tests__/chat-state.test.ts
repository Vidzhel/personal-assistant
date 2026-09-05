import { describe, expect, it } from 'vitest';
import {
  applyChatSocketMessage,
  chatReducer,
  createChatState,
  type ChatState,
} from '@/lib/chat-state';

function state(): ChatState {
  return {
    ...createChatState({ key: 'project/session-a', projectId: 'project', sessionId: 'session-a' }),
    loading: false,
    messages: [
      {
        id: 'request',
        requestId: 'request',
        role: 'user',
        content: 'Keep my draft',
        timestamp: 1,
        delivery: 'pending',
      },
    ],
  };
}
function event(type: string, payload: object, sessionId = 'session-a', projectId = 'project') {
  return { type: 'event', data: { type, projectId, payload: { sessionId, ...payload } } };
}

describe('Active conversation state', () => {
  it('ignores another project/session stream and terminal events without clearing running/error state', () => {
    const active = {
      ...state(),
      activeTaskId: 'task-a',
      stopPending: true,
      statusLine: 'Stopping...',
      error: 'Keep this error',
    };
    for (const message of [
      event(
        'agent:message',
        { taskId: 'task-b', content: 'Other session', messageType: 'assistant' },
        'session-b',
      ),
      event('agent:task:complete', { taskId: 'task-b', success: true }, 'session-b'),
      event(
        'agent:task:complete',
        { taskId: 'task-a', success: true },
        'session-a',
        'another-project',
      ),
    ])
      expect(applyChatSocketMessage(active, message)).toBe(active);
  });

  it('marks only the matching request persisted, and later model failure does not restore its draft', () => {
    const accepted = applyChatSocketMessage(
      state(),
      event('user:chat:accepted', { requestId: 'request', messageId: 'persisted-user' }),
    );
    expect(accepted.messages[0].id).toBe('persisted-user');
    expect(accepted.messages[0].delivery).toBeUndefined();
    const running = applyChatSocketMessage(
      accepted,
      event('agent:task:request', { taskId: 'task' }),
    );
    const failed = applyChatSocketMessage(
      running,
      event('agent:task:complete', { taskId: 'task', success: false, errors: ['Model failed'] }),
    );
    expect(failed.error).toBe('Model failed');
    expect(failed.messages[0].delivery).toBeUndefined();
    expect(failed.activeTaskId).toBeNull();
  });

  it('preserves rejected text for draft recovery and ignores unrelated rejection IDs', () => {
    const initial = state();
    expect(
      applyChatSocketMessage(
        initial,
        event('user:chat:rejected', { requestId: 'other', error: 'No access' }),
      ),
    ).toBe(initial);
    const rejected = applyChatSocketMessage(
      initial,
      event('user:chat:rejected', { requestId: 'request', error: 'No access' }),
    );
    expect(rejected.error).toBe('No access');
    expect(rejected.messages[0]).toMatchObject({ content: 'Keep my draft', delivery: 'failed' });
    const direct = applyChatSocketMessage(initial, {
      type: 'chat:error',
      data: {
        projectId: 'project',
        sessionId: 'session-a',
        requestId: 'request',
        error: 'Session gone',
      },
    });
    expect(direct.error).toBe('Session gone');
    expect(direct.messages[0].delivery).toBe('failed');
    const malformed = applyChatSocketMessage(initial, {
      type: 'chat:error',
      data: { requestId: 'request', error: 'Invalid chat message' },
    });
    expect(malformed.messages[0]).toMatchObject({ content: 'Keep my draft', delivery: 'failed' });
    expect(
      applyChatSocketMessage(initial, {
        type: 'chat:error',
        data: { requestId: 'another-request', error: 'Invalid chat message' },
      }),
    ).toBe(initial);
  });

  it('rejects late history after a session switch and merges live messages without duplication', () => {
    const current = { ...state(), messages: [] };
    expect(
      chatReducer(current, {
        type: 'history',
        key: 'previous-project/session',
        messages: [],
        activeTaskId: 'old',
      }),
    ).toBe(current);
    const streamed = applyChatSocketMessage(
      current,
      event('agent:message', {
        taskId: 'task',
        messageId: 'answer',
        messageType: 'assistant',
        content: 'Current answer',
      }),
    );
    const merged = chatReducer(streamed, {
      type: 'history',
      key: current.key,
      messages: [...streamed.messages],
      activeTaskId: 'stale-task',
    });
    expect(merged.messages).toHaveLength(1);
    expect(merged.activeTaskId).toBe('task');
    const terminal = applyChatSocketMessage(
      streamed,
      event('agent:task:complete', { taskId: 'task', success: true }),
    );
    expect(
      chatReducer(terminal, {
        type: 'history',
        key: current.key,
        messages: [],
        activeTaskId: 'task',
      }).activeTaskId,
    ).toBeNull();
  });

  it('keeps stop pending until its own terminal event and ignores a late failed stop for an older task', () => {
    const running = { ...state(), activeTaskId: 'task', stopPending: true };
    const stopped = applyChatSocketMessage(
      running,
      event('agent:task:complete', { taskId: 'task', cancelled: true }),
    );
    expect(stopped).toMatchObject({
      activeTaskId: null,
      completedTaskId: 'task',
      stopPending: false,
      statusLine: 'Stopped.',
    });
    expect(
      chatReducer(stopped, {
        type: 'stop-error',
        key: stopped.key,
        taskId: 'task',
        error: 'Already completed',
      }),
    ).toBe(stopped);
  });

  it('reconciles a completion missed while disconnected, while newer live work wins over that fetch', () => {
    const interrupted = {
      ...state(),
      activeTaskId: 'missed-task',
      stopPending: true,
      statusLine: 'Stopping...',
      taskRevision: 7,
    };
    const history = {
      type: 'history' as const,
      key: interrupted.key,
      messages: [],
      activeTaskId: null,
      revision: interrupted.taskRevision,
    };
    expect(chatReducer(interrupted, history)).toMatchObject({
      activeTaskId: null,
      stopPending: false,
      statusLine: null,
    });
    const newer = applyChatSocketMessage(
      interrupted,
      event('agent:task:request', { taskId: 'newer-task' }),
    );
    expect(chatReducer(newer, history).activeTaskId).toBe('newer-task');
  });

  it('labels lost acknowledgements uncertain without claiming persisted messages are unsent', () => {
    const initial = state();
    initial.messages.push({ id: 'saved', role: 'user', content: 'Already saved', timestamp: 0 });
    const disconnected = chatReducer(initial, { type: 'disconnect', key: initial.key });
    expect(disconnected.messages[0].delivery).toBe('uncertain');
    expect(disconnected.messages[1].delivery).toBeUndefined();
    expect(applyChatSocketMessage(initial, event('user:chat:accepted', {}))).toBe(initial);
  });
});
