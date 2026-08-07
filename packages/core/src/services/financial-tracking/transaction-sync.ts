import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  generateId,
  SOURCE_FINANCIAL,
  IntegrationsConfigSchema,
  type EventBusInterface,
  type LoggerInterface,
  type DatabaseInterface,
  type IntegrationsConfig,
  type AccountEntry,
} from '@raven/shared';
import type { FinancialTransactionRecordedEvent, FinancialSyncCompleteEvent } from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import { fetchMonobankTransactions, normalizeMonobankTransactions } from './monobank-client.ts';
import type { NormalizedTransaction } from './monobank-client.ts';
import {
  fetchPrivatBankTransactions,
  normalizePrivatBankTransactions,
} from './privatbank-client.ts';
import { createYnabClient } from './ynab-client.ts';
import type { YnabClient } from './ynab-client.ts';

let running = false;
let bankPollTimer: ReturnType<typeof setInterval> | null = null;
let categorySyncTimer: ReturnType<typeof setInterval> | null = null;
let eventBus: EventBusInterface;
let logger: LoggerInterface;
let db: DatabaseInterface;
let projectRoot: string;
let integrationsConfig: IntegrationsConfig;
let ynabClient: YnabClient | null = null;
let syncIntervalMs: number;
let categorySyncIntervalMs: number;
let ynabPlanId: string;
let configReloadedHandler: ((event: unknown) => void) | null = null;

const THIRTY_DAYS_MS = 2_592_000_000; // 30 days in milliseconds
const MONOBANK_RATE_LIMIT_MS = 61_000;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000; // 24 * 60 * 60 * 1000
const DEFAULT_SYNC_PERIOD_DAYS = 30; // PrivatBank lookback window when no prior sync exists
const CATEGORY_SYNC_LOOKBACK_DAYS = 90; // Days of YNAB history to re-check for category updates
const ISO_DATE_LENGTH = 10; // Length of a YYYY-MM-DD date string
const UAH_CURRENCY_CODE = 980; // ISO 4217 numeric code for UAH
const DEFAULT_SYNC_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_CATEGORY_SYNC_INTERVAL_MS = 14_400_000; // 4 hours

