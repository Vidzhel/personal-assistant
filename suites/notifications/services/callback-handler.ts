/**
 * Callback data parser and action router for Telegram inline keyboard buttons.
 * Telegram callback_data has a 64-byte limit, so we use short prefixes:
 *   t:c:{id}       → task complete
 *   t:s:{id}:{dur} → task snooze (1d/1w)
 *   t:d:{id}       → task drop
 *   a:y:{id}       → approval approve
 *   a:n:{id}       → approval deny
 *   a:v:{id}       → approval view details
 *   e:r:{id}       → email reply (triggers reply composition)
 *   e:a:{id}       → email archive
 *   e:f:{id}       → email flag
 *   er:s:{id}      → email reply send
 *   er:e:{id}      → email reply edit
 *   er:c:{id}      → email reply cancel
 *   s:w:{cat}      → snooze category for 1 week
 *   s:k:{cat}      → keep (dismiss snooze suggestion)
 *   s:m:{cat}      → mute category indefinitely
 *   s:u:{id}       → unsnooze (remove snooze)
 *   c:a:{id}       → config change apply
 *   c:e:{id}       → config change edit
 *   c:d:{id}       → config change discard
 *   noop           → disabled button (no action)
 */

import type { InlineKeyboardButton } from 'grammy/types';
import { generateId, CATEGORY_SHORTCODES, type EventBusInterface, type LoggerInterface, type DatabaseInterface, type ConfigChangeResolver } from '@raven/shared';
import { createSnooze, removeSnooze, updateLastSuggested, getActiveSnoozes } from '@raven/core/notification-engine/snooze-store.ts';
import { getSnoozedByCategory, releaseSnoozed } from '@raven/core/notification-engine/notification-queue.ts';
import { getInsightById, updateInsightStatus } from '@raven/core/insight-engine/insight-store.ts';

export interface CallbackAction {
  domain: 'task' | 'approval' | 'email' | 'email-reply' | 'snooze' | 'knowledge-insight' | 'config';
  action: string;
  target: string;
  args: string[];
}

export interface CallbackResult {
  success: boolean;
  message: string;
  updatedKeyboard?: InlineKeyboardButton[][];
}

export interface PendingApprovalInfo {
  id: string;
  actionName: string;
  skillName: string;
  details?: string;
  resolution?: 'approved' | 'denied';
  sessionId?: string;
}

export type { ConfigChangeResolver };

export interface CallbackDeps {
  eventBus: EventBusInterface;
  logger: LoggerInterface;
  db?: DatabaseInterface;
  pendingApprovals: {
    resolve(id: string, resolution: 'approved' | 'denied'): PendingApprovalInfo;
    query(): PendingApprovalInfo[];
    getById(id: string): PendingApprovalInfo | undefined;
  };
  agentManager: {
    executeApprovedAction(params: {
      actionName: string;
      skillName: string;
      details?: string;
      sessionId?: string;
    }): Promise<{ success: boolean; error?: string }>;
  };
  auditLog: {
    insert(entry: {
      skillName: string;
      actionName: string;
      permissionTier: string;
      outcome: string;
      sessionId?: string;
      details?: string;
    }): void;
  };
  configChangeResolver?: ConfigChangeResolver;
}

const DOMAIN_MAP: Record<string, 'task' | 'approval' | 'email' | 'email-reply' | 'snooze' | 'knowledge-insight' | 'config'> = {
  t: 'task',
  a: 'approval',
  e: 'email',
  er: 'email-reply',
  s: 'snooze',
  ki: 'knowledge-insight',
  c: 'config',
};

const SNOOZE_ACTIONS: Record<string, string> = {
  w: 'snooze-week',
  k: 'keep',
  m: 'mute',
  u: 'unsnooze',
};

const TASK_ACTIONS: Record<string, string> = {
  c: 'complete',
  s: 'snooze',
  d: 'drop',
};

const APPROVAL_ACTIONS: Record<string, string> = {
  y: 'approve',
  n: 'deny',
  v: 'details',
};

const EMAIL_ACTIONS: Record<string, string> = {
  r: 'reply',
  a: 'archive',
  f: 'flag',
};

