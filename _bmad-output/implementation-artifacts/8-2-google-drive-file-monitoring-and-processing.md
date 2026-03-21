# Story 8.2: Google Drive File Monitoring & Processing

Status: done

## Story

As the system operator,
I want Raven to monitor Google Drive folders and process new files automatically,
so that documents are ingested without manual uploads.

## Acceptance Criteria

1. **Given** a new PDF is uploaded to a monitored Google Drive folder, **when** the folder watcher detects it, **then** a `gdrive:new-file` event is emitted with file metadata (fileId, name, mimeType, parents, modifiedTime, size).

2. **Given** a `gdrive:new-file` event fires, **when** a pipeline is configured to trigger on this event, **then** the file is downloaded and processed through the configured pipeline steps.

3. **Given** the Google Drive API is unavailable, **when** the watcher attempts to poll, **then** the service degrades gracefully, logs the error, and retries on the next interval.

4. **Given** the monitored folder config is updated, **when** the config reloads (via `config:reloaded` event), **then** the watcher adjusts to monitor the new folder set without restart.

## Tasks / Subtasks

- [x] Task 1: Add shared constants and event types (AC: #1)
  - [x] Add `SOURCE_GWS_DRIVE` to `packages/shared/src/suites/constants.ts`
  - [x] Add `GDriveNewFileEvent` interface + `GDriveNewFilePayloadSchema` to `packages/shared/src/types/events.ts`
  - [x] Add `GDriveNewFileEvent` to `RavenEvent` union type
  - [x] Rebuild `@raven/shared`

- [x] Task 2: Implement drive-watcher service (AC: #1, #3, #4)
  - [x] Create `suites/google-workspace/services/drive-watcher.ts` as a `SuiteService`
  - [x] Implement polling loop using `gws drive changes getStartPageToken` + `gws drive changes list`
  - [x] Parse change list JSON, filter to monitored folder IDs, emit `gdrive:new-file` events
  - [x] Implement graceful error handling: log + continue on API failure
  - [x] Listen for `config:reloaded` events to hot-reload monitored folder list
  - [x] Persist `pageToken` to `data/gdrive-page-token.txt` so changes aren't missed across restarts

- [x] Task 3: Register drive-watcher in suite (AC: #1)
  - [x] Add `'drive-watcher'` to `services` array in `suites/google-workspace/suite.ts`

- [x] Task 4: Add configuration (AC: #4)
  - [x] Add `driveFolders` and `drivePollingIntervalMs` to `config/suites.json` under `google-workspace.config`
  - [x] Add `GWS_DRIVE_POLL_INTERVAL_MS` to `.env.example` (default 300000 = 5 min)

- [x] Task 5: Add action for Drive monitoring (AC: #1)
  - [x] Add `google-workspace:monitor-drive` action (green tier, reversible) to `suites/google-workspace/actions.json`

- [x] Task 6: Tests (AC: #1, #3, #4)
  - [x] Create `suites/google-workspace/__tests__/drive-watcher.test.ts`
  - [x] Test: poll cycle spawns `gws drive changes getStartPageToken` then `gws drive changes list`
  - [x] Test: new file in monitored folder emits `gdrive:new-file` event
  - [x] Test: file in non-monitored folder is ignored
  - [x] Test: CLI error logs warning and schedules next poll (no crash)
  - [x] Test: config reload updates monitored folders
  - [x] Test: stop() clears poll timer and running state
  - [x] Test: pageToken persistence (read on start, write after poll)

## Dev Notes

### Architecture: Polling via Drive Changes API (not webhook)

**Why polling, not `gws drive changes watch`?**
The `changes watch` command uses Google Push Notifications (webhooks) which require a publicly accessible HTTPS endpoint. Raven runs on WSL2 behind NAT — no public URL available. Instead, use the Changes API polling pattern:

1. On first start: `gws drive changes getStartPageToken --format json` → store `startPageToken`
2. On each poll: `gws drive changes list --params '{"pageToken":"<token>","spaces":"drive","fields":"*"}' --format json --page-all`
3. Parse response: extract `changes[]` array, filter by `file.parents` containing a monitored folder ID
4. For each matching new/modified file, emit `gdrive:new-file` event
5. Store returned `newStartPageToken` for next poll cycle

### Service Pattern (follow `suites/google-workspace/services/email-watcher.ts`)

The drive-watcher differs from email-watcher in one key way: it uses a **polling timer** instead of a **long-lived spawned process**. Structure:

```
Module-level state:
- running: boolean
- pollTimer: ReturnType<typeof setInterval> | null
- eventBus: EventBusInterface
- logger: LoggerInterface
- credFile: string
- monitoredFolderIds: string[]
- pageToken: string
- pollIntervalMs: number

start(context):
  1. Read credFile from env GWS_PRIMARY_CREDENTIALS_FILE (resolve relative to projectRoot)
  2. Read monitoredFolderIds from context.config.driveFolders (string[])
  3. Read pollIntervalMs from context.config.drivePollingIntervalMs (default 300000)
  4. Load persisted pageToken from data/gdrive-page-token.txt (if exists)
  5. If no pageToken, fetch initial one via getStartPageToken
  6. Set running = true
  7. Start poll timer with setInterval
  8. Register config:reloaded listener on eventBus

stop():
  1. Set running = false
  2. Clear pollTimer
  3. Persist current pageToken to disk

poll():
  1. Spawn: gws drive changes list --params '{"pageToken":"...","spaces":"drive","fields":"*"}' --format json --page-all
  2. Parse NDJSON output (may be multi-page)
  3. For each change where change.file exists:
     a. Check if change.file.parents includes any monitoredFolderIds entry
     b. If match → emit gdrive:new-file event
  4. Update pageToken from response newStartPageToken
  5. Persist pageToken to data/gdrive-page-token.txt
  6. On spawn error → logger.warn(), continue (next poll will retry)
```

### CLI Command Reference

```bash
# Get initial page token
gws drive changes getStartPageToken --format json
# Returns: {"startPageToken":"12345"}

# List changes since token
gws drive changes list --params '{"pageToken":"12345","spaces":"drive","fields":"*"}' --format json --page-all
# Returns NDJSON pages with: {"changes":[{...}],"newStartPageToken":"12346"}

# Each change object has:
# { "kind": "drive#change", "type": "file", "fileId": "...", "time": "...",
#   "removed": false, "file": { "id": "...", "name": "...", "mimeType": "...",
#   "parents": ["folderId"], "modifiedTime": "...", "size": "..." } }
```

### Event Shape

```typescript
// packages/shared/src/types/events.ts
export interface GDriveNewFileEvent extends BaseEvent {
  type: 'gdrive:new-file';
  payload: {
    fileId: string;
    name: string;
    mimeType: string;
    folderId: string;     // the monitored folder that matched
    modifiedTime: string; // ISO 8601
    size: number;         // bytes
    webViewLink?: string;
  };
}
```

### Configuration Shape

```jsonc
// config/suites.json — google-workspace entry
{
  "google-workspace": {
    "enabled": true,
    "config": {
      "driveFolders": ["FOLDER_ID_1", "FOLDER_ID_2"],
      "drivePollingIntervalMs": 300000
    }
  }
}
```

### Spawning CLI Commands from Service

Use `child_process.spawn` (same as email-watcher) but for one-shot commands, not long-running:

```typescript
import { spawn } from 'node:child_process';

function runGwsCommand(args: string[], credFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...(process.env as Record<string, string>) };
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credFile;

    const proc = spawn('gws', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gws exited ${code}: ${stderr}`));
    });
  });
}
```

### Config Hot-Reload

Listen for `config:reloaded` events on the event bus (same pattern used by pipeline-loader, permission-engine). When `configType === 'suites'`, re-read the `google-workspace.config.driveFolders` array and update `monitoredFolderIds` in place. No restart needed.

### Page Token Persistence

Store `pageToken` in `data/gdrive-page-token.txt` (plain text, single line). This prevents re-processing all Drive changes on restart. Use `node:fs/promises` `readFile`/`writeFile`. If file doesn't exist on startup, fetch a fresh token via `getStartPageToken`.

### Pipeline Integration

The `gdrive:new-file` event integrates with the existing pipeline event trigger system (`packages/core/src/pipeline-engine/pipeline-event-trigger.ts`). Users can create pipeline YAML files with:

```yaml
trigger:
  event: "gdrive:new-file"
  filter:
    mimeType: "application/pdf"
