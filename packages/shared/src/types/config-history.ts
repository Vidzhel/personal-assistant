export interface ConfigCommit {
  hash: string;
  timestamp: string;
  message: string;
  author: string;
  files: string[];
}

export interface ConfigCommitDetail extends ConfigCommit {
  diffs: Array<{
    file: string;
    diff: string;
  }>;
}

export interface RevertResult {
  success: boolean;
  message: string;
  revertHash?: string;
  reloadedConfigs: string[];
}

export interface LifeDashboardData {
  today: {
    autonomousActionsCount: number;
    pipelinesCompleted: number;
  };
  pipelines: {
    activeCount: number;
    lastRun?: {
      name: string;
      status: string;
      completedAt: string;
    };
  };
  pendingApprovalsCount: number;
  insights: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
  }>;
  systemHealth: {
    status: string;
    uptime: number;
    agentsRunning: number;
    queueLength: number;
  };
  upcomingEvents: Array<{
    name: string;
    scheduledAt: string;
    type: string;
  }>;
}
