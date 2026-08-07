import { describe, it, expect } from 'vitest';
import { formatApprovalAge } from '@/components/approvals/approval-helpers';

const FIXED_NOW = new Date('2026-08-07T12:00:00.000Z').getTime();

describe('formatApprovalAge', () => {
  it('shows "just now" for sub-minute ages', () => {
    const requestedAt = new Date(FIXED_NOW - 30 * 1000).toISOString();
    expect(formatApprovalAge(requestedAt, FIXED_NOW)).toBe('just now');
  });

  it('shows minutes for sub-hour ages', () => {
    const requestedAt = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
    expect(formatApprovalAge(requestedAt, FIXED_NOW)).toBe('5m ago');
  });

  it('shows hours for sub-day ages', () => {
    const requestedAt = new Date(FIXED_NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(formatApprovalAge(requestedAt, FIXED_NOW)).toBe('3h ago');
  });

  it('shows days for multi-day ages', () => {
    const requestedAt = new Date(FIXED_NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatApprovalAge(requestedAt, FIXED_NOW)).toBe('2d ago');
  });

  it('clamps negative ages (clock skew) to "just now"', () => {
    const requestedAt = new Date(FIXED_NOW + 60 * 1000).toISOString();
    expect(formatApprovalAge(requestedAt, FIXED_NOW)).toBe('just now');
  });
});
