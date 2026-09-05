import { describe, it, expect } from 'vitest';
import { buildSystemHealthCard } from '@/components/dashboard/system-health-helpers';

describe('buildSystemHealthCard', () => {
  it('uses the real /api/health aggregate status when healthy and self-test has run and passed', () => {
    const card = buildSystemHealthCard('ok', {
      lastRun: '2026-08-01T00:00:00.000Z',
      ok: true,
      violations: [],
    });
    expect(card.value).toBe('ok');
    expect(card.color).toBe('var(--success)');
  });

  it('reflects /api/health degraded status even when self-test has not run', () => {
    const card = buildSystemHealthCard('degraded', undefined);
    expect(card.color).toBe('var(--error)');
    expect(card.value).toBe('degraded');
  });

  it('shows current definition degradation when self-test has never run', () => {
    const card = buildSystemHealthCard('degraded', { lastRun: null, ok: true, violations: [] });
    expect(card.value).toBe('degraded');
    expect(card.color).toBe('var(--error)');
  });

  it('shows a neutral "not yet run" state distinct from passed, not folded into healthy', () => {
    const card = buildSystemHealthCard('ok', { lastRun: null, ok: true, violations: [] });
    expect(card.value).toBe('not yet run');
    expect(card.color).toBe('var(--text-muted)');
    expect(card.color).not.toBe('var(--success)');
  });

  it('flags self-test violations in red with a count, regardless of overall status', () => {
    const card = buildSystemHealthCard('ok', {
      lastRun: '2026-08-01T00:00:00.000Z',
      ok: false,
      violations: ['stuck tree', 'failed schedule'],
    });
    expect(card.value).toBe('2 issue(s)');
    expect(card.color).toBe('var(--error)');
    expect(card.title).toContain('stuck tree');
    expect(card.title).toContain('failed schedule');
  });

  it('renders lastRun into the tooltip when self-test has run', () => {
    const card = buildSystemHealthCard('ok', {
      lastRun: '2026-08-01T00:00:00.000Z',
      ok: true,
      violations: [],
    });
    expect(card.title).toContain('2026-08-01T00:00:00.000Z');
  });

  it('shows a neutral "checking..." state when /api/health has not answered yet', () => {
    const card = buildSystemHealthCard(undefined, undefined);
    expect(card.value).toBe('checking...');
    expect(card.color).toBe('var(--text-muted)');
  });
});
