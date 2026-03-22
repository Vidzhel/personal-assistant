import { createLogger, generateId, SOURCE_CONFIG_MANAGER, type EventBusInterface } from '@raven/shared';
import type { ConfigChangeAction, ConfigResourceType } from '@raven/shared';

const log = createLogger('config-presenter');

export interface ConfigChangeProposal {
  action: ConfigChangeAction;
  resourceType: ConfigResourceType;
  resourceName: string;
  content?: string;
  currentContent?: string;
  diff?: string;
  description: string;
  sessionId?: string;
}

export interface FormattedProposal {
  changeId: string;
  action: ConfigChangeAction;
  resourceType: ConfigResourceType;
  resourceName: string;
  currentContent: string | null;
  proposedContent: string | null;
  diffText: string | null;
  description: string;
  displayText: string;
  sessionId?: string;
}

/**
 * Formats a proposed config change for user review and emits the proposal event.
 */
export function presentConfigChange(
  proposal: ConfigChangeProposal,
  eventBus: EventBusInterface,
): FormattedProposal {
  const changeId = generateId();

  const formatted = formatProposal(changeId, proposal);

  log.info(`Config change proposed: ${proposal.action} ${proposal.resourceType} "${proposal.resourceName}"`);

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_CONFIG_MANAGER,
    type: 'config:change:proposed',
    payload: {
      changeId,
      action: proposal.action,
      resourceType: proposal.resourceType,
      resourceName: proposal.resourceName,
      description: proposal.description,
      sessionId: proposal.sessionId,
    },
  });

  return formatted;
}

function formatProposal(
  changeId: string,
  proposal: ConfigChangeProposal,
): FormattedProposal {
  const { action, resourceType, resourceName, content, currentContent, diff, description, sessionId } = proposal;

  let displayText: string;
  let diffText: string | null = null;

  switch (action) {
    case 'create': {
      displayText = formatCreateDisplay(resourceType, resourceName, description, content);
      break;
    }
    case 'update': {
      diffText = diff ?? generateSimpleDiff(currentContent ?? '', content ?? '');
      displayText = formatUpdateDisplay(resourceType, resourceName, description, diffText);
      break;
    }
    case 'delete': {
      displayText = formatDeleteDisplay(resourceType, resourceName, description);
      break;
    }
    case 'view': {
      displayText = formatViewDisplay(resourceType, resourceName, content);
      break;
    }
  }

  return {
    changeId,
    action,
    resourceType,
    resourceName,
    currentContent: currentContent ?? null,
    proposedContent: content ?? null,
    diffText,
    description,
    displayText,
    sessionId,
  };
}

function formatCreateDisplay(
  resourceType: ConfigResourceType,
  resourceName: string,
  description: string,
  content?: string,
): string {
  const lines: string[] = [
    `Config Change Proposed`,
    ``,
    `Action: Create ${resourceType}`,
    `Resource: ${resourceName}`,
    `Description: ${description}`,
  ];

  if (content) {
    lines.push('', '---', content, '---');
  }

  return lines.join('\n');
}

function formatUpdateDisplay(
  resourceType: ConfigResourceType,
  resourceName: string,
  description: string,
  diffText: string,
): string {
  const lines: string[] = [
    `Config Change Proposed`,
    ``,
    `Action: Update ${resourceType}`,
    `Resource: ${resourceName}`,
    `Description: ${description}`,
    ``,
    diffText,
  ];

  return lines.join('\n');
}

function formatDeleteDisplay(
  resourceType: ConfigResourceType,
  resourceName: string,
  description: string,
): string {
  return [
    `Config Change Proposed`,
    ``,
    `Action: Delete ${resourceType}`,
    `Resource: ${resourceName}`,
    `Description: ${description}`,
    ``,
    `This will permanently remove the ${resourceType} "${resourceName}".`,
  ].join('\n');
}

function formatViewDisplay(
  resourceType: ConfigResourceType,
  resourceName: string,
  content?: string,
): string {
  const lines: string[] = [
    `Current ${resourceType}: ${resourceName}`,
  ];

  if (content) {
    lines.push('', '---', content, '---');
  } else {
    lines.push('', 'No content available.');
  }

  return lines.join('\n');
}

/**
 * Simple line-by-line diff for when a real diff library isn't available.
 */
export function generateSimpleDiff(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = [`--- current`, `+++ proposed`];

  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    const bLine = beforeLines[i];
    const aLine = afterLines[i];

    if (bLine === aLine) {
      lines.push(` ${bLine ?? ''}`);
    } else {
      if (bLine !== undefined) {
        lines.push(`-${bLine}`);
      }
      if (aLine !== undefined) {
        lines.push(`+${aLine}`);
      }
    }
  }

  return lines.join('\n');
}
