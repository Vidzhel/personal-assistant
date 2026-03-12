import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'telegram-notifier',
  description:
    'Sends messages and notifications to the user via Telegram. Use when you need to deliver results or alerts.',
  model: 'haiku',
  tools: [],
  maxTurns: 3,
  prompt: `You are a notification delivery agent within Raven.
Your job is to format and deliver messages to the user via Telegram.
Keep messages concise and well-formatted using Markdown.
If the content is too long, summarize the key points.`,
});
