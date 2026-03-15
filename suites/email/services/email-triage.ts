import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  generateId,
  createLogger,
  SUITE_EMAIL,
  EVENT_EMAIL_TRIAGE_PROCESSED,
  EVENT_EMAIL_TRIAGE_ACTION_ITEMS,
  EmailTriageConfigSchema,
  NewEmailPayloadSchema,
  ConfigReloadedPayloadSchema,
  type EmailTriageConfig,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { matchRules, type EmailPayload, type MatchResult } from './rule-matcher.ts';

const log = createLogger('email-triage');

const CONFIG_PATH = resolve('config/email-rules.json');

let eventBus: EventBusInterface;
let serviceConfig: Record<string, unknown>;
let triageConfig: EmailTriageConfig | null = null;

interface AgentManagerLike {
  executeApprovedAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
}

function getAgentManager(): AgentManagerLike | null {
  const mgr = serviceConfig.agentManager as AgentManagerLike | undefined;
  if (!mgr) {
    log.error('Agent manager not available in service config');
    return null;
  }
  return mgr;
}

async function loadRules(): Promise<EmailTriageConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = EmailTriageConfigSchema.safeParse(parsed);
    if (!validated.success) {
      log.error(`Invalid email rules config: ${validated.error.message}`);
      return null;
    }
    return validated.data;
  } catch (err) {
    log.error(`Failed to load email rules: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function emitNotification(
  title: string,
  body: string,
  actions?: Array<{ label: string; action: string }>,
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_EMAIL,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title,
      body,
      topicName: 'Email',
      actions: actions && actions.length > 0 ? actions : undefined,
    },
  });
}

function buildUrgentActions(messageId: string): Array<{ label: string; action: string }> {
  const shortId = messageId.slice(0, 8);
  return [
    { label: 'View', action: `e:v:${shortId}` },
    { label: 'Archive', action: `e:a:${shortId}` },
    { label: 'Reply', action: `e:r:${shortId}` },
  ];
}

async function executeTriageActions(
  email: EmailPayload,
  matchResult: MatchResult,
): Promise<string[]> {
  const agentManager = getAgentManager();
  if (!agentManager) return [];

  const actionsTaken: string[] = [];
  const { actions } = matchResult;

  if (actions.label) {
    try {
      await agentManager.executeApprovedAction({
        actionName: 'gmail:label-email',
        skillName: SUITE_EMAIL,
        details: `Apply the label "${actions.label}" to email with messageId "${email.messageId}" from "${email.from}" with subject "${email.subject}".`,
      });
      actionsTaken.push(`label:${actions.label}`);
    } catch (err) {
      log.error(`Failed to label email ${email.messageId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (actions.archive) {
    try {
      await agentManager.executeApprovedAction({
        actionName: 'gmail:archive-email',
        skillName: SUITE_EMAIL,
        details: `Archive the email with messageId "${email.messageId}" from "${email.from}" with subject "${email.subject}".`,
      });
      actionsTaken.push('archive');
    } catch (err) {
      log.error(`Failed to archive email ${email.messageId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (actions.markRead) {
    try {
      await agentManager.executeApprovedAction({
        actionName: 'gmail:mark-read',
        skillName: SUITE_EMAIL,
        details: `Mark the email with messageId "${email.messageId}" as read.`,
      });
      actionsTaken.push('markRead');
    } catch (err) {
      log.error(`Failed to mark email ${email.messageId} as read: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (actions.extractActions) {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SUITE_EMAIL,
      type: EVENT_EMAIL_TRIAGE_ACTION_ITEMS,
      payload: { emailId: email.messageId },
    });
    actionsTaken.push('extractActions');
  }

  if (actions.flag === 'urgent') {
    emitNotification(
      `Urgent Email from ${email.from}`,
      `Subject: ${email.subject}\n\n${email.snippet}`,
      buildUrgentActions(email.messageId),
    );
    actionsTaken.push('flag:urgent');
  }

  return actionsTaken;
}

async function handleNewEmail(event: unknown): Promise<void> {
  if (!triageConfig || !triageConfig.enabled) return;

  const e = event as { payload: unknown };
  const parsed = NewEmailPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.warn(`Invalid email:new payload: ${parsed.error.message}`);
    return;
  }
  const email: EmailPayload = parsed.data;

  const results = matchRules(email, triageConfig.rules, triageConfig.matchMode);
  if (results.length === 0) {
    log.debug(`No triage rules matched for email ${email.messageId}`);
    return;
  }

  log.info(`Email ${email.messageId} matched ${results.length} triage rule(s): ${results.map((r) => r.ruleName).join(', ')}`);

  const allActionsTaken: string[] = [];
  const allRulesMatched: string[] = [];

  for (const result of results) {
    allRulesMatched.push(result.ruleName);
    const actions = await executeTriageActions(email, result);
    allActionsTaken.push(...actions);
  }

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_EMAIL,
    type: EVENT_EMAIL_TRIAGE_PROCESSED,
    payload: {
      emailId: email.messageId,
      rulesMatched: allRulesMatched,
      actionsTaken: allActionsTaken,
    },
  });
}

async function handleConfigReloaded(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = ConfigReloadedPayloadSchema.safeParse(e.payload);
  if (!parsed.success) return;
  if (parsed.data.configType !== 'email-rules') return;

  const newConfig = await loadRules();
  if (newConfig) {
    triageConfig = newConfig;
    log.info(`Email triage rules reloaded: ${triageConfig.rules.length} rules`);
  } else {
    log.warn('Config reload produced invalid rules, keeping previous rules');
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    serviceConfig = context.config;

    triageConfig = await loadRules();
    if (triageConfig) {
      log.info(`Loaded ${triageConfig.rules.length} email triage rules`);
    } else {
      log.warn('No valid email triage rules found, service will wait for config reload');
      triageConfig = { rules: [], matchMode: 'all', enabled: true };
    }

    eventBus.on('email:new', handleNewEmail as (event: unknown) => void);
    eventBus.on('config:reloaded', handleConfigReloaded as (event: unknown) => void);
    log.info('Email triage service started');
  },

  async stop(): Promise<void> {
    if (eventBus) {
      eventBus.off('email:new', handleNewEmail as (event: unknown) => void);
      eventBus.off('config:reloaded', handleConfigReloaded as (event: unknown) => void);
    }
    triageConfig = null;
    serviceConfig = {} as Record<string, unknown>;
    log.info('Email triage service stopped');
  },
};

export default service;

// Export for testing
export { loadRules, handleNewEmail, handleConfigReloaded };
