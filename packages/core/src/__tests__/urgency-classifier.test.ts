import { describe, it, expect } from 'vitest';
import { classifyNotification, DEFAULT_RULES } from '../notification-engine/urgency-classifier.ts';
import type { NotificationEvent } from '@raven/shared';

function makeNotifEvent(
  source: string,
  overrides?: Partial<NotificationEvent['payload']>,
): NotificationEvent {
  return {
    id: 'test-id',
    timestamp: Date.now(),
    source,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: 'Test',
      body: 'Test body',
      ...overrides,
    },
  };
}

describe('urgency-classifier', () => {
  describe('default rules', () => {
    it('classifies permission:blocked as red/tell-now', () => {
      const result = classifyNotification(makeNotifEvent('permission:blocked'));
      expect(result).toEqual({ urgencyTier: 'red', deliveryMode: 'tell-now' });
    });

    it('classifies system:health:alert as red/tell-now', () => {
      const result = classifyNotification(makeNotifEvent('system:health:alert'));
      expect(result).toEqual({ urgencyTier: 'red', deliveryMode: 'tell-now' });
    });

    it('classifies insight:generated with high confidence as yellow/tell-when-active', () => {
      const event = makeNotifEvent('insight:generated');
      (event.payload as any).confidence = 0.9;
      const result = classifyNotification(event);
      expect(result).toEqual({ urgencyTier: 'yellow', deliveryMode: 'tell-when-active' });
    });

    it('classifies insight:generated with low confidence as green/save-for-later', () => {
      const event = makeNotifEvent('insight:generated');
      (event.payload as any).confidence = 0.5;
      const result = classifyNotification(event);
      expect(result).toEqual({ urgencyTier: 'green', deliveryMode: 'save-for-later' });
    });

    it('classifies agent:task:complete as yellow/tell-when-active', () => {
      const result = classifyNotification(makeNotifEvent('agent:task:complete'));
      expect(result).toEqual({ urgencyTier: 'yellow', deliveryMode: 'tell-when-active' });
    });

    it('classifies pipeline:complete as green/save-for-later', () => {
      const result = classifyNotification(makeNotifEvent('pipeline:complete'));
      expect(result).toEqual({ urgencyTier: 'green', deliveryMode: 'save-for-later' });
    });

    it('classifies pipeline:failed as yellow/tell-when-active', () => {
      const result = classifyNotification(makeNotifEvent('pipeline:failed'));
      expect(result).toEqual({ urgencyTier: 'yellow', deliveryMode: 'tell-when-active' });
    });

    it('classifies email:triage:processed as green/save-for-later', () => {
      const result = classifyNotification(makeNotifEvent('email:triage:processed'));
      expect(result).toEqual({ urgencyTier: 'green', deliveryMode: 'save-for-later' });
    });

    it('classifies unknown sources as green/save-for-later', () => {
      const result = classifyNotification(makeNotifEvent('some:random:source'));
      expect(result).toEqual({ urgencyTier: 'green', deliveryMode: 'save-for-later' });
    });
  });

  describe('producer override', () => {
    it('respects urgencyTier and deliveryMode when both are set in payload', () => {
      const event = makeNotifEvent('pipeline:complete', {
        urgencyTier: 'red',
        deliveryMode: 'tell-now',
      });
      const result = classifyNotification(event);
      expect(result).toEqual({ urgencyTier: 'red', deliveryMode: 'tell-now' });
    });

    it('uses rule-based tier when only urgencyTier is set in payload', () => {
      const event = makeNotifEvent('pipeline:complete', {
        urgencyTier: 'yellow',
      });
      const result = classifyNotification(event);
      // source matches pipeline:complete rule → green/save-for-later, but urgencyTier override → yellow
      expect(result.urgencyTier).toBe('yellow');
      expect(result.deliveryMode).toBe('save-for-later');
    });

    it('uses rule-based mode when only deliveryMode is set in payload', () => {
      const event = makeNotifEvent('pipeline:complete', {
        deliveryMode: 'tell-now',
      });
      const result = classifyNotification(event);
      expect(result.urgencyTier).toBe('green');
      expect(result.deliveryMode).toBe('tell-now');
    });
  });

  describe('custom rules', () => {
    it('uses custom rules when provided', () => {
      const customRules = [
        {
          sourcePattern: 'custom:event',
          urgencyTier: 'red' as const,
          deliveryMode: 'tell-now' as const,
        },
      ];
      const result = classifyNotification(makeNotifEvent('custom:event'), customRules);
      expect(result).toEqual({ urgencyTier: 'red', deliveryMode: 'tell-now' });
    });

    it('falls back to default when no custom rule matches', () => {
      const customRules = [
        {
          sourcePattern: 'custom:event',
          urgencyTier: 'red' as const,
          deliveryMode: 'tell-now' as const,
        },
      ];
      const result = classifyNotification(makeNotifEvent('other:event'), customRules);
      expect(result).toEqual({ urgencyTier: 'green', deliveryMode: 'save-for-later' });
    });
  });

  it('DEFAULT_RULES is exported and non-empty', () => {
    expect(DEFAULT_RULES.length).toBeGreaterThan(0);
  });
});
