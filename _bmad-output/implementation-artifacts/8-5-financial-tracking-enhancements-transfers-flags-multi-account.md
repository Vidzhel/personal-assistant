# Story 8.5: Financial Tracking Enhancements — Transfer Detection & Multi-Account

Status: ready-for-dev

## Story

As the system operator,
I want Raven's financial sync to detect inter-account transfers (creating YNAB transfers instead of spending transactions) and support multiple Monobank cards mapped to separate YNAB accounts,
so that my YNAB budget accurately reflects transfers vs. spending and I can track each card individually.

## Scope Notes

**Deferred:**
- PrivatBank personal (Privat24) integration — personal API (`rest_fiz`) was shut down Nov 2022. No replacement exists. Waiting for NBU open banking (Regulation No. 80) to bring standardized APIs. Expected late 2026. Telegram notification parsing is a viable interim option but deferred for now.
- BVR bank (bvr.ua / VST Bank) — no public API. Same open banking dependency.
- Purple flag on imports — not needed. `approved: false` (already implemented) puts transactions in YNAB's "Unapproved" state which serves as "For Review".

## Acceptance Criteria

1. **Given** a transaction from Monobank account A is detected as a transfer to another tracked account B (matching counterparty account), **when** it is pushed to YNAB, **then** the transaction uses `payee_id` set to the target account's `transfer_payee_id` (creating a YNAB transfer) instead of `payee_name` (which would create a spending transaction). The corresponding inflow on account B is auto-created by YNAB.

2. **Given** a PrivatBank transaction where `AUT_CNTR_ACC` (counterparty IBAN) matches another tracked account's IBAN in `config/integrations.json`, **when** the sync processes both sides, **then** only ONE YNAB transfer is created (not two spending transactions), and the duplicate side is suppressed.

3. **Given** `config/integrations.json` has multiple Monobank accounts with different `bankAccountId` values, **when** the sync runs, **then** each card/account is tracked separately and routed to its own YNAB account per the config mapping.

4. **Given** the YNAB accounts have been fetched via `listAccounts()`, **when** the transfer detection needs `transfer_payee_id` values, **then** they are cached locally (in memory) and refreshed on config reload, to avoid extra API calls per transaction.

5. **Given** two tracked accounts are counterparties to each other, **when** both sides fetch the same transfer from their respective bank APIs, **then** only the debit (outflow) side pushes the YNAB transfer. The credit (inflow) side is stored locally but skipped for YNAB push.

## Tasks / Subtasks

