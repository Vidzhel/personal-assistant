import { describe, it, expect, vi } from 'vitest';
import { createJobRegistry } from '../scheduler/job-registry.ts';

describe('JobRegistry', () => {
  it('registers, finds, lists, and runs handlers', async () => {
    const reg = createJobRegistry();
    const handler = vi.fn().mockResolvedValue({ summary: 'done' });
    reg.register('job-a', handler);

    expect(reg.has('job-a')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.list()).toEqual(['job-a']);

    const found = reg.get('job-a');
    expect(found).toBeDefined();
    const result = await found!({ scheduleName: 's', params: {} });
    expect(result.summary).toBe('done');
    expect(handler).toHaveBeenCalledWith({ scheduleName: 's', params: {} });
  });

  it('throws on duplicate registration', () => {
    const reg = createJobRegistry();
    reg.register('dup', async () => ({}));
    expect(() => reg.register('dup', async () => ({}))).toThrow(/already registered/);
  });

  it('returns undefined for unknown jobs', () => {
    expect(createJobRegistry().get('ghost')).toBeUndefined();
  });
});
