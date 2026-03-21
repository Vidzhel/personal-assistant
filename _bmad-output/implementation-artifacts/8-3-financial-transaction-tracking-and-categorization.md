# Story 8.3: Financial Transaction Tracking & Categorization

Status: done

## Story

As the system operator,
I want Raven to pull bank transactions from Monobank and PrivatBank, push them into YNAB for budgeting and categorization, and query YNAB for spending reports,
so that I have financial visibility through YNAB without manual transaction entry.

## Acceptance Criteria

1. **Given** new transactions appear in the Monobank account, **when** the transaction sync runs (polling `/personal/statement`), **then** each transaction is fetched, stored locally in `financial_transactions`, and pushed to YNAB via the Transactions API with a dedup `import_id`.

2. **Given** new transactions appear in the PrivatBank account, **when** the transaction sync runs (polling AutoClient API), **then** each transaction is fetched, stored locally, and pushed to YNAB identically to Monobank transactions.

3. **Given** a transaction is pushed to YNAB, **when** the user categorizes it in YNAB, **then** a subsequent category sync pull updates the local `financial_transactions.ynab_category` field from YNAB's category data.

4. **Given** a request for a spending report, **when** the API is queried, **then** Raven fetches month summaries from YNAB (`GET /plans/{plan_id}/months/{month}`) returning per-category budgeted vs. actual breakdown — no local aggregation needed.

5. **Given** a bank API or YNAB API returns an error, **when** the sync fails, **then** the service logs the error, retries on next cycle, and does not lose previously synced data.

6. **Given** `config/integrations.json` defines bank accounts with `ynabAccountId` and `displayName`, **when** the transaction-sync service starts, **then** it reads account mappings from this shared config (not env vars) and routes each bank's transactions to the specified YNAB account.

7. **Given** the user needs to set up integrations, **when** they read `docs/MONOBANK_SETUP.md`, `docs/PRIVATBANK_SETUP.md`, or `docs/YNAB_SETUP.md`, **then** the docs provide step-by-step instructions to obtain tokens, configure accounts, and verify the integration.

## Tasks / Subtasks

