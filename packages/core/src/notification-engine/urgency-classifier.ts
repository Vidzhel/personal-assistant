import type { NotificationEvent, DeliveryMode, UrgencyTier } from '@raven/shared';
import { createLogger } from '@raven/shared';

const log = createLogger('urgency-classifier');

export interface ClassificationRule {
  sourcePattern: string;
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
  condition?: {
    field: string;
    op: 'gte' | 'lt';
    value: number;
  };
}

export interface ClassificationResult {
  urgencyTier: UrgencyTier;
  deliveryMode: DeliveryMode;
}

const DEFAULT_RULES: ClassificationRule[] = [
  { sourcePattern: 'permission:blocked', urgencyTier: 'red', deliveryMode: 'tell-now' },
  { sourcePattern: 'system:health:alert', urgencyTier: 'red', deliveryMode: 'tell-now' },
  {
    sourcePattern: 'insight:*',
    urgencyTier: 'yellow',
    deliveryMode: 'tell-when-active',
    condition: { field: 'confidence', op: 'gte', value: 0.8 },
  },
  {
    sourcePattern: 'insight:*',
    urgencyTier: 'green',
    deliveryMode: 'save-for-later',
    condition: { field: 'confidence', op: 'lt', value: 0.8 },
  },
  { sourcePattern: 'agent:task:complete', urgencyTier: 'yellow', deliveryMode: 'tell-when-active' },
  { sourcePattern: 'pipeline:complete', urgencyTier: 'green', deliveryMode: 'save-for-later' },
  { sourcePattern: 'pipeline:failed', urgencyTier: 'yellow', deliveryMode: 'tell-when-active' },
  { sourcePattern: 'email:triage:*', urgencyTier: 'green', deliveryMode: 'save-for-later' },
  { sourcePattern: 'schedule:triggered', urgencyTier: 'green', deliveryMode: 'save-for-later' },
];

function matchesPattern(source: string, pattern: string): boolean {
  if (pattern === source) return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return source.startsWith(prefix);
  }
  return false;
}

function evaluateCondition(
  condition: ClassificationRule['condition'],
  event: NotificationEvent,
): boolean {
  if (!condition) return true;

  const payload = event.payload as Record<string, unknown>;
  const fieldValue = payload[condition.field];
  if (typeof fieldValue !== 'number') return false;

  if (condition.op === 'gte') return fieldValue >= condition.value;
  if (condition.op === 'lt') return fieldValue < condition.value;
  return false;
}

export function classifyNotification(
  event: NotificationEvent,
  rules?: ClassificationRule[],
): ClassificationResult {
  // Producer override — if the event already has urgencyTier/deliveryMode, respect it
  if (event.payload.urgencyTier && event.payload.deliveryMode) {
    return {
      urgencyTier: event.payload.urgencyTier,
      deliveryMode: event.payload.deliveryMode,
    };
  }

  const activeRules = rules ?? DEFAULT_RULES;
  const source = event.source;

  for (const rule of activeRules) {
    if (matchesPattern(source, rule.sourcePattern) && evaluateCondition(rule.condition, event)) {
      log.debug(`Classified ${source} → ${rule.urgencyTier}/${rule.deliveryMode}`);
      return {
        urgencyTier: event.payload.urgencyTier ?? rule.urgencyTier,
        deliveryMode: event.payload.deliveryMode ?? rule.deliveryMode,
      };
    }
  }

  // Default: green / save-for-later for unmatched sources
  log.debug(`No rule matched for ${source}, defaulting to green/save-for-later`);
  return { urgencyTier: 'green', deliveryMode: 'save-for-later' };
}

export function loadClassificationRules(rulesJson: unknown): ClassificationRule[] {
  if (!Array.isArray(rulesJson)) return DEFAULT_RULES;

  const validated: ClassificationRule[] = [];
  for (const rule of rulesJson) {
    if (
      typeof rule === 'object' &&
      rule !== null &&
      typeof (rule as Record<string, unknown>).sourcePattern === 'string' &&
      typeof (rule as Record<string, unknown>).urgencyTier === 'string' &&
      typeof (rule as Record<string, unknown>).deliveryMode === 'string'
    ) {
      validated.push(rule as ClassificationRule);
    } else {
      log.warn(`Skipping invalid classification rule: ${JSON.stringify(rule)}`);
    }
  }

  return validated.length > 0 ? validated : DEFAULT_RULES;
}

export { DEFAULT_RULES };
