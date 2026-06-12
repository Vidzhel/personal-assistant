import { describe, it, expect } from 'vitest';
import { statusBadgeProps, sourceBadgeProps } from '@/components/ui/badge-helpers';

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
