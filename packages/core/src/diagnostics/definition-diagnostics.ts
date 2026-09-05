import { Cron } from 'croner';

/** A stable, machine-readable description of a definition that could not be
 * loaded (or was loaded with a warning). Paths are relative to the definition
 * root and use POSIX separators so reloads produce comparable snapshots. */
export interface DefinitionDiagnostic {
  source: 'project' | 'agent' | 'schedule' | 'template' | 'skill' | 'mcp' | 'mutation';
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate the same timing inputs Croner receives at runtime without leaving
 * a live timer behind. */
export function validateScheduleTiming(cron: string, timezone: string): string | undefined {
  let job: Cron | undefined;
  try {
    job = new Cron(cron, { timezone });
    job.nextRun();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  } finally {
    job?.stop();
  }
}