function ensureAccountRow(account: AccountEntry): void {
  const bankAccountId = account.bank === 'monobank' ? account.bankAccountId : account.iban;
  const iban = account.bank === 'privatbank' ? account.iban : null;

  const existing = db.get(
    'SELECT id FROM financial_accounts WHERE bank = ? AND bank_account_id = ?',
    account.bank,
    bankAccountId,
  ) as { id: string } | undefined;

  if (!existing) {
    const id = generateId();
    db.run(
      `INSERT INTO financial_accounts (id, bank, bank_account_id, iban, currency_code, display_name, ynab_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      account.bank,
      bankAccountId,
      iban,
      account.currency === 'UAH' ? UAH_CURRENCY_CODE : 0,
      account.displayName,
      account.ynabAccountId,
    );
    logger.info(`Created financial_accounts row for ${account.displayName}`);
  }
}

function getAccountRow(
  bank: string,
  bankAccountId: string,
):
  | {
      id: string;
      last_sync_at: string | null;
      ynab_account_id: string | null;
      ynab_server_knowledge: number;
    }
  | undefined {
  return db.get(
    'SELECT id, last_sync_at, ynab_account_id, ynab_server_knowledge FROM financial_accounts WHERE bank = ? AND bank_account_id = ?',
    bank,
    bankAccountId,
  ) as
    | {
        id: string;
        last_sync_at: string | null;
        ynab_account_id: string | null;
        ynab_server_knowledge: number;
      }
    | undefined;
}

function insertTransactions(
  accountId: string,
  txs: NormalizedTransaction[],
): NormalizedTransaction[] {
  const newTxs: NormalizedTransaction[] = [];
  for (const tx of txs) {
    db.run(
      `INSERT OR IGNORE INTO financial_transactions
       (id, account_id, bank_tx_id, amount_minor, currency_code, description, mcc, is_debit, balance_after_minor, transaction_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generateId(),
      accountId,
      tx.bankTxId,
      tx.amountMinor,
      tx.currencyCode,
      tx.description,
      tx.mcc,
      tx.isDebit ? 1 : 0,
      tx.balanceAfterMinor,
      tx.transactionDate,
    );
    // INSERT OR IGNORE silently no-ops on the UNIQUE bank_tx_id constraint —
    // changes() reports whether this particular INSERT actually landed a
    // row, since DatabaseInterface.run() doesn't return a result object.
    const changed = db.get<{ c: number }>('SELECT changes() AS c');
    if (changed && changed.c > 0) {
      newTxs.push(tx);
    }
  }
  return newTxs;
}

async function pushToYnab(
  accountId: string,
  ynabAccountId: string,
  newTxs: NormalizedTransaction[],
): Promise<{ successCount: number; failCount: number }> {
  if (!ynabClient || newTxs.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  try {
    const result = await ynabClient.pushTransactions(ynabPlanId, ynabAccountId, newTxs);

    // Store ynab_transaction_id — YNAB returns IDs in input order
    for (let i = 0; i < result.transactionIds.length && i < newTxs.length; i++) {
      db.run(
        'UPDATE financial_transactions SET ynab_transaction_id = ? WHERE account_id = ? AND bank_tx_id = ?',
        result.transactionIds[i],
        accountId,
        newTxs[i].bankTxId,
      );
    }

    const pushed = newTxs.length - result.duplicateImportIds.length;
    return { successCount: pushed, failCount: 0 };
  } catch (err) {
    logger.warn(`YNAB push failed: ${(err as Error).message}`);
    return { successCount: 0, failCount: newTxs.length };
  }
}

function emitTransactionEvents(
  accountId: string,
  txs: NormalizedTransaction[],
  bank: 'monobank' | 'privatbank',
): void {
  for (const tx of txs) {
    const event: FinancialTransactionRecordedEvent = {
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_FINANCIAL,
      type: 'financial:transaction:recorded',
      payload: {
        accountId,
        bankTxId: tx.bankTxId,
        bank,
        amountMinor: tx.amountMinor,
        currencyCode: tx.currencyCode,
        description: tx.description,
        isDebit: tx.isDebit,
        transactionDate: tx.transactionDate,
      },
    };
    eventBus.emit(event as unknown);
  }
}

async function syncMonobankAccount(
  account: AccountEntry & { bank: 'monobank' },
): Promise<{ newCount: number; pushSuccess: number; pushFail: number }> {
  const token = process.env.MONOBANK_TOKEN;
  if (!token) {
    logger.warn(`MONOBANK_TOKEN not set, skipping ${account.displayName}`);
    return { newCount: 0, pushSuccess: 0, pushFail: 0 };
  }

  const row = getAccountRow('monobank', account.bankAccountId);
  if (!row) return { newCount: 0, pushSuccess: 0, pushFail: 0 };

  const from = row.last_sync_at
    ? Math.floor(new Date(row.last_sync_at).getTime() / MS_PER_SECOND)
    : Math.floor((Date.now() - THIRTY_DAYS_MS) / MS_PER_SECOND);
  const to = Math.floor(Date.now() / MS_PER_SECOND);

  const rawTxs = await fetchMonobankTransactions(token, {
    accountId: account.bankAccountId,
    from,
    to,
  });
  const normalized = normalizeMonobankTransactions(rawTxs);
  const newTxs = insertTransactions(row.id, normalized);

  let pushSuccess = 0;
  let pushFail = 0;
  if (newTxs.length > 0 && row.ynab_account_id) {
    const result = await pushToYnab(row.id, row.ynab_account_id, newTxs);
    pushSuccess = result.successCount;
    pushFail = result.failCount;
    emitTransactionEvents(row.id, newTxs, 'monobank');
  }

  db.run(
    'UPDATE financial_accounts SET last_sync_at = ? WHERE id = ?',
    new Date().toISOString(),
    row.id,
  );

  if (newTxs.length > 0) {
    logger.info(
      `Monobank ${account.displayName}: ${newTxs.length} new tx, ${pushSuccess} pushed to YNAB`,
    );
  }

  return { newCount: newTxs.length, pushSuccess, pushFail };
}

async function syncPrivatBankAccount(
  account: AccountEntry & { bank: 'privatbank' },
): Promise<{ newCount: number; pushSuccess: number; pushFail: number }> {
  const token = process.env.PRIVATBANK_TOKEN;
  if (!token) {
    logger.warn(`PRIVATBANK_TOKEN not set, skipping ${account.displayName}`);
    return { newCount: 0, pushSuccess: 0, pushFail: 0 };
  }

  const row = getAccountRow('privatbank', account.iban);
  if (!row) return { newCount: 0, pushSuccess: 0, pushFail: 0 };

  const periodDays = row.last_sync_at
    ? Math.ceil((Date.now() - new Date(row.last_sync_at).getTime()) / MS_PER_DAY) + 1
    : DEFAULT_SYNC_PERIOD_DAYS;

  const rawTxs = await fetchPrivatBankTransactions(token, account.iban, periodDays);
  const normalized = normalizePrivatBankTransactions(rawTxs);
  const newTxs = insertTransactions(row.id, normalized);

  let pushSuccess = 0;
  let pushFail = 0;
  if (newTxs.length > 0 && row.ynab_account_id) {
    const result = await pushToYnab(row.id, row.ynab_account_id, newTxs);
    pushSuccess = result.successCount;
    pushFail = result.failCount;
    emitTransactionEvents(row.id, newTxs, 'privatbank');
  }

  db.run(
    'UPDATE financial_accounts SET last_sync_at = ? WHERE id = ?',
    new Date().toISOString(),
    row.id,
  );

  if (newTxs.length > 0) {
    logger.info(
      `PrivatBank ${account.displayName}: ${newTxs.length} new tx, ${pushSuccess} pushed to YNAB`,
    );
  }

  return { newCount: newTxs.length, pushSuccess, pushFail };
}

interface SyncTally {
  totalNew: number;
  totalPushSuccess: number;
  totalPushFail: number;
  accountsSynced: number;
}

// Returns false if the poll was interrupted by a stop() mid-loop (caller should
// abort the whole bankPoll run without emitting the sync-complete event).
async function syncMonoAccounts(
  accounts: Array<AccountEntry & { bank: 'monobank' }>,
  tally: SyncTally,
): Promise<boolean> {
  // Stagger Monobank accounts by 61s to respect rate limit
  for (let i = 0; i < accounts.length; i++) {
    if (!running) return false;
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, MONOBANK_RATE_LIMIT_MS));
    }
    try {
      const result = await syncMonobankAccount(accounts[i]);
      tally.totalNew += result.newCount;
      tally.totalPushSuccess += result.pushSuccess;
      tally.totalPushFail += result.pushFail;
      tally.accountsSynced++;
    } catch (err) {
      logger.warn(`Monobank sync failed for ${accounts[i].displayName}: ${(err as Error).message}`);
    }
  }
  return true;
}

