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

// Suite: gemini-transcription
export const SUITE_GEMINI_TRANSCRIPTION = 'gemini-transcription';
export const AGENT_GEMINI_TRANSCRIBER = 'gemini-transcriber';
export const SOURCE_GEMINI = 'gemini';

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

// Event sources
export const SOURCE_GMAIL = 'gmail';
export const SOURCE_TELEGRAM = 'telegram';
export const SOURCE_ORCHESTRATOR = 'orchestrator';

// Project identifiers
export const PROJECT_TELEGRAM_DEFAULT = 'telegram-default';

// Skill name used for orchestrator tasks
export const SKILL_ORCHESTRATOR = 'orchestrator';
