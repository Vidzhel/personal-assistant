const DEFAULT_MAX_INPUT_LENGTH = 65_536;
const SECRET_ASSIGNMENT = /(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*\S+/gi;
const AUTH_BEARER = /(authorization|token)\s*[:=]\s*bearer\s+\S+/gi;
const BEARER_VALUE = /bearer\s+\S+/gi;
const ANTHROPIC_KEY = /sk-ant-[a-zA-Z0-9_-]+/g;
const TELEGRAM_BOT_KEY = /bot\d+:[A-Za-z0-9_-]+/g;
const JSON_SECRET =
  /(["'])([a-z0-9_-]*(?:authorization|api[-_ ]?key|token|password|secret)[a-z0-9_-]*)\1\s*:\s*(["'])(?:\\.|(?!\3)[\s\S])*(?:\3|$)/gi;
const QUOTED_SECRET_ASSIGNMENT =
  /(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*(["'])(?:\\.|(?!\2)[\s\S])*(?:\2|$)/gi;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@]+@/gi;

export interface SecretRedactionOptions {
  maxInputLength?: number;
  maxOutputLength?: number;
}

export function redactSecrets(value: unknown, options: SecretRedactionOptions = {}): string {
  const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  const raw = (value instanceof Error ? value.message : String(value)).slice(0, maxInputLength);
  const sanitized = raw
    .replace(ANTHROPIC_KEY, '[redacted]')
    .replace(TELEGRAM_BOT_KEY, 'bot[redacted]')
    .replace(JSON_SECRET, '$1$2$1:$3[redacted]$3')
    .replace(QUOTED_SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(AUTH_BEARER, '$1=[redacted]')
    .replace(BEARER_VALUE, 'Bearer [redacted]')
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]');
  const maxOutputLength = options.maxOutputLength;
  if (maxOutputLength === undefined || sanitized.length <= maxOutputLength) return sanitized;
  if (maxOutputLength <= 0) return '';
  return `${sanitized.slice(0, Math.max(0, maxOutputLength - 1))}…`;
}
