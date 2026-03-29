# 09 - Permissions & Bash Access (Phase 5)

Validates graduated bash access (none/sandboxed/scoped/full), command validation, path restrictions, mandatory deny rules, and audit logging.

Prerequisites: Both servers running, at least one agent with bash config

## Test Cases — Bash Access Levels

### PERM-01: Agent with `access: none` cannot run bash

**Steps:**
1. find or create an agent with `bash.access: none`
2. send a chat message requesting a bash command (e.g., "run `ls /tmp`")
3. assert: agent does NOT execute bash command
4. assert: agent responds with inability to run commands (or uses alternative tools)

### PERM-02: Agent with `access: sandboxed` runs whitelisted commands only

**Steps:**
1. find or create agent with:
   ```yaml
   bash:
     access: sandboxed
     allowedCommands: ["ls", "cat"]
     deniedCommands: ["rm *"]
   ```
2. request: "run `ls /tmp`"
3. assert: command executes successfully
4. request: "run `rm /tmp/testfile`"
5. assert: command is BLOCKED with reason mentioning "rm" is not allowed

### PERM-03: Agent with `access: scoped` respects path boundaries

**Steps:**
1. find or create agent with:
   ```yaml
   bash:
     access: scoped
     allowedPaths: ["data/artifacts/**", "/tmp/raven-*"]
     deniedPaths: [".env", ".git/**", "projects/**"]
   ```
2. request: "run `cat data/artifacts/test.txt`"
3. assert: command allowed (within allowedPaths)
4. request: "run `cat .env`"
5. assert: command BLOCKED (in deniedPaths)
6. request: "run `cat projects/context.md`"
7. assert: command BLOCKED (in deniedPaths)

### PERM-04: Agent with `access: full` can run any command

**Steps:**
1. this level should only be available for system admin / meta-project agents
2. verify that `access: full` agents can run arbitrary commands
3. assert: requires red-tier approval for the session

## Test Cases — Mandatory Deny Rules

### PERM-05: .env always denied regardless of access level

**Steps:**
1. for each access level (sandboxed, scoped, full):
2. attempt: `cat .env`
3. assert: BLOCKED in all cases
4. assert: error reason mentions mandatory deny

### PERM-06: .git/ always denied

**Steps:**
1. for each access level:
2. attempt: `cat .git/config`
3. assert: BLOCKED
4. attempt: `ls .git/refs/`
5. assert: BLOCKED

### PERM-07: Catastrophic rm patterns always denied

**Steps:**
1. attempt: `rm -rf /`
2. assert: BLOCKED regardless of access level
3. attempt: `rm -rf ~`
4. assert: BLOCKED

## Test Cases — Pipe Chain Validation

### PERM-08: All commands in pipe chain are validated

**Steps:**
1. agent with `sandboxed` access, allowed: ["ls", "grep"]
2. request: `ls /tmp | grep test`
3. assert: allowed (both commands whitelisted)
4. request: `ls /tmp | rm -f test`
5. assert: BLOCKED (rm not whitelisted)

## Test Cases — Audit Logging

### PERM-09: Bash commands logged to audit trail

**Steps:**
1. execute several bash commands (allowed and denied)
2. curl: `GET http://localhost:4001/api/audit-logs?limit=10`
3. assert: recent entries include bash command attempts
4. assert: each entry has `outcome` (executed, denied), `details` (command), `timestamp`

### PERM-10: Audit log filterable by outcome

**Steps:**
1. curl: `GET http://localhost:4001/api/audit-logs?outcome=denied`
2. assert: only denied entries returned
3. curl: `GET http://localhost:4001/api/audit-logs?outcome=executed`
4. assert: only executed entries returned

## Test Cases — Permission Tiers

### PERM-11: Green tier actions execute silently

**Steps:**
1. trigger a green-tier action (e.g., read operation)
2. assert: executes without notification or approval prompt
3. assert: logged in audit trail

### PERM-12: Yellow tier actions execute with notification

**Steps:**
1. trigger a yellow-tier action (e.g., write operation)
2. assert: executes but generates a notification/report
3. assert: logged in audit trail

### PERM-13: Red tier actions require approval

**Steps:**
1. trigger a red-tier action (e.g., destructive operation or elevated bash)
2. assert: action is queued for approval
3. assert: notification sent (Telegram or dashboard)
4. approve via API
5. assert: action then executes
