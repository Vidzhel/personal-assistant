import type { DefinitionDiagnostic } from './definition-diagnostics.ts';

interface DiagnosticProvider {
  getDefinitionDiagnostics: () => readonly DefinitionDiagnostic[];
}

export const DEFINITION_VIOLATION_PREFIX = '[definition] ';

/** Optional subsystems contribute their current loaded snapshot when present. */
export function collectCurrentDefinitionDiagnostics(
  providers: readonly (DiagnosticProvider | undefined)[],
): DefinitionDiagnostic[] {
  return providers.flatMap((provider) => [...(provider?.getDefinitionDiagnostics() ?? [])]);
}

export function formatDefinitionDiagnostic(diagnostic: DefinitionDiagnostic): string {
  return `${DEFINITION_VIOLATION_PREFIX}${diagnostic.source} ${diagnostic.path} (${diagnostic.code}): ${diagnostic.message}`;
}
