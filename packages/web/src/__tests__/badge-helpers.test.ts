import { describe, it, expect } from 'vitest';
import {
  statusBadgeProps,
  sourceBadgeProps,
  tierBadgeProps,
  tierRank,
} from '@/components/ui/badge-helpers';

describe('statusBadgeProps', () => {
  it('maps known statuses to a label + colors', () => {
    expect(statusBadgeProps('in_progress').label).toBe('In Progress');
    expect(statusBadgeProps('completed').label).toBe('Completed');
    expect(statusBadgeProps('failed').label).toBe('Failed');
  });

  it('treats waiting-approval and pending_approval the same', () => {
    expect(statusBadgeProps('waiting-approval').label).toBe('Needs Approval');
    expect(statusBadgeProps('pending_approval').label).toBe('Needs Approval');
  });

  it('falls back to the raw status with neutral colors', () => {
    const r = statusBadgeProps('totally-unknown');
    expect(r.label).toBe('totally-unknown');
    expect(r.bg).toBe('var(--bg-hover)');
    expect(r.fg).toBe('var(--text-muted)');
  });
});

describe('sourceBadgeProps', () => {
  it('labels known sources', () => {
    expect(sourceBadgeProps('manual').label).toBe('Manual');
    expect(sourceBadgeProps('scheduled').label).toBe('Scheduled');
    expect(sourceBadgeProps('plan').label).toBe('Plan');
    expect(sourceBadgeProps('pipeline').label).toBe('Pipeline');
  });

  it('falls back to the raw source with neutral colors', () => {
    const r = sourceBadgeProps('xyz');
    expect(r.label).toBe('xyz');
    expect(r.fg).toBe('var(--text-muted)');
  });
});

describe('tierBadgeProps', () => {
  it('maps known permission tiers to distinct colors', () => {
    expect(tierBadgeProps('green').label).toBe('green');
    expect(tierBadgeProps('yellow').label).toBe('yellow');
    expect(tierBadgeProps('red').label).toBe('red');
    expect(tierBadgeProps('green').fg).not.toBe(tierBadgeProps('red').fg);
  });

  it('falls back to the raw tier with neutral colors', () => {
    const r = tierBadgeProps('unknown-tier');
    expect(r.label).toBe('unknown-tier');
    expect(r.bg).toBe('var(--bg-hover)');
    expect(r.fg).toBe('var(--text-muted)');
  });
});

describe('tierRank', () => {
  it('orders red before yellow before green', () => {
    expect(tierRank('red')).toBeLessThan(tierRank('yellow'));
    expect(tierRank('yellow')).toBeLessThan(tierRank('green'));
  });

  it('sorts unknown tiers last', () => {
    expect(tierRank('made-up')).toBeGreaterThan(tierRank('green'));
  });

  it('sorts a catalog list red-first', () => {
    const catalog = [{ tier: 'green' }, { tier: 'red' }, { tier: 'yellow' }];
    const sorted = [...catalog].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
    expect(sorted.map((e) => e.tier)).toEqual(['red', 'yellow', 'green']);
  });
});
