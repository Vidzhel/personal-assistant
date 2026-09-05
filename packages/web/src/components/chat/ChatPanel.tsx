'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat, type ChatMessage } from '@/hooks/useChat';
import { Markdown } from '@/components/ui/Markdown';

export function ChatPanel({
  projectId,
  sessionId,
  messagePrefix,
  onTaskComplete,
}: {
  projectId: string;
  sessionId?: string | null;
  messagePrefix?: string;
  onTaskComplete?: () => void;
}) {
  const chat = useChat({ projectId, sessionId });
  useChatCompletion(chat, onTaskComplete);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = drafts[chat.key] ?? '';
  const setInput = (value: string | ((previous: string) => string)) =>
    setDrafts((previous) => ({
      ...previous,
      [chat.key]: typeof value === 'function' ? value(previous[chat.key] ?? '') : value,
    }));
  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    if (chat.sendMessage(text, messagePrefix)) setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      <ChatTranscript
        chat={chat}
        onRestore={(content) => setInput((draft) => (draft ? `${draft}\n${content}` : content))}
      />
      <ChatStatus chat={chat} />
      <ChatInput
        input={input}
        setInput={setInput}
        onSend={handleSend}
        activeTaskId={chat.activeTaskId}
        stopTask={chat.stopTask}
        stopPending={chat.stopPending}
        sendDisabled={
          chat.loading || chat.messages.some((message) => message.delivery === 'pending')
        }
      />
    </div>
  );
}

function useChatCompletion(chat: ReturnType<typeof useChat>, onComplete?: () => void): void {
  const observed = useRef<string | null>(null);
  useEffect(() => {
    if (!chat.completedTaskId) return;
    const completion = JSON.stringify([chat.key, chat.completedTaskId]);
    if (completion === observed.current) return;
    observed.current = completion;
    onComplete?.();
  }, [chat.key, chat.completedTaskId, onComplete]);
}

function EmptyState() {
  return (
    <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
      <p className="text-lg">Start a conversation</p>
      <p className="text-sm mt-1">Ask Raven to manage tasks, check email, or plan your day.</p>
    </div>
  );
}

function ChatInput({
  input,
  setInput,
  onSend,
  activeTaskId,
  stopTask,
  stopPending,
  sendDisabled,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  activeTaskId: string | null;
  stopTask: () => void;
  stopPending: boolean;
  sendDisabled: boolean;
}) {
  return (
    <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && onSend()}
          placeholder="Ask Raven..."
          className="flex-1 px-4 py-2 rounded-lg text-sm outline-none"
          style={{
            background: 'var(--bg-hover)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
          }}
        />
        <ChatButtons
          activeTaskId={activeTaskId}
          stopTask={stopTask}
          stopPending={stopPending}
          sendDisabled={sendDisabled}
          onSend={onSend}
        />
      </div>
    </div>
  );
}

function ThinkingBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] px-3 py-1.5 rounded-lg text-xs italic"
        style={{ color: 'var(--text-muted)' }}
      >
        {content}
      </div>
    </div>
  );
}

function ContentBubble({ message, onRestore }: { message: ChatMessage; onRestore: () => void }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-4 py-2 rounded-lg text-sm${isUser ? ' whitespace-pre-wrap' : ''}`}
        style={{
          background: isUser ? 'var(--accent)' : 'var(--bg-card)',
          color: 'var(--text)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {isUser ? message.content : <Markdown content={message.content} />}
        {message.delivery && (
          <div className="text-xs mt-2" role="status">
            {message.delivery === 'pending'
              ? 'Sending...'
              : message.delivery === 'failed'
                ? 'Not sent.'
                : 'Delivery not confirmed. Check history before resending.'}
            {message.delivery !== 'pending' && (
              <button onClick={onRestore} className="underline ml-2">
                Restore draft
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message, onRestore }: { message: ChatMessage; onRestore: () => void }) {
  if (message.role === 'action') return null;
  if (message.role === 'thinking') return <ThinkingBubble content={message.content} />;

  return <ContentBubble message={message} onRestore={onRestore} />;
}

function StatusLine({ text }: { text: string }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-1.5 text-xs truncate"
      style={{ color: 'var(--text-muted)' }}
    >
      <span
        className="inline-block w-8 h-1 rounded-full"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 2s ease-in-out infinite',
        }}
      />
      <span className="truncate">{text}</span>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
    </div>
  );
}

function ChatStatus({ chat }: { chat: ReturnType<typeof useChat> }) {
  const { statusLine, error, connection } = chat;
  return (
    <>
      {statusLine && <StatusLine text={statusLine} />}
      {connection !== 'connected' && (
        <p role="status" className="px-4 py-2 text-xs">
          {connection === 'connecting' ? 'Connecting...' : 'Disconnected. Reconnecting...'}
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 py-2 text-sm" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
    </>
  );
}

function ChatButtons({
  activeTaskId,
  stopTask,
  stopPending,
  sendDisabled,
  onSend,
}: {
  activeTaskId: string | null;
  stopTask: () => void;
  stopPending: boolean;
  sendDisabled: boolean;
  onSend: () => void;
}) {
  return (
    <>
      {activeTaskId ? (
        <button
          onClick={stopTask}
          disabled={stopPending}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: '#ef4444', color: 'white' }}
        >
          {stopPending ? 'Stopping...' : 'Stop'}
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={sendDisabled}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Send
        </button>
      )}
    </>
  );
}

function ChatTranscript({
  chat,
  onRestore,
}: {
  chat: ReturnType<typeof useChat>;
  onRestore: (content: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {chat.loading && (
        <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
          <p className="text-sm">Loading history...</p>
        </div>
      )}
      {!chat.loading && chat.messages.length === 0 && <EmptyState />}
      {chat.messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onRestore={() => onRestore(msg.content)} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