const EMAIL_REPLY_ACTIONS: Record<string, string> = {
  s: 'send',
  e: 'edit',
  c: 'cancel',
};

const KI_ACTIONS: Record<string, string> = {
  v: 'view-graph',
  i: 'interesting',
  n: 'not-useful',
};

const CONFIG_ACTIONS: Record<string, string> = {
  a: 'apply',
  e: 'edit',
  d: 'discard',
};

const MAX_CALLBACK_BYTES = 64;

export function parseCallbackData(data: string): CallbackAction | null {
  if (!data || data === 'noop') return null;

  // Enforce 64-byte limit
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) return null;

  const parts = data.split(':');
  // Minimum: domain:action:target (3 parts)
  if (parts.length < 3) return null;

  const [domainPrefix, actionPrefix, target, ...rest] = parts;
  const domain = DOMAIN_MAP[domainPrefix];
  if (!domain) return null;
  if (!target) return null;

  const actionMaps: Record<string, Record<string, string>> = {
    task: TASK_ACTIONS,
    approval: APPROVAL_ACTIONS,
    email: EMAIL_ACTIONS,
    'email-reply': EMAIL_REPLY_ACTIONS,
    snooze: SNOOZE_ACTIONS,
    'knowledge-insight': KI_ACTIONS,
    config: CONFIG_ACTIONS,
  };
  const actionMap = actionMaps[domain];
  const action = actionMap[actionPrefix];
  if (!action) return null;

  return { domain, action, target, args: rest };
}

const TASK_ACTION_PROMPTS: Record<string, (taskId: string, args: string[]) => string> = {
  complete: (taskId) => `Complete the task with ID ${taskId} in TickTick. Mark it as done.`,
  snooze: (taskId, args) =>
    `Snooze the task with ID ${taskId} in TickTick for ${args[0] === '1w' ? '1 week' : '1 day'}.`,
  drop: (taskId) => `Delete/close the task with ID ${taskId} in TickTick.`,
};

const TASK_ACTION_LABELS: Record<string, string> = {
  complete: 'Done \u2713',
  snooze: 'Snoozed \u2713',
  drop: 'Dropped',
};

function handleTaskAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  const promptBuilder = TASK_ACTION_PROMPTS[action.action];
  if (!promptBuilder) {
    return { success: false, message: `Unknown task action: ${action.action}` };
  }

  const prompt = promptBuilder(action.target, action.args);

  // Fire-and-forget: execute via agent manager (spawns TickTick sub-agent)
  deps.agentManager
    .executeApprovedAction({
      actionName: `task:${action.action}`,
      skillName: 'task-management',
      details: prompt,
    })
    .then((result) => {
      if (!result.success) {
        deps.logger.error(`Task callback failed: ${result.error}`);
      }
    })
    .catch((err: unknown) => {
      deps.logger.error(`Task callback error: ${err}`);
    });

  const label = TASK_ACTION_LABELS[action.action] ?? 'Processing...';
  return {
    success: true,
    message: `${label}`,
    updatedKeyboard: [[{ text: label, callback_data: 'noop' }]],
  };
}

function handleApprovalAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  if (action.action === 'details') {
    return handleApprovalDetails(action.target, deps);
  }

  const resolution = action.action === 'approve' ? 'approved' : 'denied';

  try {
    const approval = deps.pendingApprovals.resolve(action.target, resolution);

    deps.auditLog.insert({
      skillName: approval.skillName,
      actionName: approval.actionName,
      permissionTier: 'red',
      outcome: resolution,
    });

    if (resolution === 'approved') {
      // Emit permission:approved event (mirrors REST route pattern)
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'telegram-callback',
        type: 'permission:approved',
        payload: {
          actionName: approval.actionName,
          skillName: approval.skillName,
          tier: 'red',
          sessionId: approval.sessionId,
        },
      });

      // Fire-and-forget: execute the approved action
      deps.agentManager
        .executeApprovedAction({
          actionName: approval.actionName,
          skillName: approval.skillName,
          details: approval.details,
          sessionId: approval.sessionId,
        })
        .catch((err: unknown) => {
          deps.logger.error(`Approved action execution failed: ${err}`);
        });
    } else {
      // Emit permission:denied event (mirrors REST route pattern)
      deps.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'telegram-callback',
        type: 'permission:denied',
        payload: {
          actionName: approval.actionName,
          skillName: approval.skillName,
          tier: 'red',
          approvalId: action.target,
          sessionId: approval.sessionId,
        },
      });
    }

    const label = resolution === 'approved' ? 'Approved \u2713' : 'Denied \u2717';
    return {
      success: true,
      message: label,
      updatedKeyboard: [[{ text: label, callback_data: 'noop' }]],
    };
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'APPROVAL_ALREADY_RESOLVED') {
      return { success: false, message: 'Already resolved' };
    }
    if (err instanceof Error && (err as Error & { code?: string }).code === 'APPROVAL_NOT_FOUND') {
      return { success: false, message: 'Approval not found' };
    }
    throw err;
  }
}

