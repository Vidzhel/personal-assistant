export interface SelfTestStatus {
  lastRun: string | null;
  ok: boolean;
  violations: string[];
}

export interface SystemHealthCard {
  label: string;
  value: string;
  href: string;
  color: string;
  title: string | undefined;
}

/** Three distinct states rather than two: never run (neutral — it hasn't
 * told us anything yet), passed (healthy), or found violations (unhealthy)
 * — collapsing "never run" into "passed" is exactly the false-healthy
 * reading this exists to avoid. `systemHealthStatus` must be /api/health's
 * real aggregate status (not the dashboard-life endpoint's hardcoded 'ok')
 * so this card can never show healthy while /api/health itself reports
 * degraded/error. */
function resolveValueAndColor(
  systemHealthStatus: string | undefined,
  selfTest: SelfTestStatus | undefined,
): { value: string; color: string } {
  if (selfTest !== undefined && !selfTest.ok) {
    return { value: `${selfTest.violations.length} issue(s)`, color: 'var(--error)' };
  }
  if (selfTest !== undefined && selfTest.lastRun === null) {
    return { value: 'not yet run', color: 'var(--text-muted)' };
  }
  if (systemHealthStatus === undefined) {
    return { value: 'checking...', color: 'var(--text-muted)' };
  }
  return {
    value: systemHealthStatus,
    color: systemHealthStatus === 'ok' ? 'var(--success)' : 'var(--error)',
  };
}

/** Tooltip: when self-test ran, say when; otherwise say it hasn't; either
 * way list any violations found. undefined only when there's nothing to
 * say (no self-test data at all). */
function resolveTitle(selfTest: SelfTestStatus | undefined): string | undefined {
  if (selfTest === undefined) return undefined;
  const lines: string[] = [
    selfTest.lastRun ? `Self-test last ran: ${selfTest.lastRun}` : 'Self-test has not run yet',
  ];
  if (!selfTest.ok) lines.push(...selfTest.violations);
  return lines.join('\n');
}

/** Folds the self-test result into the "System Health" summary card. */
export function buildSystemHealthCard(
  systemHealthStatus: string | undefined,
  selfTest: SelfTestStatus | undefined,
): SystemHealthCard {
  return {
    label: 'System Health',
    href: '/settings',
    ...resolveValueAndColor(systemHealthStatus, selfTest),
    title: resolveTitle(selfTest),
  };
}
