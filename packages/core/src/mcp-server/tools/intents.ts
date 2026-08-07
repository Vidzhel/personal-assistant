import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';
import { MATCHED_EVENT_TYPES } from '../../intents/intent-matcher.ts';

type OkResult = { content: [{ type: 'text'; text: string }] };
type ErrResult = { content: [{ type: 'text'; text: string }]; isError: true };

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DAY_MS = 86_400_000;

interface CreateIntentArgs {
  kind: 'event' | 'time';
  message: string;
  keywords?: string[];
  eventTypes?: (typeof MATCHED_EVENT_TYPES)[number][];
  fireAt?: string;
  fireBudget?: number;
  cooldownHours?: number;
  expiresInDays?: number;
}

/** Validates the owner's-explicit-ask shape before it ever reaches the
 * store: kind="event" needs both keywords and eventTypes (else it could
 * never match anything); kind="time" needs a target fireAt. Returns an error
 * message, or undefined when the args are shaped correctly. */
function validateCreateIntentArgs(args: CreateIntentArgs): string | undefined {
  if (args.kind === 'event') {
    if (!args.keywords || args.keywords.length === 0) {
      return 'kind="event" requires at least one keyword';
    }
    if (!args.eventTypes || args.eventTypes.length === 0) {
      return 'kind="event" requires at least one eventType to watch';
    }
    return undefined;
  }
  if (!args.fireAt) return 'kind="time" requires fireAt';
  return undefined;
}

/**
 * Intents: deterministic prospective memory — "remind me when X happens" /
 * "remind me at TIME" — compiled from the owner's EXPLICIT ask, never
 * inferred speculatively by the model. Every fire is a plain keyword/time
 * match with a fire budget, cooldown, and expiry enforced atomically in
 * intent-store.ts; there is no model call in the fire path (see
 * intents/intent-matcher.ts). Deliberately no update/edit tool — cancel and
 * re-create is simpler than a partial-patch surface for something this small.
 */
// eslint-disable-next-line max-lines-per-function -- builds three intent tools (create/list/cancel)
export function buildIntentTools(
  deps: RavenMcpDeps,
  scope: ScopeContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure at heterogeneous tool collection (see scaffold.ts's comment)
): Array<SdkMcpToolDefinition<any>> {
  const createIntent = tool(
    'create_intent',
    'Create a deterministic reminder for something the OWNER explicitly asked for — e.g. "remind me when the invoice email arrives" (kind: event) or "remind me at 5pm to call the bank" (kind: time). Compile ONLY what the owner actually said; never invent a reminder they did not ask for. kind="event" needs keywords (ALL must appear, case-insensitive) AND eventTypes to watch. kind="time" needs fireAt. This is plain keyword/time matching with a fire budget and cooldown — no model is consulted when it fires.',
    {
      kind: z
        .enum(['event', 'time'])
        .describe('"event" watches for matching events; "time" fires once at a target time'),
      message: z
        .string()
        .min(1)
        .describe('The reminder text to deliver to the owner when this fires'),
      keywords: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'kind="event" only: ALL of these must appear (case-insensitive) in the triggering event',
        ),
      eventTypes: z
        .array(z.enum(MATCHED_EVENT_TYPES))
        .optional()
        .describe('kind="event" only: which event types to watch'),
      fireAt: z.iso
        .datetime()
        .optional()
        .describe('kind="time" only: ISO 8601 timestamp of the one-shot target fire time'),
      fireBudget: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Max number of times this can fire before going "exhausted" (default: 1 for time, 3 for event)',
        ),
      cooldownHours: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Minimum hours between fires (default 24) — anti-nagging, not a delivery delay'),
      expiresInDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Days until this intent auto-expires if unused (default 90)'),
    },
    async (args) => {
      if (!deps.intentStore) return errorResult('intentStore not available');

      const validationError = validateCreateIntentArgs(args);
      if (validationError) return errorResult(validationError);

      try {
        const intent = deps.intentStore.create({
          kind: args.kind,
          keywords: args.keywords,
          eventTypes: args.eventTypes,
          nextFireAt: args.fireAt ? new Date(args.fireAt).getTime() : undefined,
          message: args.message,
          fireBudget: args.fireBudget,
          cooldownHours: args.cooldownHours,
          expiresAt: args.expiresInDays ? Date.now() + args.expiresInDays * DAY_MS : undefined,
          sourceSession: scope.sessionId,
        });
        return okResult({ id: intent.id, kind: intent.kind, status: intent.status });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    },
  );

  const listIntents = tool(
    'list_intents',
    'List the owner\'s intents (deterministic reminders), optionally filtered by status. Use to check what reminders are currently active before creating a duplicate, or to answer "what reminders do I have".',
    {
      status: z.enum(['active', 'exhausted', 'expired', 'cancelled']).optional(),
    },
    async (args) => {
      if (!deps.intentStore) return errorResult('intentStore not available');
      const intents = deps.intentStore.list(args.status ? { status: args.status } : undefined);
      return okResult(intents);
    },
  );

  const cancelIntent = tool(
    'cancel_intent',
    'Cancel an active intent (deterministic reminder) by id — use when the owner asks to stop a reminder ("never mind that reminder", "cancel it").',
    {
      id: z.string().min(1),
    },
    async (args) => {
      if (!deps.intentStore) return errorResult('intentStore not available');
      const cancelled = deps.intentStore.cancel(args.id);
      if (!cancelled) return errorResult(`Intent "${args.id}" not found or not active`);
      return okResult({ id: args.id, status: 'cancelled' });
    },
  );

  return [createIntent, listIntents, cancelIntent];
}
