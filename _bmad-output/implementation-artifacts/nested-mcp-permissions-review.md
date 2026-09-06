# Delegated MCP execution correction

The live TickTick parent connected and discovered tools, but the delegated agent
reported a strict-MCP warning and a generic user-refusal error. These were not an
owner rejection or failed TickTick authentication.

Inspection of the installed SDK 0.3.261 / CLI 2.1.261 established two causes:

- Child `mcpServers` declarations are rejected under strict configuration, while
  undeclared children inherit the already-connected parent clients. Child tool
  filtering still uses their explicit `tools` list.
- Background children cannot use interactive permission prompts. Raven's hook
  checked policy but returned no explicit allow decision, leaving approved reads
  dependent on that unavailable prompt path.

The backend now validates internal child MCP references against the task's parent
configuration, then omits only those redundant declarations at the SDK boundary.
Every child receives an explicit tool list, including an empty list when none was
supplied. Strict MCP configuration remains enabled. The pre-tool hook explicitly
allows MCP calls only after current ownership, lifetime, and Raven permission
policy approve them. Denied calls remain denied; native SDK permissions retain
their previous behavior. No new provider connection or secret-bearing child
configuration is introduced.

Independent SDK investigation reviewed both changes. Regression coverage checks
missing-binding rejection before SDK work, explicit child tool scope, policy-based
MCP allows, absent-policy behavior, existing denials, revocation and cancellation.

The first live retry exposed a second SDK ordering detail: a background date-query
call could be denied before reaching Raven's callback, despite a preceding
time-query call succeeding. Task-bound MCP server patterns now join SDK
`allowedTools` only when Raven permission dependencies are present; the mandatory
pre-tool hook still gates every call. A real SDK synthetic delegated canary
confirmed one read handler executed, one delete was denied by the hook, and the
delete handler was never invoked. The canary used no external mutation or owner
task data.

Further live HTTP checks showed that the CLI's default background mode still
denied external MCP calls before hooks. A foreground delegated HTTP read reached
the policy successfully. For queries with Raven subagents, the backend now sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: Raven's outer manager owns asynchronous
work and awaits the SDK children. This also disables SDK-level background Bash
tasks for those queries. Setting child `background:false` alone does not override
the CLI default; binary inspection confirmed the environment switch does.

Final permission verification: required checks and the core image build passed;
the default suite passed 2,679 tests across 267 files. The foreground Planning
retry executed both `list_undone_tasks_by_time_query` and
`list_undone_tasks_by_date` through its delegated agent, with successful tool
results and `executed` audit records. A separate `get_user_preference` call was
correctly queued as an unknown action; its newly inspected official schema is a
read-only timezone lookup and is handled in a subsequent capability update.

After that capability update, a fresh Planning conversation delegated all three
reads (`get_user_preference`, `list_undone_tasks_by_time_query`, and
`list_undone_tasks_by_date`) and completed with zero tool errors. Core, web and
Neo4j health checks passed. The capability update passed the required check,
19 deployment tests, 27 permission-policy tests and library validation. Task
contents were not copied into development logs or this record.
