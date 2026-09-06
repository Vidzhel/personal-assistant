# TickTick

Use the official TickTick MCP as the authoritative source for the owner's personal and work planning. Inspect the live tool schemas before constructing arguments. Use only tool names and fields that the connected server advertises.

## Find the right records

Begin with `list_projects` when the relevant project or list is not already identified. Use `get_project_with_undone_tasks` for every relevant list to understand its open workload, and inspect Inbox or otherwise unassigned tasks explicitly rather than assuming every task belongs to a returned project. Use `list_project_members` when membership or assignment context matters. Use `search_task`, `filter_tasks`, `get_task_by_id`, or `get_task_in_project` to resolve exact records. Preserve returned task, project, column, tag, habit, focus, countdown, comment, and member IDs and authoritative links.

Do not treat Today as the whole workload. A useful account-wide review covers every relevant project, Inbox or unassigned work, overdue work, and tasks without dates. Both `list_undone_tasks_by_time_query` and `list_undone_tasks_by_date` are limited to a 14-day date range, so split longer requested periods into bounded queries and state what was covered. Never describe a partial page, date window, project subset, or failed list read as a complete account result.

Resolve ambiguous names before making a change. When two tasks, projects, columns, or tags could match, show the identifying details and ask the owner which record they mean. Do not guess an ID from a title.

## Dates and workload

Interpret dates in the owner's configured timezone and follow the current tool schema for all-day values, timestamps, start dates, due dates, reminders, and recurrence. Preserve recurrence and unrelated scheduling fields unless the owner asked to change them. Explain any unsupported date or recurrence request instead of approximating it silently.

Keep habit check-in queries within 90 days. Keep each focus-record time query within one calendar month. Split a longer requested period into supported windows and report any window that could not be read.

When summarizing workload, distinguish scheduled, overdue, undated, completed, and unavailable records. Keep TickTick as the editable authority; Raven summaries or local task records are views of that data.

## Mutations

Before a mutation, read the exact target and retain its IDs. Send only the fields needed for the requested change so omitted or empty values do not erase unrelated content, dates, recurrence, assignments, tags, or list placement. `complete_tasks_in_project` accepts at most 20 tasks in one call; split larger requests and preserve per-call results. Respect every other batch limit in the connected schema. For a batch response, report each success and failure and never claim the whole batch succeeded from a partial result.

After creating, updating, moving, assigning, completing, commenting on, or deleting a record, read the affected record or containing project back when the service supports it. Report success only from the returned result or the read-back state. If a request times out or its result is uncertain, inspect TickTick before retrying; never blindly repeat a mutation that may already have succeeded.

Deletion tools are destructive and require explicit approval through Raven's permission boundary. Ordinary creates, updates, moves, assignments, completions, comments, habit check-ins, and focus records use their declared change tier. Reads do not mutate the account. An unfamiliar tool remains governed by Raven's conservative fallback rather than being assumed safe.

## Output

For conversational requests, answer concisely with names, dates, project/list context, and authoritative links where available. For a service that requests JSON, return exactly its documented envelope. Put coverage gaps and source failures inside that envelope's requested coverage or error fields; if a full result is unavailable, return an explicit partial JSON result rather than appending prose or inventing missing records. Never invent legacy tools such as `get_tasks` or `get_task_details`.
