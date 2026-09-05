'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WsMessage } from '@/lib/ws-client';
import { consumeWsMessages } from '@/lib/ws-message-cursor';
import { api, type ActiveTasks } from '@/lib/api-client';
import { apiRequest } from '@/lib/api-request';
import { projectPath } from '@/lib/url-paths';
import {
  chatReducer,
  createChatState,
  type ChatMessage,
  type ChatState,
  type ChatAction,
} from '@/lib/chat-state';
export type { ChatMessage } from '@/lib/chat-state';

interface UseChatOptions {
  projectId: string;
  sessionId?: string | null;
}
type Dispatch = (action: ChatAction) => void;

async function loadConversation(
  scope: ChatState,
  signal: AbortSignal,
  dispatch: Dispatch,
): Promise<void> {
  try {
    const session = scope.sessionId
      ? { id: scope.sessionId }
      : await apiRequest<{ id: string }>(`${projectPath(scope.projectId)}/sessions`, {
          method: 'POST',
          signal,
        });
    if (signal.aborted) return;
    dispatch({ type: 'patch', key: scope.key, patch: { sessionId: session.id } });
    const [messages, active] = await Promise.all([
      apiRequest<ChatMessage[]>(`/sessions/${encodeURIComponent(session.id)}/messages`, { signal }),
      apiRequest<ActiveTasks>('/agent-tasks/active', { signal }),
    ]);
    if (signal.aborted) return;
    const task = [...active.running, ...active.queued].find(
      (item) => item.projectId === scope.projectId && item.sessionId === session.id,
    );
    dispatch({
      type: 'history',
      key: scope.key,
      messages,
      activeTaskId: task?.taskId ?? null,
      revision: scope.taskRevision,
    });
  } catch (cause) {
    if (!signal.aborted)
      dispatch({
        type: 'patch',
        key: scope.key,
        patch: {
          loading: false,
          error: cause instanceof Error ? cause.message : 'Could not load this conversation.',
        },
      });
  }
}

function useConversationSocket(scope: ChatState, messages: WsMessage[], dispatch: Dispatch): void {
  const cursor = useRef<WsMessage | undefined>(undefined);
  const previousKey = useRef(scope.key);
  useEffect(() => {
    if (previousKey.current !== scope.key) {
      previousKey.current = scope.key;
      cursor.current = messages.at(-1);
      return;
    }
    for (const message of consumeWsMessages(messages, cursor))
      dispatch({ type: 'socket', key: scope.key, message });
  }, [messages, scope.key, scope.sessionId, dispatch]);
}

function useSendChat(
  state: ChatState,
  dispatch: Dispatch,
  send: (message: unknown) => boolean,
): (message: string, prefix?: string) => boolean {
  const sendMessage = useCallback(
    (content: string, prefix = '') => {
      if (
        state.loading ||
        !state.sessionId ||
        state.activeTaskId ||
        state.messages.some((message) => message.delivery === 'pending')
      )
        return false;
      const requestId = crypto.randomUUID();
      if (
        !send({
          type: 'chat:send',
          projectId: state.projectId,
          sessionId: state.sessionId,
          message: prefix + content,
          requestId,
        })
      ) {
        dispatch({
          type: 'patch',
          key: state.key,
          patch: { error: 'Disconnected. Your message was not sent; the draft is still here.' },
        });
        return false;
      }
      dispatch({
        type: 'send',
        key: state.key,
        message: {
          id: requestId,
          requestId,
          role: 'user',
          content,
          timestamp: Date.now(),
          delivery: 'pending',
        },
      });
      return true;
    },
    [state, dispatch, send],
  );
  return sendMessage;
}

function useStopChat(state: ChatState, dispatch: Dispatch): () => Promise<void> {
  return useCallback(async () => {
    if (!state.activeTaskId || state.stopPending) return;
    dispatch({
      type: 'patch',
      key: state.key,
      patch: { stopPending: true, statusLine: 'Stopping...', error: null },
    });
    try {
      await api.cancelTask(state.activeTaskId);
      // Acceptance is not the terminal event; retain the task until completion arrives.
    } catch (cause) {
      dispatch({
        type: 'stop-error',
        key: state.key,
        taskId: state.activeTaskId,
        error: cause instanceof Error ? cause.message : 'Could not stop this task.',
      });
    }
  }, [state, dispatch]);
}

function useChatReconnection(state: ChatState, connection: string, dispatch: Dispatch): void {
  const current = useRef({ state, reconnect: false });
  if (current.current.state.key !== state.key) current.current.reconnect = false;
  current.current.state = state;
  useEffect(() => {
    if (connection === 'disconnected') {
      current.current.reconnect = true;
      dispatch({ type: 'disconnect', key: state.key });
    }
    if (connection !== 'connected' || !current.current.reconnect) return;
    current.current.reconnect = false;
    const controller = new AbortController();
    const snapshot = current.current.state;
    dispatch({ type: 'patch', key: snapshot.key, patch: { loading: true } });
    void loadConversation(snapshot, controller.signal, dispatch);
    return () => controller.abort();
  }, [connection, state.key, dispatch]);
}

export function useChat(opts: UseChatOptions): ChatState & {
  sendMessage: (message: string, prefix?: string) => boolean;
  stopTask: () => Promise<void>;
  connection: string;
} {
  const key = JSON.stringify([opts.projectId, opts.sessionId ?? null]);
  const scope = useMemo(
    () => createChatState({ key, projectId: opts.projectId, sessionId: opts.sessionId ?? null }),
    [key, opts.projectId, opts.sessionId],
  );
  const [stored, dispatch] = useReducer(chatReducer, scope);
  const drafts = useRef(new Map<string, ChatMessage[]>());
  useEffect(() => {
    drafts.current.set(
      stored.key,
      stored.messages.filter((message) => message.delivery),
    );
  }, [stored]);
  const state = stored.key === key ? stored : scope;
  const channels = useMemo(() => [`project:${opts.projectId}`], [opts.projectId]);
  const socket = useWebSocket(channels);
  useEffect(() => {
    const controller = new AbortController();
    const messages = (drafts.current.get(scope.key) ?? []).map((message) =>
      message.delivery === 'pending' ? { ...message, delivery: 'uncertain' as const } : message,
    );
    dispatch({ type: 'reset', state: { ...scope, messages } });
    void loadConversation(scope, controller.signal, dispatch);
    return () => controller.abort();
  }, [scope]);
  useConversationSocket(state, socket.messages, dispatch);
  useChatReconnection(state, socket.connection, dispatch);
  const sendMessage = useSendChat(state, dispatch, socket.send);
  const stopTask = useStopChat(state, dispatch);
  return { ...state, sendMessage, stopTask, connection: socket.connection };
}
