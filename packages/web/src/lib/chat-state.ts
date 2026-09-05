import type { WsMessage } from '@/lib/ws-client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'thinking';
  content: string;
  timestamp: number;
  taskId?: string;
  requestId?: string;
  delivery?: 'pending' | 'failed' | 'uncertain';
}

export interface ChatState {
  key: string;
  projectId: string;
  sessionId: string | null;
  messages: ChatMessage[];
  loading: boolean;
  activeTaskId: string | null;
  completedTaskId: string | null;
  stopPending: boolean;
  statusLine: string | null;
  error: string | null;
  taskRevision: number;
}

interface ChatEvent {
  type: string;
  projectId?: string;
  payload: {
    projectId?: string;
    sessionId?: string;
    requestId?: string;
    taskId?: string;
    messageId?: string;
    content?: string;
    messageType?: string;
    error?: string;
    errors?: string[];
    success?: boolean;
    cancelled?: boolean;
  };
}

export function createChatState(
  scope: Pick<ChatState, 'key' | 'projectId' | 'sessionId'>,
): ChatState {
  return {
    ...scope,
    messages: [],
    loading: true,
    activeTaskId: null,
    completedTaskId: null,
    stopPending: false,
    statusLine: null,
    error: null,
    taskRevision: 0,
  };
}

function rejectMessage(state: ChatState, payload: ChatEvent['payload']): ChatState {
  if (
    !payload.requestId ||
    !state.messages.some(
      (message) => message.requestId === payload.requestId && Boolean(message.delivery),
    )
  )
    return state;
  return {
    ...state,
    error: payload.error ?? 'Message was not accepted.',
    messages: state.messages.map((message) =>
      message.requestId === payload.requestId ? { ...message, delivery: 'failed' } : message,
    ),
  };
}

function acceptMessage(state: ChatState, payload: ChatEvent['payload']): ChatState {
  if (!payload.requestId) return state;
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.requestId === payload.requestId
        ? { ...message, id: payload.messageId ?? message.id, delivery: undefined }
        : message,
    ),
  };
}

function appendAgentMessage(state: ChatState, payload: ChatEvent['payload']): ChatState {
  if (!payload.content || !payload.taskId) return state;
  const running = { ...state, activeTaskId: payload.taskId, taskRevision: state.taskRevision + 1 };
  if (payload.messageType === 'tool_use')
    return { ...running, statusLine: `Using ${payload.content.split(':')[0]}...` };
  if (!['assistant', 'thinking'].includes(payload.messageType ?? '')) return state;
  if (payload.messageId && state.messages.some((message) => message.id === payload.messageId))
    return running;
  const message: ChatMessage = {
    id: payload.messageId ?? crypto.randomUUID(),
    taskId: payload.taskId,
    role: payload.messageType === 'thinking' ? 'thinking' : 'assistant',
    content: payload.content,
    timestamp: Date.now(),
  };
  return { ...running, statusLine: 'Responding...', messages: [...state.messages, message] };
}

function completeTask(state: ChatState, payload: ChatEvent['payload']): ChatState {
  if (state.activeTaskId && state.activeTaskId !== payload.taskId) return state;
  return {
    ...state,
    activeTaskId: null,
    completedTaskId: payload.taskId ?? state.completedTaskId,
    stopPending: false,
    taskRevision: state.taskRevision + 1,
    statusLine: payload.cancelled ? 'Stopped.' : null,
    error:
      payload.success || payload.cancelled
        ? state.error
        : payload.errors?.join('; ') || 'The task failed.',
  };
}

function requestTask(state: ChatState, payload: ChatEvent['payload']): ChatState {
  if (!payload.taskId) return state;
  return {
    ...state,
    activeTaskId: payload.taskId,
    stopPending: state.activeTaskId === payload.taskId && state.stopPending,
    taskRevision: state.taskRevision + 1,
    statusLine: 'Waiting for Raven...',
  };
}

function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  const payload = event.payload;
  if (
    (event.projectId ?? payload.projectId) !== state.projectId ||
    payload.sessionId !== state.sessionId
  )
    return state;
  switch (event.type) {
    case 'user:chat:rejected':
      return rejectMessage(state, payload);
    case 'user:chat:accepted':
      return acceptMessage(state, payload);
    case 'agent:message':
      return appendAgentMessage(state, payload);
    case 'agent:task:complete':
      return completeTask(state, payload);
    case 'agent:task:request':
      return requestTask(state, payload);
    default:
      return state;
  }
}

export function applyChatSocketMessage(state: ChatState, message: WsMessage): ChatState {
  if (!message.data || typeof message.data !== 'object') return state;
  if (message.type === 'chat:error') {
    const payload = message.data as ChatEvent['payload'];
    if (
      (payload.projectId !== undefined && payload.projectId !== state.projectId) ||
      (payload.sessionId !== undefined && payload.sessionId !== state.sessionId)
    )
      return state;
    return rejectMessage(state, payload);
  }
  if (message.type !== 'event') return state;
  const event = message.data as ChatEvent;
  return event.payload ? applyEvent(state, event) : state;
}

export type ChatAction =
  | { type: 'reset'; state: ChatState }
  | { type: 'patch'; key: string; patch: Partial<ChatState> }
  | {
      type: 'history';
      key: string;
      messages: ChatMessage[];
      activeTaskId: string | null;
      revision?: number;
    }
  | { type: 'send'; key: string; message: ChatMessage }
  | { type: 'socket'; key: string; message: WsMessage }
  | { type: 'stop-error'; key: string; taskId: string; error: string }
  | { type: 'disconnect'; key: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'reset') return action.state;
  if (action.key !== state.key) return state;
  switch (action.type) {
    case 'patch':
      return { ...state, ...action.patch };
    case 'send':
      return { ...state, error: null, messages: [...state.messages, action.message] };
    case 'socket':
      return applyChatSocketMessage(state, action.message);
    case 'stop-error':
      return state.activeTaskId === action.taskId
        ? { ...state, stopPending: false, statusLine: null, error: action.error }
        : state;
    case 'history':
      return mergeHistory(state, action);
    case 'disconnect':
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.delivery === 'pending' ? { ...message, delivery: 'uncertain' } : message,
        ),
      };
  }
}

function mergeHistory(
  state: ChatState,
  action: Extract<ChatAction, { type: 'history' }>,
): ChatState {
  const history = action.messages.filter((message) =>
    ['user', 'assistant', 'thinking'].includes(message.role),
  );
  const ids = new Set(history.map((message) => message.id));
  const activeTaskId =
    state.taskRevision === (action.revision ?? 0) ? action.activeTaskId : state.activeTaskId;
  return {
    ...state,
    loading: false,
    messages: [...history, ...state.messages.filter((message) => !ids.has(message.id))],
    activeTaskId,
    stopPending: activeTaskId ? state.stopPending : false,
    statusLine: activeTaskId ? state.statusLine : null,
  };
}
