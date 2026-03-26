'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';

const COPY_FEEDBACK_MS = 1500;
const OPACITY_HALF = 0.5;

interface SendMessageModalProps {
  sessionId: string;
  onClose: () => void;
}

// eslint-disable-next-line max-lines-per-function -- modal with sent/unsent states, textarea, and action buttons
export function SendMessageModal({ sessionId, onClose }: SendMessageModalProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await api.enqueueMessage(sessionId, message);
      setSent(true);
      setTimeout(onClose, COPY_FEEDBACK_MS);
    } catch {
      /* handle error silently */
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="mt-2 p-3 rounded-lg border"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
    >
      {sent ? (
        <p className="text-xs text-center" style={{ color: 'var(--success)' }}>
          Message queued — will be processed after current task completes
        </p>
      ) : (
        <>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type a message to queue for this session..."
            className="w-full text-sm p-2 rounded border resize-none"
            style={{
              background: 'var(--bg-secondary)',
              borderColor: 'var(--border)',
              color: 'var(--text-primary)',
            }}
            rows={2}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1 rounded"
              style={{ color: 'var(--text-muted)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="text-xs px-3 py-1 rounded font-medium"
              style={{
                background: 'var(--accent)',
                color: 'white',
                opacity: sending || !message.trim() ? OPACITY_HALF : 1,
              }}
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