function handleApprovalDetails(
  approvalId: string,
  deps: CallbackDeps,
): CallbackResult {
  const approval = deps.pendingApprovals.getById(approvalId);

  if (!approval) {
    return { success: false, message: 'Approval not found' };
  }

  const details = [
    `Skill: ${approval.skillName}`,
    `Action: ${approval.actionName}`,
    approval.details ? `Details: ${approval.details}` : null,
    approval.resolution ? `Status: ${approval.resolution}` : 'Status: pending',
  ]
    .filter(Boolean)
    .join('\n');

  return { success: true, message: details };
}

const EMAIL_ACTION_LABELS: Record<string, string> = {
  reply: 'Replying...',
  archive: 'Archived \u2713',
  flag: 'Flagged \u2713',
};

function handleEmailAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  if (action.action === 'reply') {
    // Emit email:reply:start to trigger reply composition flow
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'telegram-callback',
      type: 'email:reply:start',
      payload: {
        emailId: action.target,
      },
    });

    return {
      success: true,
      message: EMAIL_ACTION_LABELS.reply,
      updatedKeyboard: [[{ text: EMAIL_ACTION_LABELS.reply, callback_data: 'noop' }]],
    };
  }

  // Archive and flag: fire-and-forget via agent manager
  const gmailPrompts: Record<string, string> = {
    archive: `Archive the email with ID ${action.target} in Gmail.`,
    flag: `Star/flag the email with ID ${action.target} in Gmail for follow-up.`,
  };

  const prompt = gmailPrompts[action.action];
  if (!prompt) {
    return { success: false, message: `Unknown email action: ${action.action}` };
  }

  deps.agentManager
    .executeApprovedAction({
      actionName: `email:${action.action}`,
      skillName: 'email',
      details: prompt,
    })
    .then((result) => {
      if (!result.success) {
        deps.logger.error(`Email callback failed: ${result.error}`);
      }
    })
    .catch((err: unknown) => {
      deps.logger.error(`Email callback error: ${err}`);
    });

  const label = EMAIL_ACTION_LABELS[action.action] ?? 'Processing...';
  return {
    success: true,
    message: label,
    updatedKeyboard: [[{ text: label, callback_data: 'noop' }]],
  };
}

const EMAIL_REPLY_ACTION_LABELS: Record<string, string> = {
  send: 'Sending...',
  edit: 'Editing...',
  cancel: 'Cancelled',
};

function handleEmailReplyAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  const eventTypeMap: Record<string, string> = {
    send: 'email:reply:send',
    edit: 'email:reply:edit',
    cancel: 'email:reply:cancel',
  };

  const eventType = eventTypeMap[action.action];
  if (!eventType) {
    return { success: false, message: `Unknown email reply action: ${action.action}` };
  }

  if (action.action === 'edit') {
    // For edit, emit a notification asking user for new instructions
    // The reply-composer will handle the actual re-composition when it receives instructions
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'telegram-callback',
      type: 'notification',
      payload: {
        channel: 'telegram' as const,
        title: 'Edit Reply',
        body: 'Please send your corrections or new instructions for this reply.',
        topicName: 'General',
      },
    });
  }

  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'telegram-callback',
    type: eventType,
    payload: {
      compositionId: action.target,
      ...(action.action === 'edit' ? { newInstructions: '' } : {}),
    },
  });

  const label = EMAIL_REPLY_ACTION_LABELS[action.action] ?? 'Processing...';
  return {
    success: true,
    message: label,
    updatedKeyboard: [[{ text: label, callback_data: 'noop' }]],
  };
}

