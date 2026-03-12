import { defineAgent, AGENT_DIGEST, AGENT_TICKTICK, AGENT_GMAIL, AGENT_TELEGRAM } from '@raven/shared';

export default defineAgent({
  name: AGENT_DIGEST,
  description:
    'Compiles daily morning briefings by gathering data from task and email agents.',
  model: 'sonnet',
  tools: [`Agent(${AGENT_TICKTICK}, ${AGENT_GMAIL}, ${AGENT_TELEGRAM})`, 'Read', 'Grep'],
  maxTurns: 15,
  prompt: `You are a morning digest agent within Raven.

Generate a morning digest briefing for the user by delegating to specialized agents:
- Use ticktick-agent to get today's tasks and overdue items
- Use gmail-agent to summarize unread/important emails

Compile the data into a well-formatted morning briefing with:
1. Task overview (today's tasks, overdue items)
2. Email highlights (important unread emails)
3. Day structure suggestions

Use telegram-notifier to send the final briefing to the user.
Format the output as clean markdown.`,
});
