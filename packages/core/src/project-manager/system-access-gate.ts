import type { Project } from '@raven/shared';

export function resolveSystemAccessInstructions(project: Project): string {
  const level = project.systemAccess ?? 'none';
  switch (level) {
    case 'none':
      return 'You MUST NOT read or modify any system files (config/, packages/, migrations/). If asked to do so, explain that this project does not have system access and suggest using the Raven System project instead.';
    case 'read':
      return 'You may READ system files (config/, packages/) for reference, but MUST NOT modify them. If modification is requested, explain the project only has read access.';
    case 'read-write':
      // H2 (permission-engine/tool-policy.ts's handleFileTool): Write/Edit/
      // MultiEdit/NotebookEdit are gated by the agent's bashAccess level and
      // path allow/deny lists — the SAME mechanism Bash commands use — not
      // by a permission-tier/approval-queue lookup. A denied path is a hard
      // block, not a queued approval.
      return 'You may read and modify system files (config/, packages/). System file modifications are enforced by your bash access level and its allowed/denied path lists — a file write outside those paths (or with no write access) is blocked outright, not queued for approval.';
  }
}

export function resolveToolUseInstructions(): string {
  return "Use tools purposefully. Do not speculatively explore the codebase unless the task explicitly requires file inspection. Focus on the user's request.";
}