- [ ] Task 1: Build transfer detection logic (AC: #1, #2, #4)
  - [ ] Add `transfer_payee_id` cache: on service start and config reload, call `ynabClient.listAccounts(planId)` and build a `Map<ynabAccountId, transferPayeeId>` from the account data
  - [ ] Add `buildAccountLookupMap()` helper: from `integrationsConfig.accounts`, build a `Map<iban|bankAccountId, ynabAccountId>` of all tracked accounts for counterparty matching
  - [ ] In `NormalizedTransaction`, add optional `counterpartyAccount: string | null` field
  - [ ] In `normalizePrivatBankTransaction()`: use `AUT_CNTR_ACC` field as `counterpartyAccount`
  - [ ] In `normalizeMonobankTransaction()`: for intra-Monobank transfers, use amount+date correlation heuristic across tracked accounts (same absolute amount, same day, opposite sign). Monobank statement API does not expose counterparty IBAN directly.
  - [ ] Create `detectTransfer(tx: NormalizedTransaction, accountLookupMap, transferPayeeIdMap)` function:
    1. Check if `tx.counterpartyAccount` matches any tracked account in accountLookupMap
    2. If match → return `{ isTransfer: true, targetYnabAccountId, transferPayeeId }`
    3. If no match → return `{ isTransfer: false }`

- [ ] Task 2: Modify YNAB push to use transfer payee for detected transfers (AC: #1, #2)
  - [ ] In `pushTransactions()`, accept an optional `transferMap: Map<string, { transferPayeeId: string }>` keyed by `importId`
  - [ ] When building `SaveTransaction`: if `transferMap.has(tx.importId)`, set `payee_id: transferMap.get(tx.importId).transferPayeeId` and omit `payee_name`. Otherwise, use `payee_name` as before.
  - [ ] In `transaction-sync.ts` `pushToYnab()`, before calling `ynabClient.pushTransactions()`, build the transferMap by running `detectTransfer()` on each transaction

- [ ] Task 3: Deduplicate transfer pairs to avoid double-push (AC: #2, #5)
  - [ ] When two tracked accounts are counterparties to each other, both sides will fetch the same transfer from their respective bank APIs
  - [ ] Strategy: the account with the **outflow** (debit) side creates the YNAB transfer. The inflow (credit) side skips the YNAB push for that transaction (YNAB auto-creates the matching inflow).
  - [ ] In `bankPoll()`, after collecting all normalized transactions across all accounts, run a dedup pass:
    1. For each transaction flagged as a transfer where `isDebit === false` (credit/inflow), check if the counterparty account is also tracked
    2. If yes, mark it as `skipYnabPush: true` — the debit side's transfer push will auto-create this inflow in YNAB
  - [ ] Add `skipYnabPush` boolean to `NormalizedTransaction`
  - [ ] Still INSERT the transaction locally (for local records), just skip YNAB push

- [ ] Task 4: Update setup documentation (AC: #3)
  - [ ] Update `docs/MONOBANK_SETUP.md`: add section on tracking multiple cards — explain how to find each account's `bankAccountId` from `GET /personal/client-info`, and how to map each to a separate YNAB account in `config/integrations.json`
  - [ ] Update `docs/PRIVATBANK_SETUP.md`: add note that personal Privat24 API was shut down Nov 2022. Only AutoClient (business/FOP) is supported. Open banking integration expected late 2026.
  - [ ] Create `docs/BVR_SETUP.md` stub: explain that BVR (bvr.ua / VST Bank) has no public API. Mention NBU open banking (Regulation No. 80) as future option.

- [ ] Task 5: Tests (AC: #1-#5)
  - [ ] Test: Transfer detection identifies matching counterparty IBAN across tracked accounts
  - [ ] Test: Transfer uses `payee_id` (transfer_payee_id) instead of `payee_name`
  - [ ] Test: Credit-side of a transfer is skipped for YNAB push (dedup)
  - [ ] Test: Non-transfer transactions still use `payee_name` as before
  - [ ] Test: Transfer payee ID cache is built from YNAB account list
  - [ ] Test: Multiple Monobank accounts sync independently to different YNAB accounts
  - [ ] Mock `ynabClient.listAccounts()` to return accounts with `transfer_payee_id` fields

## Dev Notes

### Transfer Detection — YNAB API Details

Each YNAB account has a `transfer_payee_id` field (UUID). To create a transfer:

```typescript
// Instead of:
payee_name: "Transfer to savings"

// Use:
payee_id: targetAccount.transfer_payee_id  // from listAccounts() response
// Do NOT set payee_name when using payee_id
```

YNAB automatically creates the matching transaction on the target account. Only push the outflow (debit) side — YNAB handles the inflow.

### Transfer Detection Heuristics

**PrivatBank**: Straightforward — `AUT_CNTR_ACC` contains the counterparty IBAN. Compare against all tracked account IBANs in `integrationsConfig.accounts`.

**Monobank**: Harder — the statement API doesn't expose counterparty IBAN directly. For intra-Monobank transfers between own accounts, use amount+date correlation: if the same absolute amount appears on two tracked Monobank accounts within the same day with opposite signs (one debit, one credit), treat as a transfer. This is imperfect but catches most own-account transfers. Can refine later if Monobank adds counterparty data to the API.

### Avoiding Double Transfers

When account A sends to account B, both are tracked:
- A sees a debit transaction (outflow)
- B sees a credit transaction (inflow)

If we push both to YNAB as transfers, we'd get 4 transactions (each side creates a pair). Solution:
- Only the **debit side** pushes to YNAB as a transfer
- The **credit side** is stored locally but skipped for YNAB push
- YNAB auto-creates the inflow on B when A's transfer is pushed

### Multi-Card Monobank Support

Already works in the schema — `config/integrations.json` supports multiple entries with `bank: "monobank"` and different `bankAccountId` values. User needs to:
1. Call `GET /personal/client-info` to list all accounts
2. Each account has an `id` (use as `bankAccountId`) and `type` (e.g., "black", "white", "platinum")
3. Map each to a separate YNAB account in the config

The only code work is documentation — the sync loop already iterates all enabled accounts.

### PrivatBank Personal — Research Summary (Deferred)

Personal API (`rest_fiz`) shut down Nov 25, 2022. No replacement. Options for future:
- **NBU open banking** (Regulation No. 80) — expected late 2026
- **Telegram notification parsing** — intercept `@PrivatBankBot` messages via userbot (MTProto). Proven approach: [firefly-iii-privatbank-importer](https://github.com/skynet2/firefly-iii-privatbank-importer). Limited data per notification.
- **FOP + AutoClient** — ~1,200 UAH/mo if employed. Only covers FOP account, not personal card.

### BVR Bank (bvr.ua) — No API Available

Neobank by JST "VST Bank". No public API, no developer portal. NBU open banking compliance expected late 2026.

### Existing Code to Modify

- `suites/financial-tracking/services/ynab-client.ts` — modify `pushTransactions` to accept transfer map, use `payee_id` for transfers
- `suites/financial-tracking/services/monobank-client.ts` — add `counterpartyAccount` to `NormalizedTransaction`
- `suites/financial-tracking/services/privatbank-client.ts` — populate `counterpartyAccount` from `AUT_CNTR_ACC`
- `suites/financial-tracking/services/transaction-sync.ts` — transfer detection, dedup logic, transfer payee cache
- `docs/MONOBANK_SETUP.md` — add multi-card section
- `docs/PRIVATBANK_SETUP.md` — add personal API shutdown note
- New: `docs/BVR_SETUP.md` — stub

### Files That Will NOT Be Modified

- `packages/shared/src/types/integrations-config.ts` — schema already supports multiple accounts per bank
- `packages/shared/src/types/events.ts` — no new event types needed
- `migrations/` — no schema changes needed
- `packages/core/` — no core changes needed
- `config/suites.json` — no config changes needed

### Testing Pattern

Same as 8.3:
- Mock `global.fetch` for bank APIs
- Mock `ynab` module with `vi.fn()` for SDK calls
- Add `listAccounts` mock returning accounts with `transfer_payee_id`
- Temp SQLite DBs for isolation
- `vi.useFakeTimers()` for poll cycle control

### Previous Story Intelligence (8.3 Learnings)

- Removed `LIMIT 1` from UPDATE (unsupported by default SQLite)
- Financial API routes lazy-init YNAB SDK from env var
- Config reload validates with Zod `safeParse()`
- `ynab` SDK v4 uses ESM, imports work with `import * as ynab from 'ynab'`
- `approved: false` already makes transactions show as "unapproved" in YNAB — no additional flag needed for "For Review"

### Project Structure Notes

- No new files in `packages/shared/` or `packages/core/` — changes scoped to `suites/financial-tracking/` and `docs/`
- One new doc: `docs/BVR_SETUP.md`
- All other changes are modifications to existing files

### References

- [Source: suites/financial-tracking/services/ynab-client.ts — current push implementation, line 62-71]
- [Source: suites/financial-tracking/services/transaction-sync.ts — current sync orchestration]
- [Source: suites/financial-tracking/services/monobank-client.ts — NormalizedTransaction type]
- [Source: suites/financial-tracking/services/privatbank-client.ts — AUT_CNTR_ACC field]
- [Source: packages/shared/src/types/integrations-config.ts — AccountEntry schema]
- [Source: config/integrations.json — account mapping config]
- [Source: YNAB API — Account.transfer_payee_id for transfer creation]
- [Source: YNAB API — SaveTransaction.payee_id overrides payee_name for transfers]
- [Source: YNAB API — approved: false for unapproved/review state]
- [Source: Monobank API — /personal/client-info returns all accounts with IDs]
- [Source: PrivatBank AutoClient API — AUT_CNTR_ACC = counterparty IBAN]
- [Source: PrivatBank rest_fiz API — shut down Nov 25, 2022]
- [Source: NBU open banking — Regulation No. 80, compliance deadline Jan 2026, market expected late 2026]
- [Source: firefly-iii-privatbank-importer — reference for Telegram notification parsing approach]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
