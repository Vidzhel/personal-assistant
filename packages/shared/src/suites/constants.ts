// Suite names (match suite.ts manifests)
export const SUITE_ORCHESTRATOR = '_orchestrator';
export const SUITE_TASK_MANAGEMENT = 'task-management';
export const SUITE_EMAIL = 'email';
export const SUITE_DAILY_BRIEFING = 'daily-briefing';
export const SUITE_NOTIFICATIONS = 'notifications';

// MCP server local keys (match mcp.json keys)
export const MCP_TICKTICK = 'ticktick';
export const MCP_GMAIL = 'gmail';

// Agent names (match defineAgent name fields)
export const AGENT_TICKTICK = 'ticktick-agent';
export const AGENT_GMAIL = 'gmail-agent';
export const AGENT_DIGEST = 'digest-agent';
export const AGENT_TELEGRAM = 'telegram-notifier';
export const AGENT_ORCHESTRATOR = 'raven-orchestrator';
export const AGENT_PRODUCTIVITY_COORD = 'productivity-coordinator';
export const AGENT_COMMUNICATION_COORD = 'communication-coordinator';

// Suite: proactive-intelligence
export const SUITE_PROACTIVE_INTELLIGENCE = 'proactive-intelligence';
export const AGENT_PATTERN_ANALYZER = 'pattern-analyzer';

// Event types: insight
export const EVENT_INSIGHT_GENERATED = 'insight:generated' as const;
export const EVENT_INSIGHT_QUEUED = 'insight:queued' as const;
export const EVENT_INSIGHT_SUPPRESSED = 'insight:suppressed' as const;

// Suite: google-workspace
export const SUITE_GOOGLE_WORKSPACE = 'google-workspace';
export const AGENT_GWS = 'gws-agent';
export const SOURCE_GWS_GMAIL = 'gws-gmail';
export const SOURCE_GWS_DRIVE = 'gws-drive';

// Suite: gemini-transcription
export const SUITE_GEMINI_TRANSCRIPTION = 'gemini-transcription';
export const AGENT_GEMINI_TRANSCRIBER = 'gemini-transcriber';
export const SOURCE_GEMINI = 'gemini';

// File processing suite
export const SUITE_FILE_PROCESSING = 'file-processing';
export const AGENT_FILE = 'file-agent';
export const MCP_MARKDOWNIFY = 'markdownify';

// Transcription agent (addition to gemini-transcription suite)
export const AGENT_TRANSCRIPTION = 'transcription-agent';

// Event sources
export const SOURCE_FILE_PROCESSING = 'file-processing';
export const SOURCE_TRANSCRIPTION = 'transcription';

// Event types
export const EVENT_TRANSCRIPTION_REQUEST = 'transcription:request' as const;
export const EVENT_TRANSCRIPTION_COMPLETE = 'transcription:complete' as const;
export const EVENT_TRANSCRIPTION_FAILED = 'transcription:failed' as const;

// Email reply event types
export const EVENT_EMAIL_REPLY_START = 'email:reply:start' as const;
export const EVENT_EMAIL_REPLY_SEND = 'email:reply:send' as const;
export const EVENT_EMAIL_REPLY_EDIT = 'email:reply:edit' as const;
export const EVENT_EMAIL_REPLY_CANCEL = 'email:reply:cancel' as const;

// Email triage event types
export const EVENT_EMAIL_TRIAGE_PROCESSED = 'email:triage:processed' as const;
export const EVENT_EMAIL_TRIAGE_ACTION_ITEMS = 'email:triage:action-items' as const;

// Email action extract event types
export const EVENT_EMAIL_ACTION_EXTRACT_COMPLETED = 'email:action-extract:completed' as const;
export const EVENT_EMAIL_ACTION_EXTRACT_FAILED = 'email:action-extract:failed' as const;

// Task management autonomous event types
export const EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED = 'task-management:autonomous:completed' as const;
export const EVENT_TASK_MGMT_AUTONOMOUS_FAILED = 'task-management:autonomous:failed' as const;
export const EVENT_TASK_MGMT_MANAGE_REQUEST = 'task-management:manage-request' as const;

// Event sources
export const SOURCE_GMAIL = 'gmail';
export const SOURCE_TELEGRAM = 'telegram';
export const SOURCE_ORCHESTRATOR = 'orchestrator';

// Project identifiers
export const PROJECT_TELEGRAM_DEFAULT = 'telegram-default';
export const META_PROJECT_ID = 'meta';

// Skill name used for orchestrator tasks
export const SKILL_ORCHESTRATOR = 'orchestrator';

// Suite: notifications — delivery scheduler
export const SERVICE_DELIVERY_SCHEDULER = 'delivery-scheduler';

// Notification delivery event types
export const EVENT_NOTIFICATION_DELIVER = 'notification:deliver' as const;
export const EVENT_NOTIFICATION_QUEUED = 'notification:queued' as const;
export const EVENT_NOTIFICATION_BATCHED = 'notification:batched' as const;
export const EVENT_NOTIFICATION_ESCALATED = 'notification:escalated' as const;

// Snooze
export const EVENT_NOTIFICATION_SNOOZED = 'notification:snoozed' as const;
export const EVENT_SNOOZE_PROPOSAL = 'notification:snooze-proposal' as const;
export const SERVICE_SNOOZE_SUGGESTER = 'snooze-suggester';
export const UNSNOOZABLE_CATEGORIES = ['permission:blocked', 'system:health:alert'] as const;

// Category shortcode mapping for Telegram callback data (64-byte limit)
export const CATEGORY_SHORTCODES: Record<string, string> = {
  pipe: 'pipeline:*',
  email: 'email:triage:*',
  task: 'agent:task:complete',
  insight: 'insight:*',
  sched: 'schedule:triggered',
};

export const SHORTCODE_FROM_CATEGORY: Record<string, string> = {
  'pipeline:*': 'pipe',
  'email:triage:*': 'email',
  'agent:task:complete': 'task',
  'insight:*': 'insight',
  'schedule:triggered': 'sched',
};

// Suite: financial-tracking
export const SUITE_FINANCIAL_TRACKING = 'financial-tracking';
export const SOURCE_FINANCIAL = 'financial';
export const EVENT_FINANCIAL_TRANSACTION_RECORDED = 'financial:transaction:recorded' as const;
export const EVENT_FINANCIAL_SYNC_COMPLETE = 'financial:sync-complete' as const;

// Maintenance
export const EVENT_MAINTENANCE_REPORT_GENERATED = 'maintenance:report:generated' as const;
export const SOURCE_MAINTENANCE = 'maintenance';

// Config management
export const AGENT_CONFIG_MANAGER = 'config-manager';
export const SOURCE_CONFIG_MANAGER = 'config-manager';
export const EVENT_CONFIG_CHANGE_PROPOSED = 'config:change:proposed' as const;
export const EVENT_CONFIG_CHANGE_APPLIED = 'config:change:applied' as const;
export const EVENT_CONFIG_CHANGE_REJECTED = 'config:change:rejected' as const;

// Engagement tracking
export const EVENT_ENGAGEMENT_STATE_CHANGED = 'engagement:state-changed' as const;
export const SERVICE_ENGAGEMENT_TRACKER = 'engagement-tracker';
export const DEFAULT_LOW_ENGAGEMENT_THRESHOLD = 5;
export const DEFAULT_RESUME_THRESHOLD = 3;
export const DEFAULT_ESCALATION_HOURS = 4;
export const DEFAULT_INSIGHT_AUTO_DISMISS_HOURS = 24;
