# 29 - System Maintenance Pipeline (Story 10.4)

Verify the system maintenance pipeline: manual trigger, log analysis, dependency checking, resource monitoring, suite updates, report generation, and Telegram delivery.

Prerequisites: Backend running (`npm run dev:core` from your own terminal), Telegram bot connected, `config/pipelines/system-maintenance.yaml` exists

## Test Cases — Pipeline Trigger (AC: 1, 8)

### MAINT-01: Manual trigger via API

**Steps:**
1. curl:
   ```bash
   curl -X POST http://localhost:4001/api/pipelines/system-maintenance/trigger
   ```
2. assert response:
   - status 202
   - JSON body contains `runId` and `status` = "started"
3. wait 30-60s for completion (maintenance involves AI agent + web search)
4. check logs for maintenance execution completion

### MAINT-02: Pipeline exists in registry

**Steps:**
1. curl: `GET http://localhost:4001/api/pipelines/system-maintenance`
2. assert response:
   - status 200
   - `config.name` = "system-maintenance"
   - `config.trigger.type` = "cron"
   - `config.enabled` = true

### MAINT-03: Scheduled trigger

**Steps:**
1. check `config/schedules.json` for the maintenance schedule entry
2. assert: cron expression for weekly run exists (default: `0 2 * * 0` — Sunday 2am)

## Test Cases — Report Generation (AC: 2, 3, 4, 5, 6)

### MAINT-04: Report stored to file

**Steps:**
1. trigger maintenance (MAINT-01) → wait for completion
2. check:
   ```bash
   ls data/maintenance-reports/
   ```
3. assert: file exists named `YYYY-MM-DD.md` (today's date)
4. read the file → assert: contains markdown with sections:
   - "Issues Found" (or similar heading for log analysis)
   - "Package Updates" (or similar for dependency check)
   - "Suite Suggestions" (or similar for suite ecosystem review)
   - "Resource Status" (or similar for system resources)

### MAINT-05: Log analysis section

**Steps:**
1. read the maintenance report
2. assert "Issues Found" section:
   - identifies recurring errors from logs (if any)
   - identifies silent failures (if any)
   - includes web-sourced fix suggestions (if errors found)

### MAINT-06: Dependency check section

**Steps:**
1. read the maintenance report
2. assert "Package Updates" section:
   - lists packages with available updates
   - distinguishes patch/minor/major updates
   - flags security advisories (if any)
   - includes migration guidance for major updates

### MAINT-07: Resource status section

**Steps:**
1. read the maintenance report
2. assert "Resource Status" section:
   - reports database size (`data/raven.db`)
   - reports log volume (`data/logs/`)
   - reports health status
   - flags any resources exceeding thresholds

### MAINT-08: Suite update check section

**Steps:**
1. read the maintenance report
2. assert "Suite Suggestions" or update section:
   - references suites with `UPDATE.md` files
   - lists suites without `UPDATE.md` as needing one
   - suggests potential new MCP integrations

## Test Cases — Telegram Delivery (AC: 6)

### MAINT-09: Report delivered via Telegram

**Steps:**
1. trigger maintenance (MAINT-01) → wait for completion
2. check Telegram Raven supergroup
3. assert:
   - formatted maintenance report posted
   - report includes section headings
   - posted to appropriate topic thread

## Test Cases — Maintenance Event

### MAINT-10: Maintenance events emitted

**Steps:**
1. trigger maintenance (MAINT-01)
2. check logs → assert:
   - `maintenance:report:generated` event emitted
   - event payload includes report summary

## Test Cases — UPDATE.md Files (AC: 7)

### MAINT-11: Suite UPDATE.md files exist

**Steps:**
1. check for UPDATE.md in each suite:
   ```bash
   ls suites/*/UPDATE.md
   ```
2. assert: at minimum, UPDATE.md exists for:
   - `suites/notifications/UPDATE.md`
   - `suites/email/UPDATE.md`
   - `suites/task-management/UPDATE.md`
3. read one → assert: contains instructions for checking API changes and version updates
