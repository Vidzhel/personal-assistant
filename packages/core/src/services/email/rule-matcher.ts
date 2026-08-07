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

// Evaluates a single match group (from/subject/has): returns `[]` when the rule
// doesn't declare that condition (skip), `null` when it's declared but nothing
// matched (whole rule fails), or the tagged matches on success.
function collectMatchedConditions(
  patterns: string[] | undefined,
  prefix: string,
  matcher: (patterns: string[]) => string[],
): string[] | null {
  if (!patterns || patterns.length === 0) return [];
  const matches = matcher(patterns);
  if (matches.length === 0) return null;
  return matches.map((m) => `${prefix}:${m}`);
}

function evaluateRule(email: EmailPayload, rule: EmailTriageRule): MatchResult | null {
  if (rule.enabled === false) return null;

  const matchedConditions: string[] = [];

  const fromMatches = collectMatchedConditions(rule.match.from, 'from', (patterns) =>
    matchesPatterns(email.from, patterns),
  );
  if (fromMatches === null) return null;
  matchedConditions.push(...fromMatches);

  const subjectMatches = collectMatchedConditions(rule.match.subject, 'subject', (patterns) =>
    matchesPatterns(email.subject, patterns),
  );
  if (subjectMatches === null) return null;
  matchedConditions.push(...subjectMatches);

  const hasMatches = collectMatchedConditions(rule.match.has, 'has', (patterns) =>
    matchesKeywords(email, patterns),
  );
  if (hasMatches === null) return null;
  matchedConditions.push(...hasMatches);

  if (matchedConditions.length === 0) return null;

  return {
    ruleName: rule.name,
    matchedConditions,
    actions: rule.actions,
  };
}

const DEFAULT_RULE_PRIORITY = 10;

export function matchRules(
  email: EmailPayload,
  rules: EmailTriageRule[],
  matchMode: 'first' | 'all' = 'all',
): MatchResult[] {
  const sorted = [...rules].sort(
    (a, b) => (a.priority ?? DEFAULT_RULE_PRIORITY) - (b.priority ?? DEFAULT_RULE_PRIORITY),
  );
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
