'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChat, type ChatMessage } from '@/hooks/useChat';
import { PipelinePreview } from './PipelinePreview';

const PIPELINE_KEYS = ['name:', 'trigger:', 'nodes:', 'connections:'];
const MIN_PIPELINE_KEYS = 3;

interface YamlSplit {
  before: string;
  yaml: string;
  after: string;
}

function splitPipelineYaml(content: string): YamlSplit | null {
  const match = /```ya?ml\n([\s\S]*?)```/.exec(content);
  if (!match) return null;
  const yaml = match[1].trim();
  const matchedKeys = PIPELINE_KEYS.filter((k) => yaml.includes(k));
  if (matchedKeys.length < MIN_PIPELINE_KEYS) return null;
  return {
    before: content.slice(0, match.index).trim(),
    yaml,
    after: content.slice(match.index + match[0].length).trim(),
  };
}

// eslint-disable-next-line max-lines-per-function -- chat panel with message list, input, and controls
export function ChatPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId?: string | null;
}) {
  const { messages, sendMessage, loading, activeTaskId, stopTask } = useChat({
    projectId,
    sessionId,
  });
  const [input, setInput] = useState('');
  const [dismissedYaml, setDismissedYaml] = useState<Set<string>>(new Set());
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

  const handleDismissYaml = useCallback((msgId: string) => {
    setDismissedYaml((prev) => new Set(prev).add(msgId));
  }, []);

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
          <MessageBubble
            key={msg.id}
            message={msg}
            dismissed={dismissedYaml.has(msg.id)}
            onDismissYaml={() => handleDismissYaml(msg.id)}
          />
        ))}
        <div ref={bottomRef} />
      </div>
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

function MarkdownBlock({ content }: { content: string }) {
  return (
    <div
      className="max-w-[80%] px-4 py-2 rounded-lg text-sm markdown-content"
      style={{
        background: 'var(--bg-card)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function PipelineYamlBubble({ split, onDismiss }: { split: YamlSplit; onDismiss: () => void }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] w-full space-y-2">
        {split.before && <MarkdownBlock content={split.before} />}
        <PipelinePreview yaml={split.yaml} onDismiss={onDismiss} />
        {split.after && <MarkdownBlock content={split.after} />}
      </div>
    </div>
  );
}

function ContentBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-4 py-2 rounded-lg text-sm${isUser ? ' whitespace-pre-wrap' : ' markdown-content'}`}
        style={{
          background: isUser ? 'var(--accent)' : 'var(--bg-card)',
          color: 'var(--text)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        )}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  dismissed,
  onDismissYaml,
}: {
  message: ChatMessage;
  dismissed: boolean;
  onDismissYaml: () => void;
}) {
  if (message.role === 'action') return <ActionBubble message={message} />;
  if (message.role === 'thinking') return <ThinkingBubble content={message.content} />;

  const isUser = message.role === 'user';
  const split = !isUser && !dismissed ? splitPipelineYaml(message.content) : null;

  if (split) return <PipelineYamlBubble split={split} onDismiss={onDismissYaml} />;
  return <ContentBubble message={message} />;
}

function ActionBubble({ message }: { message: ChatMessage }) {
  const toolName = message.toolName ?? 'Tool';
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5"
        style={{
          background: 'var(--bg-hover)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: '0.7rem' }}>&#9881;</span>
        <span className="font-medium">{toolName}</span>
        {message.toolSummary && (
          <span className="truncate" style={{ maxWidth: '300px' }}>
            {message.toolSummary}
          </span>
        )}
      </div>
    </div>
  );
}
