export type ReadinessState = 'unavailable' | 'configured' | 'verified' | 'failed' | 'unverified';

export type ReadinessSeverity = 'blocking' | 'warning' | 'info';

export interface ReadinessFinding {
  code: string;
  severity: ReadinessSeverity;
  scope: string;
  message: string;
  correction: string;
}

export interface ReadinessRequirement {
  kind: 'executable' | 'configuration' | 'authentication' | 'definition';
  name: string;
  state: ReadinessState;
  correction?: string;
}

export interface CapabilityReadiness {
  name: string;
  displayName: string;
  state: ReadinessState;
  requirements: ReadinessRequirement[];
  findings: ReadinessFinding[];
}

export interface ReadinessContextIndex {
  path: string;
  state: 'verified' | 'unavailable';
}

export interface ReadinessSource {
  id: string;
  label: string;
  sourceType: 'gdrive' | 'file' | 'url' | 'other' | 'folder';
  selected: boolean;
  state: ReadinessState;
  contextIndexes: ReadinessContextIndex[];
}

export interface WorkspaceReadiness {
  state: 'verified' | 'unavailable';
  cwd?: string;
  mode?: 'default' | 'auto' | 'full';
  sourceId?: string;
  settingSources: ('project' | 'local')[];
  blockedOperations: string[];
  sources: ReadinessSource[];
}

export interface AgentReadiness {
  state: 'verified' | 'unavailable';
  id?: string;
  name?: string;
  skills: string[];
}

export interface ReadinessDefinitionDiagnostic {
  source: 'project' | 'agent' | 'schedule' | 'template' | 'skill' | 'mcp' | 'mutation';
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ReadinessRecentFailure {
  taskId: string;
  skillName: string;
  occurredAt: string;
  message: string;
}

export interface ProjectReadinessReport {
  projectId: string;
  checkedAt: string;
  status: 'ready' | 'degraded' | 'blocked';
  workspace: WorkspaceReadiness;
  agent: AgentReadiness;
  capabilities: CapabilityReadiness[];
  definitionDiagnostics: ReadinessDefinitionDiagnostic[];
  recentFailures: ReadinessRecentFailure[];
  findings: ReadinessFinding[];
}
