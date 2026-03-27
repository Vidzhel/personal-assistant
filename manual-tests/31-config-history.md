# 31 - Config Version History (Story 10.6)

Verify git-based config version history: commit listing, diff viewing, config revert, and config reload.

Prerequisites: Backend running (`npm run dev:core`), frontend running (`npm run dev:web`), at least a few config changes committed to git (modify `config/` files)

## Test Cases — Config History API

### CFGHIST-01: List config commits

**Steps:**
1. curl: `GET http://localhost:4001/api/config-history?limit=10`
2. assert response:
   - status 200
   - JSON array of commits
   - each commit has: `hash`, `timestamp`, `author`, `message`, `files`
   - commits are for `config/` directory changes only
   - ordered by most recent first

### CFGHIST-02: Pagination works

**Steps:**
1. curl: `GET http://localhost:4001/api/config-history?limit=2&offset=0`
2. note the hashes
3. curl: `GET http://localhost:4001/api/config-history?limit=2&offset=2`
4. assert: different hashes returned, no overlap

### CFGHIST-03: Get commit detail with diffs

**Steps:**
1. get a commit hash from CFGHIST-01
2. curl: `GET http://localhost:4001/api/config-history/{hash}`
3. assert response:
   - status 200
   - includes full unified diff per file
   - diff shows added/removed lines with +/- markers

### CFGHIST-04: Non-existent hash returns 404

**Steps:**
1. curl: `GET http://localhost:4001/api/config-history/0000000000000000000000000000000000000000`
2. assert: status 404

## Test Cases — Config Revert

### CFGHIST-05: Revert a config change

**Steps:**
1. make a test config change:
   ```bash
   # modify a non-critical config file, commit it
   ```
2. get the commit hash
3. curl:
   ```bash
   curl -X POST http://localhost:4001/api/config-history/{hash}/revert \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
4. assert response:
   - `success` = true
   - `revertHash` — new commit hash for the revert
   - `message` confirms revert
5. verify: config file reverted to previous state

### CFGHIST-06: Revert triggers config reload

**Steps:**
1. perform a revert (CFGHIST-05)
2. check logs → assert:
   - `config:reloaded` event emitted
   - affected config modules reloaded without restart

### CFGHIST-07: File-specific revert

**Steps:**
1. get a commit hash that affected multiple config files
2. curl:
   ```bash
   curl -X POST http://localhost:4001/api/config-history/{hash}/revert \
     -H "Content-Type: application/json" \
     -d '{"file": "config/agents.json"}'
   ```
3. assert: only the specified file is reverted, other files from that commit unchanged

## Test Cases — Config History UI

### CFGHIST-08: Config history page loads

**Steps:**
1. navigate to config history page in dashboard
2. snapshot → assert:
   - heading includes "Config History" or "Configuration History"
   - list of commits visible
   - each row shows: timestamp, commit message, affected files

### CFGHIST-09: Expand commit shows diff

**Steps:**
1. navigate to config history page
2. click expand button on a commit row
3. snapshot → assert:
   - unified diff displayed
   - green lines (additions) and red lines (removals) visible
   - monospace font

### CFGHIST-10: Revert button with confirmation

**Steps:**
1. navigate to config history page
2. click "Revert" button on a commit
3. snapshot → assert:
   - confirmation dialog appears
   - dialog explains what will be reverted
4. confirm → assert:
   - success toast/message appears
   - new revert commit appears at top of list

### CFGHIST-11: Sidebar navigation includes Config History

**Steps:**
1. navigate: `http://localhost:4000`
2. snapshot → assert:
   - sidebar contains "Config History" link
3. click: "Config History" → assert: navigates to config history page
