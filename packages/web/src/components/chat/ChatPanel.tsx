'use client';

import { useState, useRef, useEffect } from 'react';
import { useChat, type ChatMessage } from '@/hooks/useChat';

export function ChatPanel({ projectId }: { projectId: string }) {
  const { messages, sendMessage } = useChat(projectId);
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
        {messages.length === 0 && (
          <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
            <p className="text-lg">Start a conversation</p>
            <p className="text-sm mt-1">Ask Raven to manage tasks, check email, or plan your day.</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Ask Raven..."
            className="flex-1 px-4 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-hover)', color: 'var(--text)', border: '1px solid var(--border)' }}
          />
          <button
            onClick={handleSend}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[80%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap"
        style={{
          background: isUser ? 'var(--accent)' : 'var(--bg-card)',
          color: 'var(--text)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {message.content}
      </div>
    </div>
  );
}