function resolveShortcode(shortcode: string): string {
  return CATEGORY_SHORTCODES[shortcode] ?? `${shortcode}:*`;
}

function handleSnoozeAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  if (!deps.db) {
    return { success: false, message: 'Database not available for snooze actions' };
  }

  const shortcode = action.target;
  const category = resolveShortcode(shortcode);

  if (action.action === 'snooze-week') {
    createSnooze(deps.db, { category, duration: '1w' });
    return {
      success: true,
      message: `Snoozed ${category} for 1 week`,
      updatedKeyboard: [[{ text: 'Snoozed 1w \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'keep') {
    // Record that this category was kept (prevent re-suggesting for cooldown period)
    updateLastSuggested(deps.db, category);
    return {
      success: true,
      message: 'Kept — won\'t suggest again for 7 days',
      updatedKeyboard: [[{ text: 'Kept \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'mute') {
    createSnooze(deps.db, { category, duration: 'mute' });
    return {
      success: true,
      message: `Muted ${category} indefinitely`,
      updatedKeyboard: [[{ text: 'Muted \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'unsnooze') {
    // target is the snooze ID — look up category before deleting
    const snoozes = getActiveSnoozes(deps.db);
    const snoozeRecord = snoozes.find((s) => s.id === action.target);

    const removed = removeSnooze(deps.db, action.target);
    if (!removed) {
      return { success: false, message: 'Snooze not found' };
    }

    // Release held notifications using the actual category from the snooze record
    if (snoozeRecord) {
      const snoozed = getSnoozedByCategory(deps.db, snoozeRecord.category);
      if (snoozed.length > 0) {
        releaseSnoozed(
          deps.db,
          snoozed.map((n) => n.id),
        );
      }
    }

    return {
      success: true,
      message: 'Unsnoozed — held notifications released',
      updatedKeyboard: [[{ text: 'Unsnoozed \u2713', callback_data: 'noop' }]],
    };
  }

  return { success: false, message: `Unknown snooze action: ${action.action}` };
}

const DISMISSAL_THRESHOLD = 3;
const THRESHOLD_INCREMENT = 0.1;
const THRESHOLD_CAP = 0.95;

// eslint-disable-next-line max-lines-per-function -- knowledge-insight callback handler with 3 action branches
function handleKnowledgeInsightAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  if (!deps.db) {
    return { success: false, message: 'Database not available' };
  }

  const insightId = action.target;
  const insight = getInsightById(deps.db, insightId);
  if (!insight) {
    return { success: false, message: 'Insight not found' };
  }

  if (action.action === 'view-graph') {
    const webUrl = process.env.RAVEN_WEB_URL ?? 'http://localhost:3000';
    updateInsightStatus(deps.db, insightId, 'acted');

    // Extract bubble IDs from service_sources: ["knowledge-engine", "bubbles:id1,id2"]
    const sources: string[] = JSON.parse(insight.service_sources);
    const bubbleEntry = sources.find((s) => s.startsWith('bubbles:'));
    const bubbleIds = bubbleEntry ? bubbleEntry.replace('bubbles:', '') : insightId;
    const deepLink = `${webUrl}/knowledge?highlight=${bubbleIds}`;

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'telegram-callback',
      type: 'notification',
      payload: {
        channel: 'telegram' as const,
        title: 'View in Knowledge Graph',
        body: `[Open Knowledge Graph](${deepLink})`,
        topicName: 'General',
      },
    });

    return {
      success: true,
      message: 'Opening graph...',
      updatedKeyboard: [[{ text: 'Viewed \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'interesting') {
    updateInsightStatus(deps.db, insightId, 'acted');

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'telegram-callback',
      type: 'insight:feedback',
      payload: { insightId, feedback: 'positive' },
    });

    return {
      success: true,
      message: 'Marked as interesting',
      updatedKeyboard: [[{ text: 'Interesting \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'not-useful') {
    updateInsightStatus(deps.db, insightId, 'dismissed');

    // Extract domain pair from pattern_key: 'cross-domain:finances-health'
    const domainPair = insight.pattern_key.replace('cross-domain:', '');

    // Record dismissal
    deps.db.run(
      'INSERT INTO cross_domain_dismissals (id, insight_id, domain_pair, created_at) VALUES (?, ?, ?, ?)',
      generateId(),
      insightId,
      domainPair,
      new Date().toISOString(),
    );

    // Check if 3+ dismissals → bump adaptive threshold
    const dismissalRow = deps.db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM cross_domain_dismissals WHERE domain_pair = ?',
      domainPair,
    );

    const dismissalCount = dismissalRow?.cnt ?? 0;
    if (dismissalCount >= DISMISSAL_THRESHOLD) {
      const existing = deps.db.get<{ threshold: number }>(
        'SELECT threshold FROM cross_domain_thresholds WHERE domain_pair = ?',
        domainPair,
      );

      const currentThreshold = existing?.threshold ?? 0.75;
      const newThreshold = Math.min(currentThreshold + THRESHOLD_INCREMENT, THRESHOLD_CAP);

      deps.db.run(
        `INSERT INTO cross_domain_thresholds (domain_pair, threshold, dismissal_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain_pair) DO UPDATE SET threshold = ?, dismissal_count = ?, updated_at = ?`,
        domainPair,
        newThreshold,
        dismissalCount,
        new Date().toISOString(),
        newThreshold,
        dismissalCount,
        new Date().toISOString(),
      );

      deps.logger.info(`Adaptive threshold for ${domainPair} bumped to ${newThreshold}`);
    }

    return {
      success: true,
      message: 'Dismissed',
      updatedKeyboard: [[{ text: 'Dismissed \u2717', callback_data: 'noop' }]],
    };
  }

  return { success: false, message: `Unknown knowledge-insight action: ${action.action}` };
}

function handleConfigAction(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  const shortId = action.target;

  if (action.action === 'apply') {
    if (!deps.configChangeResolver) {
      return { success: false, message: 'Config change resolver not available' };
    }

    const result = deps.configChangeResolver.resolve(shortId, 'apply');
    if (!result.success) {
      return { success: false, message: result.message };
    }

    return {
      success: true,
      message: 'Applied \u2713',
      updatedKeyboard: [[{ text: 'Applied \u2713', callback_data: 'noop' }]],
    };
  }

  if (action.action === 'edit') {
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'telegram-callback',
      type: 'notification',
      payload: {
        channel: 'telegram' as const,
        title: 'Edit Config Change',
        body: 'Describe the changes you want to make to this configuration.',
        topicName: 'Raven System',
      },
    });

    return {
      success: true,
      message: 'Describe your changes:',
    };
  }

  if (action.action === 'discard') {
    if (!deps.configChangeResolver) {
      return { success: false, message: 'Config change resolver not available' };
    }

    const result = deps.configChangeResolver.resolve(shortId, 'discard');
    if (!result.success) {
      return { success: false, message: result.message };
    }

    return {
      success: true,
      message: 'Discarded \u2717',
      updatedKeyboard: [[{ text: 'Discarded \u2717', callback_data: 'noop' }]],
    };
  }

  return { success: false, message: `Unknown config action: ${action.action}` };
}

export function handleCallback(
  action: CallbackAction,
  deps: CallbackDeps,
): CallbackResult {
  if (action.domain === 'task') {
    return handleTaskAction(action, deps);
  }
  if (action.domain === 'email') {
    return handleEmailAction(action, deps);
  }
  if (action.domain === 'email-reply') {
    return handleEmailReplyAction(action, deps);
  }
  if (action.domain === 'snooze') {
    return handleSnoozeAction(action, deps);
  }
  if (action.domain === 'knowledge-insight') {
    return handleKnowledgeInsightAction(action, deps);
  }
  if (action.domain === 'config') {
    return handleConfigAction(action, deps);
  }
  return handleApprovalAction(action, deps);
}
