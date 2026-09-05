# Raven — Claude Development Entry Point

@AGENTS.md

Read [AGENTS.md](AGENTS.md) as the shared development guide for Claude and Codex.
It owns architecture rules, capability boundaries, commands, testing requirements
and change discipline. Read [ARCHITECTURE.md](ARCHITECTURE.md) for runtime wiring and
the [completion record](_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
for current work and evidence. March and August plans are historical context.

## Claude workflow

- Keep using the existing `.claude/` development skills, agents and local settings;
  the shared guide does not replace that tooling. Raven runtime definitions in
  `library/` are distinct from Claude's development configuration.
- Claude handles implementation, review and session handoff. When the owner or
  established session workflow authorizes publication, commit meaningful changes
  with descriptive messages and push to preserve that work across sessions.
  Scope staging to the task and preserve unrelated changes. A read-only review
  or an explicit no-Git instruction takes precedence.
- This project is developed on Linux/WSL2 with Docker available. Do not assume
  Windows desktop integrations or authenticated accounts are available to tests.
- Raven continues to execute models through `@anthropic-ai/claude-agent-sdk`.
  The owner's normal setup uses Claude CLI authentication; adding Codex support
  changes the development workflow, not the runtime provider or account.

Use the shared guide's isolated verification commands before declaring work
complete. Do not start the owner's assistant just to verify a documentation change.