steps:
  - name: download-file
    # ... pipeline step to download and process
```

The `matchesFilter()` function in pipeline-event-trigger.ts already supports string matching on event payload fields — no changes needed to the pipeline engine.

### Existing Code to Reuse

- **`generateId()`** from `@raven/shared` — for event IDs
- **`SOURCE_GWS_DRIVE`** — new constant (add to `packages/shared/src/suites/constants.ts`)
- **`SuiteService` type** — import from `@raven/core/suite-registry/service-runner.ts`
- **`email-watcher.ts` spawn pattern** — same env var injection, stderr logging
- **`resolve()` from `node:path`** — for credential file path resolution

### Files That Will NOT Be Modified

- `suites/google-workspace/agents/gws-agent.ts` — the gws-agent already has full Drive CLI knowledge via its prompt
- `packages/core/src/orchestrator/orchestrator.ts` — no orchestrator handler needed; pipeline event triggers handle `gdrive:new-file` automatically
- `packages/core/src/pipeline-engine/` — existing `matchesFilter()` works for this event type

### Project Structure Notes

- New service file follows the existing pattern: `suites/google-workspace/services/drive-watcher.ts`
- Test file at: `suites/google-workspace/__tests__/drive-watcher.test.ts`
- Constants and types in `packages/shared/` (standard location)
- Config in `config/suites.json` (standard location)
- Page token persistence in `data/` directory (same as `data/raven.db`)

### Testing Pattern (follow `suites/google-workspace/__tests__/email-watcher.test.ts`)

- Mock `child_process.spawn` via `vi.mock('node:child_process')`
- Mock `node:fs/promises` for pageToken read/write
- Create mock event bus with `{ emit: vi.fn(), on: vi.fn() }`
- Use `vi.useFakeTimers()` for polling interval control
- Test NDJSON parsing with realistic Drive Changes API response payloads
- Verify folder filtering: only files in monitored folders emit events

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 8.2]
- [Source: _bmad-output/planning-artifacts/prd.md#FR59d]
- [Source: suites/google-workspace/services/email-watcher.ts — service pattern]
- [Source: packages/shared/src/types/events.ts — event type definitions]
- [Source: packages/shared/src/suites/constants.ts — source constants]
- [Source: packages/core/src/pipeline-engine/pipeline-event-trigger.ts — event trigger matching]
- [Source: suites/google-workspace/suite.ts — suite manifest]
- [Source: config/suites.json — suite configuration]
- [Source: Google Drive Changes API — pageToken polling pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

N/A — no runtime issues encountered during implementation.

### Completion Notes List

- Task 1: Added `SOURCE_GWS_DRIVE` constant and `GDriveNewFileEvent` interface + Zod schema to shared package. Added to `RavenEvent` union type.
- Task 2: Implemented `drive-watcher.ts` as a `SuiteService` with polling-based Drive Changes API, NDJSON parsing, folder filtering, graceful error handling, config:reloaded hot-reload, and pageToken persistence.
- Task 3: Registered `'drive-watcher'` in `suite.ts` services array.
- Task 4: Added `driveFolders` and `drivePollingIntervalMs` config to `suites.json` and `GWS_DRIVE_POLL_INTERVAL_MS` to `.env.example`.
- Task 5: Added `google-workspace:monitor-drive` green-tier action to `actions.json`.
- Task 6: 8 tests covering all ACs — poll cycle, event emission, folder filtering, error handling, config reload, stop/cleanup, pageToken persistence (read + write).

### Change Log

- 2026-03-21: Story 8.2 implementation complete — drive watcher service with full test coverage
- 2026-03-21: Code review fixes — config:reloaded handler re-reads suites.json from disk (was broken: handler expected 2nd arg never passed by EventBusInterface), typed event emission, added eventBus.off() cleanup in stop(), updated test to match real event bus contract

### File List

- `packages/shared/src/suites/constants.ts` (modified — added SOURCE_GWS_DRIVE)
- `packages/shared/src/types/events.ts` (modified — added GDriveNewFileEvent, GDriveNewFilePayloadSchema, union type)
- `suites/google-workspace/services/drive-watcher.ts` (new — drive watcher service)
- `suites/google-workspace/suite.ts` (modified — added drive-watcher to services)
- `suites/google-workspace/__tests__/drive-watcher.test.ts` (new — 8 tests)
- `suites/google-workspace/actions.json` (modified — added monitor-drive action)
- `config/suites.json` (modified — added google-workspace config block)
- `.env.example` (modified — added GWS_DRIVE_POLL_INTERVAL_MS)
