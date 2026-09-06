import { ModelConfigSchema, type ModelCatalogSnapshot, type ModelConfig } from '@raven/shared';

const MODEL_COMMAND_RE = /^\/model(?:@[a-z0-9_]+)?(?:\s+(.+))?$/i;
const MAX_MODEL_STATUS_LENGTH = 3_800;
const MAX_MODEL_ARGUMENTS = 3;
const TRUNCATION_SUFFIX = '\n…more choices are available in Raven Settings.';

export type TelegramModelCommand =
  | { matched: false }
  | { matched: true; action: 'show' }
  | { matched: true; action: 'reset' }
  | { matched: true; action: 'set'; config: ModelConfig }
  | { matched: true; action: 'invalid'; error: string };

export function parseTelegramModelCommand(text: string): TelegramModelCommand {
  const match = MODEL_COMMAND_RE.exec(text.trim());
  if (!match) return { matched: false };
  const args = match[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (args.length === 0) return { matched: true, action: 'show' };
  return parseModelArguments(args);
}

function parseModelArguments(args: string[]): TelegramModelCommand {
  if (args[0].toLowerCase() === 'default') {
    return args.length === 1
      ? { matched: true, action: 'reset' }
      : invalidModelCommand('The default reset does not accept effort or thinking options.');
  }
  if (args.length > MAX_MODEL_ARGUMENTS) return invalidModelCommand('Too many model options.');
  if (args[2] && ['adaptive', 'disabled'].includes(args[1]?.toLowerCase())) {
    return invalidModelCommand('Specify thinking once, after an optional effort level.');
  }

  const parsed = ModelConfigSchema.safeParse(modelConfigInput(args));
  if (!parsed.success)
    return invalidModelCommand('The model, effort, or thinking option is invalid.');
  return { matched: true, action: 'set', config: parsed.data };
}

function modelConfigInput(args: string[]): Record<string, string> {
  const config: Record<string, string> = { model: args[0] };
  const second = args[1]?.toLowerCase();
  const third = args[2]?.toLowerCase();
  if (second === 'adaptive' || second === 'disabled') config.thinking = second;
  else if (second) config.effort = second;
  if (third) config.thinking = third;
  return config;
}

export function formatTelegramModelStatus(params: {
  sessionId?: string;
  effective?: ModelConfig & { model: string };
  snapshot: ModelCatalogSnapshot;
}): string {
  const lines = params.sessionId
    ? [`Current Raven session: ${params.sessionId}`]
    : ['No Raven session is selected. Send a message or use /new to start one.'];
  if (params.effective) {
    lines.push(
      `Effective model: ${params.effective.model}`,
      `Effort: ${params.effective.effort ?? 'provider default'}`,
      `Thinking: ${params.effective.thinking ?? 'provider default'}`,
    );
  }
  lines.push('', ...formatCatalogLines(params.snapshot));
  lines.push(
    '',
    'Set the session for future turns: /model <id> [effort] [adaptive|disabled]',
    'Clear the session override: /model default',
    'Work already running keeps its captured model settings.',
  );
  return truncateStatus(lines.join('\n'));
}

export const TELEGRAM_MODEL_COMMAND_USAGE =
  'Use /model <id> [low|medium|high|xhigh|max] [adaptive|disabled], or /model default.';

function invalidModelCommand(error: string): TelegramModelCommand {
  return { matched: true, action: 'invalid', error: `${error}\n${TELEGRAM_MODEL_COMMAND_USAGE}` };
}

function formatCatalogLines(snapshot: ModelCatalogSnapshot): string[] {
  const lines = ['Reported model choices:'];
  if (snapshot.models.length === 0) lines.push('No model choices are currently available.');
  for (const model of snapshot.models) {
    const aliases = model.aliases.length > 0 ? ` (aliases: ${model.aliases.join(', ')})` : '';
    const thinking = model.mandatoryThinking ? ' [adaptive thinking required]' : '';
    lines.push(`• ${model.displayName}: ${model.id}${aliases}${thinking}`);
  }
  if (snapshot.stale) lines.push('Catalog status: stale');
  if (snapshot.error) lines.push(`Catalog error: ${snapshot.error}`);
  return lines;
}

function truncateStatus(status: string): string {
  if (status.length <= MAX_MODEL_STATUS_LENGTH) return status;
  return `${status.slice(0, MAX_MODEL_STATUS_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}
