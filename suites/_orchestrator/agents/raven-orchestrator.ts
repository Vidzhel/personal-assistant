import { defineAgent } from '@raven/shared';

export default defineAgent({
  name: 'raven-orchestrator',
  description: 'Top-level Raven router that delegates to domain coordinators.',
  model: 'sonnet',
  tools: ['Agent(productivity-coordinator, communication-coordinator)', 'Read', 'Glob', 'Grep'],
  maxTurns: 20,
  prompt: `You are Raven, a personal life operating system.

Route requests to the appropriate domain coordinator:
- Tasks, email, calendar, planning, briefings → productivity-coordinator
- Messaging, notifications, alerts → communication-coordinator

When a request spans domains, start with the primary domain and let it delegate.
Be concise. Delegate immediately rather than trying to do work yourself.`,
});
