import type { Project } from '@raven/shared';

export function resolveSystemAccessInstructions(project: Project): string {
  const level = project.systemAccess ?? 'none';
  switch (level) {
    case 'none':
      return 'You MUST NOT read or modify any system files (config/, packages/, migrations/, pipelines/). If asked to do so, explain that this project does not have system access and suggest using the Raven System project instead.';
    case 'read':
      return 'You may READ system files (config/, packages/) for reference, but MUST NOT modify them. If modification is requested, explain the project only has read access.';
    case 'read-write':
      return 'You may read and modify system files (config/, packages/, pipeline definitions). System file modifications are subject to permission tier enforcement — file changes default to Red tier and require approval.';
  }
}

export function resolveToolUseInstructions(): string {
  return "Use tools purposefully. Do not speculatively explore the codebase unless the task explicitly requires file inspection. Focus on the user's request.";
}
