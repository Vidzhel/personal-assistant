import {
  createLogger,
  generateId,
  SOURCE_CONFIG_MANAGER,
  mapConfigChangeRow,
  type EventBusInterface,
  type DatabaseInterface,
  type PendingConfigChange,
  type PendingConfigChangeRow,
  type ConfigResourceType,
} from '@raven/shared';
import type { FormattedProposal } from './config-presenter.ts';
import { applyConfigChange, type ConfigApplierDeps } from './config-applier.ts';

export type { PendingConfigChange };

const log = createLogger('config-approval-handler');

const MAX_TELEGRAM_LENGTH = 3800;

/**
 * Stores a proposed config change in the DB and sends a Telegram notification
 * with inline keyboard buttons for approval.
 */
export function proposeConfigChange(
  db: DatabaseInterface,
  eventBus: EventBusInterface,
  proposal: FormattedProposal,
): PendingConfigChange {
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO pending_config_changes
     (id, resource_type, resource_name, action, current_content, proposed_content, diff_text, description, status, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    proposal.changeId,
    proposal.resourceType,
    proposal.resourceName,
    proposal.action,
    proposal.currentContent,
    proposal.proposedContent,
    proposal.diffText,
    proposal.description,
    proposal.sessionId ?? null,
    now,
  );

  log.info(`Stored pending config change: ${proposal.changeId}`);

  // Send Telegram notification with inline keyboard
  const shortId = proposal.changeId.slice(0, 8);
  let body = proposal.displayText;
  if (body.length > MAX_TELEGRAM_LENGTH) {
    body = body.slice(0, MAX_TELEGRAM_LENGTH) + '\n\n_...truncated. View full change on dashboard._';
  }

  // Only show approval buttons for non-view actions
  const actions =
    proposal.action === 'view'
      ? []
      : [
          { label: 'Apply', action: 'callback', data: `c:a:${shortId}` },
          { label: 'Edit', action: 'callback', data: `c:e:${shortId}` },
          { label: 'Discard', action: 'callback', data: `c:d:${shortId}` },
        ];

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_CONFIG_MANAGER,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: `Config: ${proposal.action} ${proposal.resourceType}`,
      body,
      topicName: 'Raven System',
      actions,
    },
  });

  return {
    id: proposal.changeId,
    resourceType: proposal.resourceType,
    resourceName: proposal.resourceName,
    action: proposal.action,
    currentContent: proposal.currentContent,
    proposedContent: proposal.proposedContent,
    diffText: proposal.diffText,
    description: proposal.description,
    status: 'pending',
    telegramMessageId: null,
    sessionId: proposal.sessionId ?? null,
    createdAt: now,
    resolvedAt: null,
  };
}

/**
 * Resolves a pending config change (apply or discard).
 */
export function resolveConfigChange(
  db: DatabaseInterface,
  eventBus: EventBusInterface,
  applierDeps: ConfigApplierDeps,
  changeId: string,
  resolution: 'apply' | 'discard',
): { success: boolean; message: string } {
  const change = getConfigChangeById(db, changeId);
  if (!change) {
    return { success: false, message: 'Config change not found' };
  }
  if (change.status !== 'pending') {
    return { success: false, message: `Config change already ${change.status}` };
  }

  const now = new Date().toISOString();

  if (resolution === 'apply') {
    const result = applyConfigChange(applierDeps, {
      changeId: change.id,
      action: change.action,
      resourceType: change.resourceType,
      resourceName: change.resourceName,
      content: change.proposedContent ?? undefined,
    });

    if (!result.success) {
      return result;
    }

    db.run(
      'UPDATE pending_config_changes SET status = ?, resolved_at = ? WHERE id = ?',
      'applied',
      now,
      change.id,
    );

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_CONFIG_MANAGER,
      type: 'config:change:applied',
      payload: {
        changeId: change.id,
        action: change.action,
        resourceType: change.resourceType,
        resourceName: change.resourceName,
      },
    });

    log.info(`Config change applied: ${change.id}`);
    return { success: true, message: result.message };
  }

  // Discard
  db.run(
    'UPDATE pending_config_changes SET status = ?, resolved_at = ? WHERE id = ?',
    'discarded',
    now,
    change.id,
  );

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_CONFIG_MANAGER,
    type: 'config:change:rejected',
    payload: {
      changeId: change.id,
      action: change.action,
      resourceType: change.resourceType,
      resourceName: change.resourceName,
    },
  });

  log.info(`Config change discarded: ${change.id}`);
  return { success: true, message: 'Change discarded' };
}

/**
 * Retrieves a config change by ID (full or short ID prefix).
 */
export function getConfigChangeById(
  db: DatabaseInterface,
  changeId: string,
): PendingConfigChange | undefined {
  // Support short IDs (first 8 chars) from Telegram callbacks
  // For short IDs, prefer pending records to reduce collision risk
  const row = db.get<PendingConfigChangeRow>(
    changeId.length <= 8
      ? 'SELECT * FROM pending_config_changes WHERE id LIKE ? ORDER BY CASE WHEN status = \'pending\' THEN 0 ELSE 1 END, created_at DESC LIMIT 1'
      : 'SELECT * FROM pending_config_changes WHERE id = ?',
    changeId.length <= 8 ? `${changeId}%` : changeId,
  );

  if (!row) return undefined;

  return mapRow(row);
}

/**
 * Lists pending config changes, optionally filtered by status.
 */
export function listConfigChanges(
  db: DatabaseInterface,
  options?: { status?: string; limit?: number },
): PendingConfigChange[] {
  const limit = options?.limit ?? 50;

  if (options?.status) {
    const rows = db.all<PendingConfigChangeRow>(
      'SELECT * FROM pending_config_changes WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      options.status,
      limit,
    );
    return rows.map(mapRow);
  }

  const rows = db.all<PendingConfigChangeRow>(
    'SELECT * FROM pending_config_changes ORDER BY created_at DESC LIMIT ?',
    limit,
  );
  return rows.map(mapRow);
}

const mapRow = mapConfigChangeRow;
