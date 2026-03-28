# Services

Long-running background processes. These are started by the ServiceRunner
at boot time and run continuously.

Services are NOT skills — they don't have prompts or MCP bindings.
They are background processes (IMAP watchers, Telegram bots, schedulers).

Service migration from suites/ will happen in Phase 2.
