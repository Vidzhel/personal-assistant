# 11 - Email Auto-Triage (Story 4.1)

Verify email triage rules match incoming emails, execute actions (archive, label, mark-read), send urgent notifications, and hot-reload config changes. These are backend-only tests — no frontend UI.

Prerequisites:
- Backend running (`npm run dev:core` from your own terminal, NOT inside Claude Code)
- Gmail credentials configured and IMAP watcher running (check logs for "IMAP watcher started")
- Telegram bot connected (check logs for "Telegram bot started")
- `config/email-rules.json` has seed rules (newsletter-archive, important-senders, automated-noreply)
- Verified via `curl http://localhost:4001/api/health`

## Test Cases — Newsletter Auto-Archive (AC #1)

### TRIAGE-01: Newsletter detected and archived

**Steps:**
1. Send a test email to the monitored Gmail account with `List-Unsubscribe` header or "unsubscribe" in the body (e.g., forward a real newsletter)
2. Watch terminal logs for IMAP watcher detecting the new email (`email:new` event)
3. Watch logs for email-triage service processing: rule match logged with rule name `newsletter-archive`

**Assertions:**
- Log shows `email:triage:processed` event with `rulesMatched` containing `newsletter-archive`
- Log shows `actionsTaken` includes `archive: true` and `markRead: true`
- Log shows `executeApprovedAction` called for `gmail:archive-email` (yellow tier — auto-approved)
- Log shows `executeApprovedAction` called for `gmail:mark-read` (yellow tier)
- Email is archived in Gmail (check Gmail "All Mail" — email should no longer be in Inbox)
- Email is marked as read in Gmail

### TRIAGE-02: Newsletter triggers action item extraction event

**Steps:**
1. Confirm `config/email-rules.json` newsletter-archive rule has `"extractActions": true`
2. Send a newsletter email (same as TRIAGE-01)
3. Watch logs for `email:triage:action-items` event emission

**Assertions:**
- Log shows `email:triage:action-items` event emitted with `emailId` matching the processed email
- This event is consumed by the action-extractor service (Story 4.2) if running

## Test Cases — Important Sender Flagging (AC #2)

### TRIAGE-03: Important sender email flagged as urgent

**Steps:**
1. Ensure `config/email-rules.json` important-senders rule has a `from` pattern matching a sender you can test with (e.g., add your own email address)
2. Send an email from that address to the monitored Gmail account
3. Watch terminal logs for rule matching

**Assertions:**
- Log shows `email:triage:processed` with `rulesMatched` containing `important-senders`
- Log shows `actionsTaken` includes `label: "urgent"` and `flag: "urgent"`
- Log shows `executeApprovedAction` called for `gmail:label-email` with label "urgent"
- Email has "urgent" label applied in Gmail
- Telegram notification received with title containing "Urgent Email"
- Telegram notification has inline buttons: [View] [Archive] [Reply]

### TRIAGE-04: Urgent email Telegram notification buttons work

**Steps:**
1. After receiving the urgent email notification from TRIAGE-03, tap the [View] button in Telegram
2. Tap the [Archive] button on a subsequent urgent email notification
3. Tap the [Reply] button on another urgent email notification

**Assertions:**
- [View] button triggers email view callback (`e:v:{emailId}`)
- [Archive] button triggers archive callback (`e:a:{emailId}`) — email is archived in Gmail
- [Reply] button triggers reply callback (`e:r:{emailId}`) — reply composition flow starts

## Test Cases — Automated/Noreply Filtering

### TRIAGE-05: Automated email archived

**Steps:**
1. Confirm `config/email-rules.json` automated-noreply rule is enabled
2. Send or forward an email from a `noreply@` or `no-reply@` address
3. Watch logs for rule matching

**Assertions:**
- Log shows `email:triage:processed` with `rulesMatched` containing `automated-noreply`
- Log shows `actionsTaken` includes `archive: true` and `markRead: true`
- Email is archived and marked as read in Gmail
- No Telegram notification sent (no `flag: "urgent"` in this rule)

## Test Cases — Match Mode and Priority

### TRIAGE-06: All-match mode applies multiple rules

**Steps:**
1. Confirm `config/email-rules.json` has `"matchMode": "all"` (default)
2. Send an email that matches multiple rules simultaneously (e.g., from an important sender that also contains "unsubscribe")
3. Watch logs for rule processing

**Assertions:**
- Log shows multiple rules matched (both `newsletter-archive` and `important-senders`)
- Actions from all matched rules are executed (both archive + label)
- Rules are applied in priority order (lower priority number = higher precedence)

### TRIAGE-07: No rules matched — email passes through

**Steps:**
1. Send a normal email from an unknown sender, no unsubscribe header, no noreply address
2. Watch logs for email-triage processing

**Assertions:**
- Log shows email-triage service received `email:new` event
- Log shows 0 rules matched
- Log shows `email:triage:processed` event with empty `rulesMatched` array
- Email remains in Gmail inbox, unmodified
- No Telegram notification sent

## Test Cases — Config Hot-Reload (AC #3)

### TRIAGE-08: Adding a new rule takes effect without restart

**Steps:**
1. Edit `config/email-rules.json` — add a new rule:
   ```json
   {
     "name": "test-rule",
     "description": "Test hot-reload",
     "match": { "subject": ["TEST-TRIAGE-RELOAD"] },
     "actions": { "label": "test-label" },
     "enabled": true,
     "priority": 1
   }
   ```
2. Save the file
3. Watch logs for config reload event
4. Send an email with subject containing "TEST-TRIAGE-RELOAD"

**Assertions:**
- Log shows `config:reloaded` event received by email-triage service
- Log shows rules reloaded with new rule count (should be +1)
- New email matches the `test-rule` rule
- `gmail:label-email` called with label "test-label"
- Clean up: remove the test rule from config after verifying

### TRIAGE-09: Invalid config preserves previous rules

**Steps:**
1. Note the current rule count from logs
2. Edit `config/email-rules.json` — introduce invalid JSON (e.g., missing closing bracket)
3. Save the file
4. Watch logs for config reload attempt

**Assertions:**
- Log shows `config:reloaded` event received
- Log shows Zod validation error or JSON parse error
- Log shows "keeping previous rules" message
- Send a test email — previous rules still work correctly (rule count unchanged)
- Fix the config file afterward

## Test Cases — Graceful Degradation (AC #4)

### TRIAGE-10: Gmail API failure doesn't crash service

**Steps:**
1. Temporarily break Gmail credentials (rename `config/gmail-credentials.json` or modify a credential value)
2. Send an email to trigger triage processing (IMAP watcher may still detect it from existing connection)
3. Watch logs for error handling

**Assertions:**
- Log shows error from `executeApprovedAction` for Gmail operations (label/archive/mark-read)
- Error is logged with structured Pino JSON (not an unhandled exception)
- Service continues running — no crash, no restart needed
- Subsequent emails are still processed when credentials are restored
- Restore credentials after testing

### TRIAGE-11: Malformed email payload handled gracefully

**Steps:**
1. Use the events API or trigger an `email:new` event with incomplete/malformed payload:
   ```bash
   curl -X POST http://localhost:4001/api/events \
     -H "Content-Type: application/json" \
     -d '{"type": "email:new", "payload": {"invalid": "data"}}'
   ```
2. Watch logs for validation handling

**Assertions:**
- Log shows Zod safeParse failure for the email:new payload
- Service logs warning and skips the malformed event
- No crash, service continues processing valid events
