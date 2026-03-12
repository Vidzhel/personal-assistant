import { defineAgent, AGENT_COMMUNICATION_COORD, AGENT_TELEGRAM } from '@raven/shared';

export default defineAgent({
  name: AGENT_COMMUNICATION_COORD,
  description: 'Coordinates messaging and notification delivery.',
  model: 'sonnet',
  tools: [`Agent(${AGENT_TELEGRAM})`, 'Read', 'Grep'],
  maxTurns: 10,
  prompt: `You coordinate communication and notification workflows within Raven.
- Send messages and notifications → telegram-notifier

Format messages appropriately for the target channel.
Keep notifications concise and actionable.`,
});
