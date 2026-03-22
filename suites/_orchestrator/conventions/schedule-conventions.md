# Schedule Conventions

## Schedule Definition

```json
{
  "id": "unique-id",
  "name": "Human Readable Name",
  "cron": "0 8 * * *",
  "taskType": "task-type-name",
  "skillName": "suite-name",
  "enabled": true
}
```

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (UUID or descriptive kebab-case) |
| `name` | string | Yes | Human-readable schedule name |
| `cron` | string | Yes | Standard cron expression (5 fields) |
| `taskType` | string | Yes | Event/task type to trigger (kebab-case) |
| `skillName` | string | Yes | Must reference a registered suite name |
| `enabled` | boolean | Yes | Toggle schedule on/off |

## Cron Expression Patterns

| Expression | Meaning |
|-----------|---------|
| `0 8 * * *` | Daily at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `0 0 * * 0` | Weekly on Sunday midnight |
| `0 3 * * 1` | Weekly on Monday at 3:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 9,18 * * *` | Twice daily at 9 AM and 6 PM |

## Naming

- `name`: Human-readable, describes what runs (e.g. "Morning Digest", "Weekly Maintenance")
- `id`: Descriptive kebab-case or UUID (e.g. "morning-digest", "weekly-maintenance")
- `taskType`: kebab-case, should match a known event handler (e.g. "morning-digest", "maintenance:run")

## Pipeline Triggers vs Standalone Schedules

- **Pipeline cron triggers**: Use when the task involves a multi-step pipeline. The cron trigger is defined inside the pipeline YAML.
- **Standalone schedules**: Use for single-action recurring tasks that don't need pipeline orchestration.

Do not create both a pipeline trigger AND a standalone schedule for the same task.

## Lifecycle

- `enabled: true` — schedule is active and will fire
- `enabled: false` — schedule exists but won't fire (paused)
- Schedules can be toggled via API: `PATCH /api/schedules/:id`
- Manual trigger via API: `POST /api/schedules/:id/trigger`

## Timezone

All schedules use the system timezone (configured at scheduler initialization, default: `Europe/Kyiv`).

## Anti-Patterns

- Creating schedules with `skillName` that doesn't match a registered suite
- Overlapping schedules for the same task (use a single schedule with appropriate cron)
- Very frequent schedules (< 5 min interval) without good reason
- Missing `enabled` field (defaults may vary)