async function syncPrivatAccounts(
  accounts: Array<AccountEntry & { bank: 'privatbank' }>,
  tally: SyncTally,
): Promise<boolean> {
  for (const account of accounts) {
    if (!running) return false;
    try {
      const result = await syncPrivatBankAccount(account);
      tally.totalNew += result.newCount;
      tally.totalPushSuccess += result.pushSuccess;
      tally.totalPushFail += result.pushFail;
      tally.accountsSynced++;
    } catch (err) {
      logger.warn(`PrivatBank sync failed for ${account.displayName}: ${(err as Error).message}`);
    }
  }
  return true;
}

async function bankPoll(): Promise<void> {
  if (!running) return;

  const enabledAccounts = integrationsConfig.accounts.filter((a) => a.enabled);
  const tally: SyncTally = {
    totalNew: 0,
    totalPushSuccess: 0,
    totalPushFail: 0,
    accountsSynced: 0,
  };

  const monoAccounts = enabledAccounts.filter(
    (a): a is AccountEntry & { bank: 'monobank' } => a.bank === 'monobank',
  );
  const privatAccounts = enabledAccounts.filter(
    (a): a is AccountEntry & { bank: 'privatbank' } => a.bank === 'privatbank',
  );

  if (!(await syncMonoAccounts(monoAccounts, tally))) return;
  if (!(await syncPrivatAccounts(privatAccounts, tally))) return;

  const syncEvent: FinancialSyncCompleteEvent = {
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_FINANCIAL,
    type: 'financial:sync-complete',
    payload: {
      newTransactionCount: tally.totalNew,
      ynabPushSuccessCount: tally.totalPushSuccess,
      ynabPushFailCount: tally.totalPushFail,
      accountsSynced: tally.accountsSynced,
    },
  };
  eventBus.emit(syncEvent as unknown);
}

async function categorySync(): Promise<void> {
  if (!running || !ynabClient) return;

  const accounts = db.all(
    'SELECT id, ynab_account_id, ynab_server_knowledge FROM financial_accounts WHERE ynab_account_id IS NOT NULL',
  ) as Array<{ id: string; ynab_account_id: string; ynab_server_knowledge: number }>;

  for (const account of accounts) {
    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - CATEGORY_SYNC_LOOKBACK_DAYS);

      const result = await ynabClient.fetchCategorizedTransactions(
        ynabPlanId,
        account.ynab_account_id,
        {
          sinceDate: sinceDate.toISOString().slice(0, ISO_DATE_LENGTH),
          serverKnowledge: account.ynab_server_knowledge || undefined,
        },
      );

      for (const tx of result.transactions) {
        if (tx.categoryName) {
          db.run(
            'UPDATE financial_transactions SET ynab_category = ? WHERE ynab_transaction_id = ?',
            tx.categoryName,
            tx.id,
          );
        }
      }

      db.run(
        'UPDATE financial_accounts SET ynab_server_knowledge = ? WHERE id = ?',
        result.serverKnowledge,
        account.id,
      );

      if (result.transactions.length > 0) {
        logger.info(
          `Category sync: ${result.transactions.length} transactions updated for account ${account.id}`,
        );
      }
    } catch (err) {
      logger.warn(`Category sync failed for account ${account.id}: ${(err as Error).message}`);
    }
  }
}

