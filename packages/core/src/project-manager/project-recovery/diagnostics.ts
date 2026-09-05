import { createLogger } from '@raven/shared';
import type { DefinitionDiagnostic } from '../../diagnostics/definition-diagnostics.ts';
import { readProjectRecoveryReport, recoverProjectMutation, type RecoveryDeps } from './journal.ts';

const log = createLogger('project-recovery');

export function readProjectRecoveryDiagnostics(projectsDir: string): DefinitionDiagnostic[] {
  try {
    return readProjectRecoveryReport(projectsDir).entries.map((entry) => ({
      source: 'mutation',
      path: entry.path,
      code: `project-mutation-${entry.state}`,
      severity: 'error',
      message: `Project ${entry.operation} ${entry.mutationId} requires recovery: ${entry.message}`,
    }));
  } catch (error) {
    return [
      {
        source: 'mutation',
        path: '.project-mutations',
        code: 'project-recovery-unreadable',
        severity: 'error',
        message: `Project mutation records cannot be inspected: ${String(error)}`,
      },
    ];
  }
}

export function unavailableProjectMutationPaths(projectsDir: string): readonly string[] {
  try {
    return readProjectRecoveryReport(projectsDir).pendingProjectPaths;
  } catch {
    // An unreadable journal may name any project. Keep cache evidence and stop
    // project admission until the owner can inspect the reported conflict.
    return ['.'];
  }
}

/** Current-format journals only; never reconstruct definitions from old cache rows. */
export async function recoverInterruptedProjects(deps: RecoveryDeps): Promise<void> {
  let entries;
  try {
    entries = readProjectRecoveryReport(deps.projectsDir).entries;
  } catch (error) {
    log.error(`Project recovery remains unavailable: ${String(error)}`);
    return;
  }
  for (const entry of entries) {
    if (entry.state !== 'preparing' && entry.state !== 'published') continue;
    try {
      const result = await recoverProjectMutation(deps, entry.mutationId);
      log.info(`Project mutation ${entry.mutationId}: ${result.status}`);
    } catch (error) {
      log.warn(`Project mutation ${entry.mutationId} remains pending: ${String(error)}`);
    }
  }
}
