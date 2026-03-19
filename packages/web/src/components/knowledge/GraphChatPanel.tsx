'use client';

import { useState, useRef, useEffect } from 'react';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import { api } from '@/lib/api-client';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// eslint-disable-next-line max-lines-per-function -- chat UI with message list and input
export function GraphChatPanel({
  projectId,
  onRefetch,
}: {
  projectId: string | null;
  onRefetch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectedNodeIds = useKnowledgeStore((s) => s.selectedNodeIds);
  const nodes = useKnowledgeStore((s) => s.nodes);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || !projectId || sending) return;

    const selectedContext = selectedNodeIds
      .map((id) => nodes.find((n) => n.id === id)?.title)
      .filter(Boolean);

    const contextPrefix =
      selectedContext.length > 0
        ? `[Knowledge graph context — selected nodes: ${selectedContext.join(', ')}]\n\n`
        : '[Knowledge graph context]\n\n';

    const userMsg: ChatMessage = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      const response = (await api.sendChat(projectId, contextPrefix + input)) as {
        reply?: string;
      };
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.reply ?? 'Done.',
      };
      setMessages((prev) => [...prev, assistantMsg]);
      onRefetch();
    } finally {
      setSending(false);
    }
  }

  const detailOpen = selectedNodeIds.length === 1;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 px-3 py-2 rounded-lg shadow-lg text-xs z-10"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        Chat
      </button>
    );
  }

  return (
    <div
      className={`absolute top-0 z-20 w-80 h-full flex flex-col shadow-xl ${detailOpen ? 'right-80' : 'right-0'}`}
      style={{ background: 'var(--bg)' }}
    >
      <div
        className="flex items-center justify-between p-3 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>
          Knowledge Chat
        </span>
        <button
          onClick={() => setOpen(false)}
          className="text-xs px-2 py-0.5 rounded"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs p-2 rounded ${msg.role === 'user' ? 'ml-8' : 'mr-8'}`}
            style={{
              background: msg.role === 'user' ? 'var(--accent)' : 'var(--bg-card)',
              color: msg.role === 'user' ? '#fff' : 'var(--text)',
            }}
          >
            {msg.content}
          </div>
        ))}
        {sending && (
          <div
            className="text-xs p-2 rounded mr-8"
            style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
          >
            Thinking...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t" style={{ borderColor: 'var(--border)' }}>
        {selectedNodeIds.length > 0 && (
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            Context: {selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''} selected
          </div>
        )}
        <div className="flex gap-1">
          <input
            type="text"
            placeholder="Ask about knowledge..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            className="flex-1 text-xs px-2 py-1.5 rounded"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !projectId}
            className="px-2 py-1.5 text-xs rounded"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