- [x] Task 1: Create shared dynamic integrations config system (AC: #6)
  - [x] Create `config/integrations.json` — shared config for all external service account mappings (not just financial)
  - [x] Add Zod schema `IntegrationsConfigSchema` in `packages/shared/src/types/config.ts` (or new file `integrations-config.ts`)
  - [x] Add config loader in `packages/core/src/config/integrations-config.ts` — reads, validates, and exports typed config. Emits `config:reloaded` on changes (same pattern as existing config loaders)
  - [x] Wire into boot sequence: load integrations config after suites config, pass to ServiceContext so all suites can access it
  - [x] Add `IntegrationsConfig` type to `ServiceContext` so any suite service can read account mappings

- [x] Task 2: Add shared constants, types, and event definitions (AC: #1, #2)
  - [x] Add `SUITE_FINANCIAL`, `SOURCE_FINANCIAL` to `packages/shared/src/suites/constants.ts`
  - [x] Add `FinancialTransactionEvent` interface + `FinancialTransactionPayloadSchema` to `packages/shared/src/types/events.ts`
  - [x] Add `FinancialSyncCompleteEvent` interface + schema (summary of sync cycle: new tx count, push success/fail counts)
  - [x] Add both to `RavenEvent` union type
  - [x] Rebuild `@raven/shared`

- [x] Task 3: Install `ynab` npm package and create database migration (AC: #1, #2, #3)
  - [x] `npm install ynab` in the monorepo root (it's a runtime dep used by the suite service)
  - [x] Create `migrations/013-financial-tracking.sql`
  - [x] `financial_accounts` table: id, bank (monobank|privatbank), bank_account_id, iban, currency_code (integer, ISO 4217), display_name, ynab_account_id (TEXT — from integrations config), last_sync_at (TEXT, ISO 8601), created_at
  - [x] `financial_transactions` table: id, account_id (FK), bank_tx_id (TEXT, unique dedup key), amount_minor (INTEGER, kopecks), currency_code (INTEGER), description (TEXT), mcc (INTEGER, nullable), ynab_category (TEXT, nullable — synced back from YNAB), ynab_transaction_id (TEXT, nullable), is_debit (INTEGER, 0/1), balance_after_minor (INTEGER, nullable), transaction_date (TEXT, ISO 8601), created_at (TEXT)
  - [x] Indices: UNIQUE on bank_tx_id, composite on (account_id, transaction_date)

- [x] Task 4: Create financial-tracking suite scaffold (AC: #1, #2)
  - [x] Create `suites/financial-tracking/suite.ts` — name, services: ['transaction-sync'], requiresEnv: ['YNAB_ACCESS_TOKEN'] (bank tokens checked at runtime from integrations config)
  - [x] Create `suites/financial-tracking/actions.json` — green: read-transactions, read-ynab-report; yellow: push-to-ynab, sync-categories
  - [x] Create `suites/financial-tracking/schedules.json` — empty `[]`
  - [x] Add suite config to `config/suites.json`: `"financial-tracking": { "enabled": true, "config": { "syncIntervalMs": 3600000, "ynabPlanId": "default", "categorySyncIntervalMs": 14400000 } }`

- [x] Task 5: Implement bank API clients (AC: #1, #2, #5)
  - [x] Create `suites/financial-tracking/services/monobank-client.ts` — `fetchTransactions(token, accountId, from, to): Promise<MonobankTransaction[]>` using `fetch()` with `X-Token` header
  - [x] Create `suites/financial-tracking/services/privatbank-client.ts` — `fetchTransactions(token, iban, periodDays): Promise<PrivatBankTransaction[]>` using `fetch()`
  - [x] Both export a `normalizeTransaction(bankTx): NormalizedTransaction` function that converts to the common schema (amount → minor units, date → ISO 8601, generate import_id)
  - [x] Monobank amounts (kopecks) → keep as-is for local storage, multiply by 10 for YNAB milliunits
  - [x] PrivatBank amounts (decimal strings) → multiply by 100 for local kopecks, multiply by 1000 for YNAB milliunits

- [x] Task 6: Implement YNAB integration (AC: #1, #2, #3, #4)
  - [x] Create `suites/financial-tracking/services/ynab-client.ts` — wraps the `ynab` SDK
  - [x] `pushTransactions(planId, transactions[]): Promise<PushResult>` — bulk POST to YNAB with `import_id` for dedup. YNAB silently skips duplicates.
  - [x] `import_id` format: `YNAB:[milliunit_amount]:[iso_date]:[occurrence]` where occurrence = counter for same amount+date combos. Max 36 chars.
  - [x] `fetchCategorizedTransactions(planId, accountId, sinceDate): Promise<YnabTransaction[]>` — GET transactions from YNAB with category data, using `last_knowledge_of_server` for delta sync
  - [x] `fetchMonthSummary(planId, month): Promise<MonthDetail>` — GET month with per-category budgeted/activity/balance
  - [x] `listAccounts(planId): Promise<Account[]>` — for initial account mapping verification
  - [x] `listCategories(planId): Promise<CategoryGroup[]>` — for category ID → name resolution
  - [x] Store `server_knowledge` (delta sync token) in `financial_accounts` or a separate config row to efficiently poll only changed transactions

- [x] Task 7: Implement transaction-sync service (AC: #1, #2, #3, #5, #6)
  - [x] Create `suites/financial-tracking/services/transaction-sync.ts` as a `SuiteService`
  - [x] **Read account config from `integrations.json`** — iterate `accounts` array, initialize bank clients per entry, use `ynabAccountId` for YNAB routing, `displayName` for logging
  - [x] **Bank → Local → YNAB pipeline** per poll cycle:
    1. Fetch new transactions from each bank API since `last_sync_at`
    2. Normalize and INSERT OR IGNORE into local `financial_transactions`
    3. For genuinely new rows (not skipped by dedup), bulk push to YNAB with `import_id` to the account's mapped `ynabAccountId`
    4. Store `ynab_transaction_id` from YNAB response for each pushed tx
    5. Update `last_sync_at` on `financial_accounts`
    6. Emit `financial:transaction:recorded` events for new transactions
    7. Emit `financial:sync-complete` event with cycle summary
  - [x] **Category sync** (separate timer, less frequent — e.g., every 4 hours):
    1. Fetch transactions from YNAB with `last_knowledge_of_server` (delta)
    2. For each returned transaction that has a `category_name`, update local `ynab_category`
    3. This captures user categorizations done in YNAB app
  - [x] Handle Monobank rate limit: 1 req/60s — stagger with `setTimeout` between accounts
  - [x] Handle YNAB rate limit: 200 req/hour — unlikely to hit with hourly sync, but track remaining via response headers
  - [x] Graceful error handling: log warning per bank/YNAB failure, continue to next, retry next cycle
  - [x] Listen for `config:reloaded` events to hot-reload integrations config and sync settings
  - [x] Clean up with `eventBus.off()` in `stop()`

- [x] Task 8: Add API endpoints (AC: #4)
  - [x] `GET /api/financial/transactions?account=&from=&to=&category=&limit=&offset=` — paginated local transaction list (fast, from SQLite)
  - [x] `GET /api/financial/accounts` — list configured accounts from integrations.json with last sync time and YNAB mapping status
  - [x] `GET /api/financial/report?month=YYYY-MM` — proxy to YNAB month summary, returns per-category budgeted vs. actual (cached briefly to respect rate limits)
  - [x] `GET /api/financial/categories` — list YNAB budget categories (cached, refreshed on category sync)
  - [x] Register routes in API server factory

- [x] Task 9: Create setup documentation (AC: #7)
  - [x] Create `docs/MONOBANK_SETUP.md` — how to get personal API token, verify with curl, add to integrations.json
  - [x] Create `docs/PRIVATBANK_SETUP.md` — how to activate AutoClient API, get token + IBAN, add to integrations.json
  - [x] Create `docs/YNAB_SETUP.md` — how to create personal access token, find plan ID and account IDs, add to env and integrations.json
  - [x] Include troubleshooting sections (token expired, rate limits, common errors)

- [x] Task 10: Tests (AC: #1-#6)
  - [x] Create `suites/financial-tracking/__tests__/transaction-sync.test.ts`
  - [x] Test: Reads account mappings from integrations config, initializes correct bank clients
  - [x] Test: Monobank poll fetches, stores locally, and pushes to YNAB with correct import_id and milliunits
  - [x] Test: PrivatBank poll fetches, normalizes decimal amounts to kopecks and milliunits
  - [x] Test: Deduplication — same bank_tx_id on second poll is INSERT OR IGNORE'd locally and YNAB silently skips duplicate import_id
  - [x] Test: Transactions routed to correct YNAB account per integrations config mapping
  - [x] Test: Category sync pulls YNAB categories and updates local ynab_category field
  - [x] Test: Bank API error logs warning and continues (no crash, no data loss)
  - [x] Test: YNAB API error logs warning, local storage still succeeds (YNAB push retried next cycle)
  - [x] Test: Config reload updates sync intervals and account mappings
  - [x] Test: YNAB month report endpoint returns per-category breakdown
  - [x] Mock `global.fetch` for bank APIs and mock `ynab` SDK constructor for YNAB calls

## Dev Notes

### Architecture: Bank → Local DB → YNAB Pipeline

The data flow is: **Bank APIs → local SQLite → YNAB**. Local storage serves as:
1. **Dedup buffer** — bank_tx_id UNIQUE constraint prevents double-counting
2. **Event source** — new transactions emit events for the event bus (morning briefing, knowledge system)
3. **Fast query cache** — local transactions queryable without YNAB API calls
4. **Resilience** — if YNAB is down, transactions are stored locally and pushed on next cycle

**YNAB is the source of truth for categorization and budgeting.** Raven does NOT categorize transactions — YNAB handles this via its payee-based auto-categorization and user manual categorization. Raven syncs categories back from YNAB periodically.

**YNAB is the source of truth for reporting.** Monthly spending reports come from `GET /plans/{plan_id}/months/{month}` which returns per-category budgeted, activity, and balance. No local aggregation tables needed.

### Bank API Details

**Monobank API** (primary, best documented):
- Base URL: `https://api.monobank.ua`
- Auth: `X-Token: <personal_token>` header on every request
- Token obtained at https://api.monobank.ua/ (scan QR with Monobank app)
- `GET /personal/client-info` — returns accounts list (id, iban, currencyCode, balance, creditLimit, type)
- `GET /personal/statement/{account}/{from}/{to}` — transactions for Unix timestamp range (max 31 days per request)
- Rate limit: **1 request per 60 seconds** per endpoint
- Amounts in **minor units** (kopecks) — negative = debit, positive = credit
- Currency: UAH = ISO 4217 code **980**
- Transaction fields: id, time, description, mcc, hold, amount, operationAmount, currencyCode, commissionRate, cashbackAmount, balance, comment

**PrivatBank AutoClient API**:
- Auth: Token + IBAN pair (activate via Privat24 Business -> AutoClient -> API)
- `get_balance()` — account balance by IBAN
- `get_statement(period_days, limit)` — transaction history
- Transaction fields: ID, AUT_MY_ACC, AUT_CNTR_ACC, SUM (decimal string), CCY, DAT_OD, OSND, TRANTYPE (D/C), REF
- No webhooks — polling only
- "Vlasnyy rahunok" = standard current account (поточний рахунок), identified by IBAN starting with `UA`
- Amounts as **decimal strings** (e.g., "142.50")

### YNAB API Details

- **Base URL**: `https://api.ynab.com/v1`
- **Auth**: `Authorization: Bearer <YNAB_ACCESS_TOKEN>` (personal access token from YNAB Settings > Developer Settings)
- **SDK**: `ynab` npm package (official, v4.0.0, Apache 2.0). Supports ESM: `import * as ynab from 'ynab'`
- **Rate limit**: 200 requests per rolling 1-hour window per token. Returns HTTP 429 when exceeded.
- **Plan ID**: Use `"default"` or `"last-used"` as shorthand instead of UUID. Configurable via `ynabPlanId` in suite config.

**Key Terminology (May 2025 rename)**: "budgets" → "plans", `/budgets/{id}` → `/plans/{id}`. Old paths still work. The SDK v4 uses the new naming.

**Amount Conversion — CRITICAL**:
- YNAB uses **milliunits**: 1 UAH = 1000 milliunits. So 142.50 UAH = 142500 milliunits.
- Monobank kopecks (1 UAH = 100 kopecks) → multiply by **10** for YNAB milliunits
- PrivatBank decimal strings → parse float, multiply by **1000** for YNAB milliunits
- Outflows (debits) are **negative** in both Monobank and YNAB — no sign flip needed for Monobank
- PrivatBank uses TRANTYPE D/C — convert D to negative, C to positive before multiplying

**Dedup via `import_id`**:
- Format: `YNAB:[milliunit_amount]:[iso_date]:[occurrence]`
- Example: `YNAB:-142500:2026-03-21:1`
- Scoped per YNAB account. Same `import_id` on same account = silently skipped (idempotent)
- Occurrence counter: if same amount+date combo appears multiple times, increment: `:1`, `:2`, `:3`
- Max 36 characters

**Creating transactions** (bulk):
```typescript
await ynabApi.transactions.createTransaction(planId, {
  transactions: normalizedTxs.map(tx => ({
    account_id: ynabAccountId,
    date: tx.date,           // ISO date string YYYY-MM-DD
    amount: tx.milliunits,   // negative = outflow
    payee_name: tx.description.slice(0, 200),
    memo: tx.memo?.slice(0, 500) || null,
    cleared: 'cleared',
    approved: false,         // user reviews in YNAB
    import_id: tx.importId,
  })),
});
```

**Querying reports** (month summary):
```typescript
const monthDetail = await ynabApi.months.getPlanMonth(planId, '2026-03');
// monthDetail.data.month.categories[] → { name, budgeted, activity, balance } (all milliunits)
```

**Delta sync** (efficient category pull):
```typescript
const response = await ynabApi.transactions.getTransactionsByAccount(
  planId, ynabAccountId, { sinceDate: '2026-03-01', lastKnowledgeOfServer: storedKnowledge }
);
const newKnowledge = response.data.server_knowledge; // store for next call
response.data.transactions.forEach(tx => {
  // tx.category_name contains YNAB-assigned category
  // Update local financial_transactions.ynab_category where ynab_transaction_id = tx.id
});
```

### Shared Dynamic Config: `config/integrations.json`

This is a **new shared config file** used by all suites that integrate with external services. It is NOT specific to financial tracking — future suites (e.g., calendar, fitness) will add their own sections here.

```jsonc
// config/integrations.json
{
  "ynab": {
    "planId": "default",
    "defaultAccountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  },
  "accounts": [
    {
      "bank": "monobank",
      "displayName": "Monobank Black",
      "bankAccountId": "0",
      "ynabAccountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "currency": "UAH",
      "enabled": true
    },
    {
      "bank": "monobank",
      "displayName": "Monobank White",
      "bankAccountId": "FKxBmPai...",
      "ynabAccountId": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "currency": "UAH",
      "enabled": true
    },
    {
      "bank": "privatbank",
      "displayName": "PrivatBank Vlasnyy Rahunok",
      "iban": "UA123456789012345678901234567",
      "ynabAccountId": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      "currency": "UAH",
      "enabled": true
    }
  ]
}
```

**Design principles:**
- **Common across suites** — any suite reads `config/integrations.json` via `context.integrationsConfig`
- **Account-centric** — each entry maps a bank account to a YNAB account with a display name
- **Multiple accounts per bank** — supports N Monobank accounts (user may have Black + White cards with separate account IDs)
- **`ynab.defaultAccountId`** — fallback if an account entry doesn't specify `ynabAccountId`
- **`enabled` flag** — toggle accounts without removing config
- **Tokens stay in env vars** — `YNAB_ACCESS_TOKEN`, `MONOBANK_TOKEN`, `PRIVATBANK_TOKEN` remain as env vars (secrets never in config files)
- **Hot-reloadable** — `config:reloaded` event triggers re-read of integrations.json

**Zod schema** (in `packages/shared`):
```typescript
const AccountEntrySchema = z.discriminatedUnion('bank', [
  z.object({
    bank: z.literal('monobank'),
    displayName: z.string(),
    bankAccountId: z.string().default('0'),
    ynabAccountId: z.string().uuid(),
    currency: z.string().default('UAH'),
    enabled: z.boolean().default(true),
  }),
  z.object({
    bank: z.literal('privatbank'),
    displayName: z.string(),
    iban: z.string().startsWith('UA'),
    ynabAccountId: z.string().uuid(),
    currency: z.string().default('UAH'),
    enabled: z.boolean().default(true),
  }),
]);

const IntegrationsConfigSchema = z.object({
  ynab: z.object({
    planId: z.string().default('default'),
    defaultAccountId: z.string().uuid().optional(),
  }),
  accounts: z.array(AccountEntrySchema).default([]),
});
```

**Loader** (`packages/core/src/config/integrations-config.ts`):
- Reads `config/integrations.json`, validates with Zod, exports typed config
- Follows same pattern as existing config loaders (e.g., suite config, permissions config)
- On `config:reloaded` event with `configType === 'integrations'`, re-reads from disk

**ServiceContext extension**:
```typescript
// Add to ServiceContext interface
export interface ServiceContext {
  // ...existing fields
  integrationsConfig: IntegrationsConfig;  // from config/integrations.json
}
```

### Environment Variables

```bash
# Required — secrets only, never in config files
YNAB_ACCESS_TOKEN=<personal_access_token>
MONOBANK_TOKEN=<personal_api_token>

# Optional (PrivatBank - graceful skip if missing)
PRIVATBANK_TOKEN=<autoclient_api_token>

# Config overrides
FINANCIAL_SYNC_INTERVAL_MS=3600000       # default 1 hour
FINANCIAL_CATEGORY_SYNC_INTERVAL_MS=14400000  # default 4 hours
```

Note: Account mappings, YNAB account IDs, IBANs, and display names are in `config/integrations.json` (not env vars). Only tokens/secrets are env vars.

### Suite Directory Structure

```
suites/financial-tracking/
├── suite.ts                              # Suite manifest
├── services/
│   ├── transaction-sync.ts               # Main polling service (orchestrates bank→local→YNAB)
│   ├── monobank-client.ts                # Monobank API fetch + normalize
│   ├── privatbank-client.ts              # PrivatBank API fetch + normalize
│   └── ynab-client.ts                    # YNAB SDK wrapper (push, pull categories, reports)
├── actions.json                          # Permission tiers
├── schedules.json                        # Empty []
└── __tests__/
    └── transaction-sync.test.ts          # Tests
```

No agents directory needed — categorization is handled by YNAB, not an AI agent. If anomaly detection is needed later (story 8.4), an agent can be added then.

### Database Schema Design

All local monetary amounts stored as **integers in kopecks** (minor units). YNAB amounts are milliunits (kopecks * 10).

`bank_tx_id` is the local dedup key — UNIQUE constraint with INSERT OR IGNORE.
`ynab_transaction_id` links to the YNAB record for category sync lookups.
`ynab_category` is populated by the category sync pull — NULL until YNAB categorizes.

No `financial_weekly_summaries` table needed — reporting comes from YNAB month endpoints.

### YNAB Account Mapping

Account mappings are defined in `config/integrations.json`. Each `accounts[]` entry has a `ynabAccountId` that specifies which YNAB account receives its transactions. If `ynabAccountId` is missing, fall back to `ynab.defaultAccountId`. If neither is set, log a warning and skip YNAB push for that account.

On first startup, if `config/integrations.json` doesn't exist or has empty `accounts`, log a clear message pointing the user to the setup docs (`docs/MONOBANK_SETUP.md`, `docs/YNAB_SETUP.md`).

### Service Pattern (follow `suites/google-workspace/services/drive-watcher.ts`)

```
Module-level state:
- running: boolean
- bankPollTimer: ReturnType<typeof setInterval> | null
- categorySyncTimer: ReturnType<typeof setInterval> | null
- eventBus, logger, db: from ServiceContext
- ynabClient: initialized from YNAB SDK
- bankClients: [monobank, privatbank] (conditionally initialized)
- ynabServerKnowledge: number (delta sync token, persisted in DB)

start(context):
  1. Read suite config from context.config, account mappings from context.integrationsConfig
  2. Initialize ynab SDK: new ynab.API(process.env.YNAB_ACCESS_TOKEN)
  3. Iterate integrations.accounts[] where enabled=true, init bank clients per entry (skip if token env var missing)
  4. Ensure financial_accounts rows exist for each configured account (upsert from integrations config)
  5. Set running = true
  6. Run initial bank sync immediately
  7. Start bankPollTimer with setInterval(syncIntervalMs)
  8. Start categorySyncTimer with setInterval(categorySyncIntervalMs)
  9. Register config:reloaded listener

stop():
  1. Set running = false
  2. Clear both timers
  3. eventBus.off() for config:reloaded listener

bankPoll():
  1. For each bank account:
     a. from = last_sync_at (or 30 days ago if first run)
     b. Fetch transactions from bank API
     c. Normalize → INSERT OR IGNORE into financial_transactions
     d. Collect genuinely new rows (those that were inserted, not ignored)
     e. Push new transactions to YNAB in bulk (with import_id)
     f. Store ynab_transaction_id from response
     g. Update last_sync_at
     h. Emit financial:transaction:recorded for each new tx
  2. On bank error: logger.warn(), continue to next account
  3. On YNAB error: logger.warn('YNAB push failed, will retry'), local data is safe

categorySync():
  1. For each YNAB account:
     a. GET transactions with last_knowledge_of_server
     b. For each tx with category_name set:
        UPDATE financial_transactions SET ynab_category = ? WHERE ynab_transaction_id = ?
     c. Update stored server_knowledge
  2. On error: logger.warn(), retry next cycle
```

### Rate Limit Handling

**Monobank**: 1 req/60s per endpoint. Stagger multiple accounts with 61-second `setTimeout` gaps.
**PrivatBank**: Undocumented — use 5s delay between requests as precaution.
**YNAB**: 200 req/hour. With hourly sync, typical usage is ~5-10 requests per cycle (well within limits). Cache report responses for 5 minutes to avoid unnecessary calls from API endpoints.

### API Routes

Register in `packages/core/src/api/routes/financial.ts`:
- `GET /api/financial/transactions` — local DB query (fast)
- `GET /api/financial/accounts` — local DB + YNAB mapping status
- `GET /api/financial/report?month=YYYY-MM` — proxied from YNAB month summary, briefly cached
- `GET /api/financial/categories` — YNAB categories, cached on category sync

### Existing Code to Reuse

- **`generateId()`** from `@raven/shared` — for event and record IDs
- **`SuiteService` type** from `@raven/core/suite-registry/service-runner.ts`
- **`defineSuite()`** from `@raven/shared` — suite manifest helper
- **`createLogger()`** from `@raven/shared` — component logger
- **Drive-watcher polling pattern** — timer setup, config reload, graceful error handling
- **Email-watcher service pattern** — module-level state, start/stop lifecycle
- **Migration system** — auto-runs on boot, file-driven, no code changes needed
- **Existing config loaders** in `packages/core/src/config/` — follow same read-validate-export pattern for integrations config
- **`config:reloaded` event pattern** — used by pipeline-loader, permission-engine, drive-watcher for hot-reload

### Files That Will NOT Be Modified

- `packages/core/src/orchestrator/orchestrator.ts` — no orchestrator changes
- `packages/core/src/pipeline-engine/` — events can trigger pipelines automatically
- `packages/core/src/suite-registry/` — auto-discovers new suites
- `packages/core/src/db/migrations.ts` — auto-picks up new .sql files

### Testing Pattern

- Mock `global.fetch` via `vi.fn()` for bank API responses
- Mock `ynab` module: `vi.mock('ynab', () => ({ API: vi.fn(() => mockYnabApi) }))`
- Use temp SQLite DBs via `mkdtempSync()` for database isolation
- Create mock event bus with `{ emit: vi.fn(), on: vi.fn(), off: vi.fn() }`
- Use `vi.useFakeTimers()` for polling interval control
- Test bank→local dedup: insert same bank_tx_id twice, verify one row
- Test local→YNAB push: verify import_id format, milliunits conversion, bulk create call
- Test YNAB dedup: same import_id silently skipped, no error
- Test category sync: YNAB returns categorized tx, local ynab_category updated
- Test YNAB error isolation: bank sync succeeds even if YNAB push fails
- Test report proxy: month endpoint returns YNAB category breakdown

### Setup Documentation (docs/)

Three setup guides following the existing docs pattern (see `docs/TELEGRAM_SETUP.md` for style reference):

**`docs/MONOBANK_SETUP.md`:**
1. Prerequisites: Monobank app installed
2. Get personal API token: visit https://api.monobank.ua/, scan QR with Monobank app, copy token
3. Verify token: `curl -H "X-Token: $MONOBANK_TOKEN" https://api.monobank.ua/personal/client-info`
4. Find account IDs from the client-info response (default account = `"0"`, named accounts have unique IDs)
5. Add to `.env`: `MONOBANK_TOKEN=<token>`
6. Add account entry to `config/integrations.json` with `bank: "monobank"`, `bankAccountId`, `displayName`, `ynabAccountId`
7. Troubleshooting: token expired (re-scan QR), rate limit errors (1 req/60s), multiple accounts

**`docs/PRIVATBANK_SETUP.md`:**
1. Prerequisites: Privat24 Business account
2. Activate AutoClient API: Privat24 Business → Accounting & Reports → Integration (AutoClient) → Activate → API → fill fields → Save → Install → copy token
3. Find your IBAN: Privat24 → Account details → copy IBAN (starts with `UA`)
4. "Vlasnyy rahunok" (Власний рахунок) = standard current account, identified by its IBAN
5. Verify: curl example to test statement endpoint
6. Add to `.env`: `PRIVATBANK_TOKEN=<token>`
7. Add account entry to `config/integrations.json` with `bank: "privatbank"`, `iban`, `displayName`, `ynabAccountId`
8. Troubleshooting: token activation issues, IBAN format, API response codes

**`docs/YNAB_SETUP.md`:**
1. Prerequisites: YNAB subscription
2. Create personal access token: YNAB → Account Settings → Developer Settings → New Token → copy
3. Find plan (budget) ID: `curl -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" https://api.ynab.com/v1/plans` — or use `"default"` shorthand
4. Find account IDs: `curl -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" https://api.ynab.com/v1/plans/default/accounts` — note the UUID for each account you want to map
5. Create YNAB accounts if needed (one per bank account, e.g., "Monobank Black", "PrivatBank")
6. Add to `.env`: `YNAB_ACCESS_TOKEN=<token>`
7. Configure `config/integrations.json`: set `ynab.planId`, map each bank account to its `ynabAccountId`
8. Verify: run Raven, check logs for successful sync
9. Troubleshooting: token expired (regenerate), rate limits (200/hr), plan ID not found, account ID mismatch

### Previous Story Intelligence (8.2 Learnings)

- **Config hot-reload pattern**: The `config:reloaded` handler must re-read `suites.json` from disk — do NOT expect config data as a 2nd argument to the event handler.
- **Typed event emission**: Use typed event interfaces when calling `eventBus.emit()`.
- **Resource cleanup in stop()**: Always call `eventBus.off()` to unregister listeners.
- **Standard JSON**: Monobank returns standard JSON arrays (not NDJSON) — simpler parsing than drive-watcher.

### Project Structure Notes

- **New shared config**: `config/integrations.json` (used by all suites, not just financial)
- **New config loader**: `packages/core/src/config/integrations-config.ts`
- **New shared types**: `packages/shared/src/types/integrations-config.ts` (Zod schema + types)
- **New suite** at `suites/financial-tracking/`
- **Migration** at `migrations/013-financial-tracking.sql`
- **API routes** at `packages/core/src/api/routes/financial.ts`
- **Constants** in `packages/shared/src/suites/constants.ts`
- **Events** in `packages/shared/src/types/events.ts`
- **Setup docs**: `docs/MONOBANK_SETUP.md`, `docs/PRIVATBANK_SETUP.md`, `docs/YNAB_SETUP.md`
- **`ynab` package** added to root package.json (runtime dependency)
- **ServiceContext extended** with `integrationsConfig` field
- No new workspace package — suites are loaded dynamically

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 8.3]
- [Source: _bmad-output/planning-artifacts/prd.md#FR60 — financial transaction tracking]
- [Source: suites/google-workspace/services/drive-watcher.ts — polling service pattern]
- [Source: suites/google-workspace/services/email-watcher.ts — service lifecycle pattern]
- [Source: suites/google-workspace/suite.ts — suite manifest pattern]
- [Source: packages/shared/src/types/events.ts — event type definitions]
- [Source: packages/shared/src/suites/constants.ts — source constants]
- [Source: packages/core/src/suite-registry/service-runner.ts — SuiteService interface]
- [Source: migrations/ — file-driven migration system]
- [Source: Monobank Open API — https://api.monobank.ua/docs/]
- [Source: PrivatBank AutoClient API — https://api.privatbank.ua/]
- [Source: YNAB API v1 — https://api.ynab.com/]
- [Source: ynab npm SDK — https://github.com/ynab/ynab-sdk-js]
- [Source: docs/TELEGRAM_SETUP.md — existing doc style reference]
- [Source: config/suites.json — existing config pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- All 10 tasks implemented and tested
- 14 tests passing (0 regressions — pre-existing failures in knowledge-* and email-triage are unrelated)
- `npm run check` passes clean (format + lint + type-check)
- Shared integrations config system created for reuse by future suites
- Bank API clients: Monobank (kopecks × 10 → milliunits), PrivatBank (decimal × 1000 → milliunits)
- YNAB client wraps official `ynab` SDK v4 with pushTransactions, fetchCategorizedTransactions, fetchMonthSummary, listAccounts, listCategories
- Transaction-sync service follows drive-watcher polling pattern: module-level state, config reload, graceful error handling, timer cleanup
- API routes split into smaller functions to satisfy max-lines-per-function lint rule
- Used `z.uuid()` (not deprecated `.string().uuid()`) per Zod v3.23+ API
- `ynab_server_knowledge` column added to financial_accounts for efficient YNAB delta sync

### Change Log

- 2026-03-21: Story 8.3 implemented — all tasks complete
- 2026-03-21: Code review fixes applied:
  - H1: Removed `LIMIT 1` from UPDATE (unsupported by default SQLite), fixed YNAB tx ID mapping to zip by index
  - H2: Financial API routes now lazy-init YNAB SDK from env var (was always 503)
  - M1: Config reload handler now validates with Zod `IntegrationsConfigSchema.safeParse()`
  - M3: `.env.example` added with all financial env vars (was missing or had real token)
  - M5: Removed incorrect "Власний рахунок = PrivatBank current account" claim from docs (it's a separate bank)
  - L1: Removed unused `log` variable from transaction-sync.ts

### File List

**New files:**
- config/integrations.json
- packages/shared/src/types/integrations-config.ts
- packages/core/src/config/integrations-config.ts
- packages/core/src/api/routes/financial.ts
- migrations/013-financial-tracking.sql
- suites/financial-tracking/suite.ts
- suites/financial-tracking/actions.json
- suites/financial-tracking/schedules.json
- suites/financial-tracking/services/monobank-client.ts
- suites/financial-tracking/services/privatbank-client.ts
- suites/financial-tracking/services/ynab-client.ts
- suites/financial-tracking/services/transaction-sync.ts
- suites/financial-tracking/__tests__/transaction-sync.test.ts
- docs/MONOBANK_SETUP.md
- docs/PRIVATBANK_SETUP.md
- docs/YNAB_SETUP.md

**Modified files:**
- packages/shared/src/types/index.ts (added integrations-config export)
- packages/shared/src/types/events.ts (added Financial event types + schemas)
- packages/shared/src/suites/constants.ts (added SUITE_FINANCIAL_TRACKING, SOURCE_FINANCIAL, event constants)
- packages/shared/src/suites/index.ts (exported new constants)
- packages/core/src/suite-registry/service-runner.ts (added integrationsConfig to ServiceContext)
- packages/core/src/index.ts (load integrations config, pass to baseContext)
- packages/core/src/api/server.ts (register financial routes)
- config/suites.json (added financial-tracking suite config)
- package.json + package-lock.json (added ynab dependency)
- .env.example (added financial tracking env vars)
