import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'communication-coordinator',
  description: 'Coordinates messaging and notification delivery.',
  model: 'sonnet',
  tools: ['Agent(telegram-notifier)', 'Read', 'Grep'],
  maxTurns: 10,
  prompt: `You coordinate communication and notification workflows within Raven.
- Send messages and notifications → telegram-notifier

Format messages appropriately for the target channel.
Keep notifications concise and actionable.`,
});
