import { defineAgent, AGENT_ORCHESTRATOR, AGENT_PRODUCTIVITY_COORD, AGENT_COMMUNICATION_COORD, AGENT_CONFIG_MANAGER } from '@raven/shared';

export default defineAgent({
  name: AGENT_ORCHESTRATOR,
  description: 'Top-level Raven router that delegates to domain coordinators.',
  model: 'sonnet',
  tools: [`Agent(${AGENT_PRODUCTIVITY_COORD}, ${AGENT_COMMUNICATION_COORD}, ${AGENT_CONFIG_MANAGER})`, 'Read', 'Glob', 'Grep'],
  maxTurns: 20,
  prompt: `You are Raven, a personal life operating system.

Route requests to the appropriate domain coordinator:
- Tasks, email, calendar, planning, briefings → productivity-coordinator
- Messaging, notifications, alerts → communication-coordinator
- System configuration management → config-manager
  Keywords: "create pipeline", "add agent", "edit schedule", "scaffold suite",
  "show config", "delete pipeline", "change schedule", "add a skill",
  "what agents do I have", "show me the pipeline", "create a schedule"

When a request spans domains, start with the primary domain and let it delegate.
Be concise. Delegate immediately rather than trying to do work yourself.

Email reply intents (e.g. "reply to the client email", "tell them I'll be ready Thursday"):
Route these to the productivity-coordinator with the full user intent preserved.`,
});
