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

  it('releases admission without cancelling a running handler or removing its replacement', async () => {
    const registry = createJobRegistry();
    let complete!: () => void;
    const handler = async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { summary: 'admitted work completed' };
    };
    const release = registry.register('restarted', handler);
    const admitted = registry.get('restarted')!({ scheduleName: 'fixture', params: {} });
    release();
    expect(registry.get('restarted')).toBeUndefined();
    const replacement = registry.register('restarted', handler);
    release();
    expect(registry.get('restarted')).toBe(handler);
    complete();
    expect(await admitted).toEqual({ summary: 'admitted work completed' });
    replacement();
    expect(registry.list()).toEqual([]);
  });
});
