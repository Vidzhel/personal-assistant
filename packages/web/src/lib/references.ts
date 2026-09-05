import type { ExternalRef } from '@/components/session/ReferencesPanel';

const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

interface StoredMessage {
  role: string;
  content: string;
}

export function extractUrls(messages: StoredMessage[]): ExternalRef[] {
  const urls = new Map<string, ExternalRef>();
  for (const msg of messages.filter((m) => m.role === 'assistant')) {
    for (const match of msg.content.matchAll(MARKDOWN_LINK_REGEX)) {
      try {
        urls.set(match[2], { url: match[2], label: match[1], domain: new URL(match[2]).hostname });
      } catch {
        /* invalid URL */
      }
    }
    for (const match of msg.content.matchAll(URL_REGEX)) {
      if (!urls.has(match[0])) {
        try {
          urls.set(match[0], { url: match[0], label: null, domain: new URL(match[0]).hostname });
        } catch {
          /* invalid URL */
        }
      }
    }
  }
  return [...urls.values()];
}
