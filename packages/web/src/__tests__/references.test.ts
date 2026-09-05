import { describe, it, expect } from 'vitest';

import { extractUrls } from '@/lib/references';

describe('URL extraction from assistant messages', () => {
  it('extracts plain URLs from assistant messages', () => {
    const messages = [
      { role: 'assistant', content: 'Check out https://docs.example.com/api for more info' },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe('https://docs.example.com/api');
    expect(refs[0].domain).toBe('docs.example.com');
    expect(refs[0].label).toBeNull();
  });

  it('extracts markdown links with labels', () => {
    const messages = [
      { role: 'assistant', content: 'See [API Docs](https://docs.example.com/api) for details' },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe('https://docs.example.com/api');
    expect(refs[0].label).toBe('API Docs');
    expect(refs[0].domain).toBe('docs.example.com');
  });

  it('deduplicates URLs', () => {
    const messages = [
      { role: 'assistant', content: 'Visit https://example.com and also https://example.com' },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(1);
  });

  it('prefers markdown link label over plain URL', () => {
    const messages = [
      {
        role: 'assistant',
        content:
          'See [My Link](https://example.com/path) and also https://example.com/path for info',
      },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBe('My Link');
  });

  it('ignores user messages', () => {
    const messages = [
      { role: 'user', content: 'Check https://user-link.com' },
      { role: 'assistant', content: 'Sure, here is the answer' },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(0);
  });

  it('handles multiple URLs across messages', () => {
    const messages = [
      { role: 'assistant', content: 'See https://a.com and https://b.com' },
      { role: 'assistant', content: 'Also https://c.com' },
    ];
    const refs = extractUrls(messages);
    expect(refs).toHaveLength(3);
    const domains = refs.map((r) => r.domain);
    expect(domains).toContain('a.com');
    expect(domains).toContain('b.com');
    expect(domains).toContain('c.com');
  });

  it('returns empty for no assistant messages', () => {
    expect(extractUrls([])).toHaveLength(0);
  });
});
