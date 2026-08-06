'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat, type ChatMessage } from '@/hooks/useChat';
import { Markdown } from '@/components/ui/Markdown';

export function ChatPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId?: string | null;
}) {
  const { messages, sendMessage, loading, activeTaskId, stopTask, statusLine } = useChat({
    projectId,
    sessionId,
  });
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    sendMessage(text);
    setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
            <p className="text-sm">Loading history...</p>
          </div>
        )}
        {!loading && messages.length === 0 && <EmptyState />}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
      {statusLine && <StatusLine text={statusLine} />}
      <ChatInput
        input={input}
        setInput={setInput}
        onSend={handleSend}
        activeTaskId={activeTaskId}
        stopTask={stopTask}
      />
    </div>
  );
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
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  activeTaskId: string | null;
  stopTask: () => void;
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
        {activeTaskId ? (
          <button
            onClick={stopTask}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: '#ef4444', color: 'white' }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={onSend}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Send
          </button>
        )}
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

function ContentBubble({ message }: { message: ChatMessage }) {
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
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'action') return null;
  if (message.role === 'thinking') return <ThinkingBubble content={message.content} />;

  return <ContentBubble message={message} />;
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
