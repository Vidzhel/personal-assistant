import { describe, it, expect } from 'vitest';
import { matchRules, type EmailPayload } from '../services/rule-matcher.ts';
import type { EmailTriageRule } from '@raven/shared';

function makeEmail(overrides: Partial<EmailPayload> = {}): EmailPayload {
  return {
    from: 'sender@example.com',
    subject: 'Test Subject',
    snippet: 'Test snippet content',
    messageId: 'msg-001',
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeRule(overrides: Partial<EmailTriageRule> = {}): EmailTriageRule {
  return {
    name: 'test-rule',
    match: {},
    actions: {},
    enabled: true,
    priority: 10,
    ...overrides,
  };
}

describe('rule-matcher', () => {
  describe('from matching', () => {
    it('matches sender containing pattern', () => {
      const email = makeEmail({ from: 'John <noreply@service.com>' });
      const rules = [makeRule({ name: 'noreply', match: { from: ['noreply@'] }, actions: { archive: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
      expect(results[0].ruleName).toBe('noreply');
      expect(results[0].matchedConditions).toContain('from:noreply@');
      expect(results[0].actions.archive).toBe(true);
    });

    it('matches case-insensitively', () => {
      const email = makeEmail({ from: 'NoReply@SERVICE.COM' });
      const rules = [makeRule({ name: 'noreply', match: { from: ['noreply@'] }, actions: { archive: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
    });

    it('returns empty when from pattern does not match', () => {
      const email = makeEmail({ from: 'user@company.com' });
      const rules = [makeRule({ match: { from: ['noreply@'] } })];

      expect(matchRules(email, rules)).toHaveLength(0);
    });
  });

  describe('subject matching', () => {
    it('matches subject containing pattern', () => {
      const email = makeEmail({ subject: 'Weekly Newsletter: Top Stories' });
      const rules = [makeRule({ name: 'newsletter', match: { subject: ['newsletter'] }, actions: { markRead: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
      expect(results[0].matchedConditions).toContain('subject:newsletter');
    });

    it('returns empty when subject does not match', () => {
      const email = makeEmail({ subject: 'Important meeting' });
      const rules = [makeRule({ match: { subject: ['newsletter'] } })];

      expect(matchRules(email, rules)).toHaveLength(0);
    });
  });

  describe('keyword (has) matching', () => {
    it('matches keyword in from field', () => {
      const email = makeEmail({ from: 'noreply@service.com' });
      const rules = [makeRule({ name: 'auto', match: { has: ['noreply'] }, actions: { archive: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
      expect(results[0].matchedConditions).toContain('has:noreply');
    });

    it('matches keyword in subject', () => {
      const email = makeEmail({ subject: 'Click to unsubscribe from updates' });
      const rules = [makeRule({ name: 'unsub', match: { has: ['unsubscribe'] }, actions: { archive: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
    });

    it('matches keyword in snippet', () => {
      const email = makeEmail({ snippet: 'This is an automated message' });
      const rules = [makeRule({ name: 'auto', match: { has: ['automated'] }, actions: { markRead: true } })];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
    });

    it('matches when any has keyword is found (OR logic)', () => {
      const email = makeEmail({ from: 'noreply@svc.com', snippet: 'hello world' });
      const rules = [makeRule({ name: 'multi', match: { has: ['noreply', 'automated'] } })];

      // 'noreply' found in from, 'automated' not found — OR logic means this matches
      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
      expect(results[0].matchedConditions).toContain('has:noreply');
    });
  });

  describe('combined conditions', () => {
    it('requires all condition groups to match (AND logic)', () => {
      const email = makeEmail({ from: 'noreply@svc.com', subject: 'Alert: server down' });
      const rules = [
        makeRule({
          name: 'strict',
          match: { from: ['noreply@'], subject: ['alert'] },
          actions: { archive: true },
        }),
      ];

      const results = matchRules(email, rules);

      expect(results).toHaveLength(1);
      expect(results[0].matchedConditions).toEqual(
        expect.arrayContaining(['from:noreply@', 'subject:alert']),
      );
    });

    it('fails when one condition group does not match', () => {
      const email = makeEmail({ from: 'noreply@svc.com', subject: 'Hello world' });
      const rules = [
        makeRule({
          name: 'strict',
          match: { from: ['noreply@'], subject: ['alert'] },
          actions: { archive: true },
        }),
      ];

      expect(matchRules(email, rules)).toHaveLength(0);
    });
  });

  describe('match modes', () => {
    const rules = [
      makeRule({ name: 'rule-a', priority: 1, match: { from: ['@example.com'] }, actions: { label: 'urgent' } }),
      makeRule({ name: 'rule-b', priority: 2, match: { from: ['@example.com'] }, actions: { archive: true } }),
    ];
    const email = makeEmail({ from: 'user@example.com' });

    it('all mode returns all matching rules', () => {
      const results = matchRules(email, rules, 'all');

      expect(results).toHaveLength(2);
      expect(results[0].ruleName).toBe('rule-a');
      expect(results[1].ruleName).toBe('rule-b');
    });

    it('first mode returns only first matching rule', () => {
      const results = matchRules(email, rules, 'first');

      expect(results).toHaveLength(1);
      expect(results[0].ruleName).toBe('rule-a');
    });
  });

  describe('priority sorting', () => {
    it('sorts rules by priority ascending (lower = higher priority)', () => {
      const rules = [
        makeRule({ name: 'low-pri', priority: 10, match: { from: ['@test.com'] }, actions: { markRead: true } }),
        makeRule({ name: 'high-pri', priority: 1, match: { from: ['@test.com'] }, actions: { label: 'urgent' } }),
      ];
      const email = makeEmail({ from: 'user@test.com' });

      const results = matchRules(email, rules, 'all');

      expect(results[0].ruleName).toBe('high-pri');
      expect(results[1].ruleName).toBe('low-pri');
    });
  });

  describe('disabled rules', () => {
    it('skips disabled rules', () => {
      const rules = [
        makeRule({ name: 'disabled', enabled: false, match: { from: ['@test.com'] }, actions: { archive: true } }),
      ];
      const email = makeEmail({ from: 'user@test.com' });

      expect(matchRules(email, rules)).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty for no rules', () => {
      expect(matchRules(makeEmail(), [])).toHaveLength(0);
    });

    it('returns empty when no conditions match any rule', () => {
      const rules = [makeRule({ match: { from: ['@special.com'] } })];
      expect(matchRules(makeEmail(), rules)).toHaveLength(0);
    });

    it('returns empty for rule with empty match object', () => {
      const rules = [makeRule({ match: {} })];
      expect(matchRules(makeEmail(), rules)).toHaveLength(0);
    });

    it('handles empty from/subject arrays', () => {
      const rules = [makeRule({ match: { from: [], subject: [] } })];
      expect(matchRules(makeEmail(), rules)).toHaveLength(0);
    });
  });
});
