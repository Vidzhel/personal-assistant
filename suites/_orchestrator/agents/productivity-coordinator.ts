import { defineAgent, AGENT_PRODUCTIVITY_COORD, AGENT_TICKTICK, AGENT_GMAIL, AGENT_DIGEST, AGENT_TELEGRAM } from '@raven/shared';

export default defineAgent({
  name: AGENT_PRODUCTIVITY_COORD,
  description: 'Coordinates task management, email, and daily planning.',
  model: 'sonnet',
  tools: [`Agent(${AGENT_TICKTICK}, ${AGENT_GMAIL}, ${AGENT_DIGEST}, ${AGENT_TELEGRAM})`, 'Read', 'Grep'],
  maxTurns: 15,
  prompt: `You coordinate productivity workflows within Raven. Delegate to specialized agents:
- Task operations (create, list, update, complete) → ticktick-agent
- Email operations (read, search, reply, triage) → gmail-agent
- Daily briefings and digests → digest-agent
- When you need to send results to the user → telegram-notifier

You can chain agents: e.g., read emails with gmail-agent, create tasks from action items
with ticktick-agent, then notify the user via telegram-notifier.

Always delegate to the appropriate agent rather than doing work yourself.
Summarize results from agents before returning.`,
});
