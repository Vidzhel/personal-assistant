import type { EmailTriageRule } from '@raven/shared';

export interface EmailPayload {
  from: string;
  subject: string;
  snippet: string;
  messageId: string;
  receivedAt: number;
}

export interface MatchResult {
  ruleName: string;
  matchedConditions: string[];
  actions: EmailTriageRule['actions'];
}

function matchesPatterns(value: string, patterns: string[]): string[] {
  const matched: string[] = [];
  const lower = value.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      matched.push(pattern);
    }
  }
  return matched;
}

// Keywords use OR logic: matches if ANY keyword is found in from/subject/snippet
function matchesKeywords(email: EmailPayload, keywords: string[]): string[] {
  const matched: string[] = [];
  const combined = `${email.from} ${email.subject} ${email.snippet}`.toLowerCase();
  for (const keyword of keywords) {
    if (combined.includes(keyword.toLowerCase())) {
      matched.push(keyword);
    }
  }
  return matched;
}

function evaluateRule(email: EmailPayload, rule: EmailTriageRule): MatchResult | null {
  if (rule.enabled === false) return null;

  const matchedConditions: string[] = [];

  if (rule.match.from && rule.match.from.length > 0) {
    const fromMatches = matchesPatterns(email.from, rule.match.from);
    if (fromMatches.length === 0) return null;
    matchedConditions.push(...fromMatches.map((m) => `from:${m}`));
  }

  if (rule.match.subject && rule.match.subject.length > 0) {
    const subjectMatches = matchesPatterns(email.subject, rule.match.subject);
    if (subjectMatches.length === 0) return null;
    matchedConditions.push(...subjectMatches.map((m) => `subject:${m}`));
  }

  if (rule.match.has && rule.match.has.length > 0) {
    const keywordMatches = matchesKeywords(email, rule.match.has);
    if (keywordMatches.length === 0) return null;
    matchedConditions.push(...keywordMatches.map((m) => `has:${m}`));
  }

  if (matchedConditions.length === 0) return null;

  return {
    ruleName: rule.name,
    matchedConditions,
    actions: rule.actions,
  };
}

export function matchRules(
  email: EmailPayload,
  rules: EmailTriageRule[],
  matchMode: 'first' | 'all' = 'all',
): MatchResult[] {
  const sorted = [...rules].sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10));
  const results: MatchResult[] = [];

  for (const rule of sorted) {
    const result = evaluateRule(email, rule);
    if (result) {
      results.push(result);
      if (matchMode === 'first') break;
    }
  }

  return results;
}