function resolveServiceConfig(config: Record<string, unknown>): void {
  syncIntervalMs = (config.syncIntervalMs as number) ?? DEFAULT_SYNC_INTERVAL_MS;
  categorySyncIntervalMs =
    (config.categorySyncIntervalMs as number) ?? DEFAULT_CATEGORY_SYNC_INTERVAL_MS;
  ynabPlanId = (config.ynabPlanId as string) ?? 'default';

  // Override from env vars if set
  if (process.env.FINANCIAL_SYNC_INTERVAL_MS) {
    syncIntervalMs = Number(process.env.FINANCIAL_SYNC_INTERVAL_MS);
  }
  if (process.env.FINANCIAL_CATEGORY_SYNC_INTERVAL_MS) {
    categorySyncIntervalMs = Number(process.env.FINANCIAL_CATEGORY_SYNC_INTERVAL_MS);
  }
}

function initializeYnabClient(): void {
  const ynabToken = process.env.YNAB_ACCESS_TOKEN;
  if (!ynabToken) {
    logger.warn('YNAB_ACCESS_TOKEN not set — transactions will be stored locally only');
  } else {
    ynabClient = createYnabClient(ynabToken);
  }
}

function resolveEnabledAccounts(): AccountEntry[] | null {
  const enabledAccounts = integrationsConfig.accounts.filter((a) => a.enabled);
  if (enabledAccounts.length === 0) {
    logger.info(
      'No accounts configured in config/integrations.json — see docs/MONOBANK_SETUP.md, docs/YNAB_SETUP.md',
    );
    return null;
  }

  for (const account of enabledAccounts) {
    ensureAccountRow(account);
  }

  return enabledAccounts;
}

function startPolling(): void {
  // Recurring bank poll
  bankPollTimer = setInterval(() => {
    void bankPoll();
  }, syncIntervalMs);

  // Recurring category sync
  categorySyncTimer = setInterval(() => {
    void categorySync();
  }, categorySyncIntervalMs);
}

function reloadIntegrationsConfig(): void {
  const intPath = resolve(projectRoot, 'config', 'integrations.json');
  if (!existsSync(intPath)) return;
  const parsed = IntegrationsConfigSchema.safeParse(JSON.parse(readFileSync(intPath, 'utf-8')));
  if (!parsed.success) {
    logger.warn(`Invalid integrations.json on reload: ${parsed.error.message}`);
    return;
  }
  integrationsConfig = parsed.data;
  logger.info('Integrations config reloaded');
}

function buildConfigReloadedHandler(): (event: unknown) => void {
  return (event: unknown) => {
    const e = event as { payload?: { configType?: string } };
    const configType = e.payload?.configType;
    if (configType !== 'integrations') return;

    try {
      reloadIntegrationsConfig();
    } catch (err) {
      logger.warn(`Failed to reload config: ${(err as Error).message}`);
    }
  };
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    db = context.db;
    projectRoot = context.projectRoot;
    integrationsConfig = context.integrationsConfig;

    resolveServiceConfig(context.config as Record<string, unknown>);
    initializeYnabClient();

    const enabledAccounts = resolveEnabledAccounts();
    if (!enabledAccounts) return;

    running = true;

    // Initial sync
    await bankPoll();

    startPolling();

    // Config reload handler
    configReloadedHandler = buildConfigReloadedHandler();
    eventBus.on('config:reloaded', configReloadedHandler);

    logger.info(
      `Financial transaction sync started: ${enabledAccounts.length} account(s), poll every ${syncIntervalMs}ms`,
    );
  },

  async stop(): Promise<void> {
    running = false;
    if (bankPollTimer) {
      clearInterval(bankPollTimer);
      bankPollTimer = null;
    }
    if (categorySyncTimer) {
      clearInterval(categorySyncTimer);
      categorySyncTimer = null;
    }
    if (configReloadedHandler && eventBus) {
      eventBus.off('config:reloaded', configReloadedHandler);
      configReloadedHandler = null;
    }
    ynabClient = null;
    logger?.info('Financial transaction sync stopped');
  },
};

export default service;
