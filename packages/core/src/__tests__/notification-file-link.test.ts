import { describe, expect, it } from 'vitest';
import { notificationFileUrl } from '../services/notifications/file-link.ts';

describe('configured notification file links', () => {
  it('encodes only paths within the existing files root', () => {
    expect(
      notificationFileUrl('data/files/reports/a #1.pdf', '/tmp/raven', 'https://raven.test'),
    ).toBe('https://raven.test/api/files/reports/a%20%231.pdf');
    expect(
      notificationFileUrl('/tmp/raven/data/files/a.pdf', '/tmp/raven', 'https://raven.test'),
    ).toBe('https://raven.test/api/files/a.pdf');
  });
  it('omits unconfigured, malformed and arbitrary repository URLs', () => {
    expect(notificationFileUrl('data/files/a.pdf', '/tmp/raven')).toBeUndefined();
    expect(
      notificationFileUrl('data/files/a.pdf', '/tmp/raven', 'https://user:pass@raven.test'),
    ).toBeUndefined();
    expect(
      notificationFileUrl('../private.txt', '/tmp/raven', 'https://raven.test'),
    ).toBeUndefined();
    expect(
      notificationFileUrl('/workspace/dissertation/result.pdf', '/tmp/raven', 'https://raven.test'),
    ).toBeUndefined();
  });
});
