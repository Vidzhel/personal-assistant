import * as ynab from 'ynab';
import { createLogger } from '@raven/shared';
import type { NormalizedTransaction } from './monobank-client.ts';

const log = createLogger('ynab-client');

const MAX_PAYEE_NAME_LENGTH = 200; // YNAB payee_name field max length
const MAX_MEMO_LENGTH = 500; // YNAB memo field max length

export interface PushResult {
  duplicateImportIds: string[];
  transactionIds: string[];
}

export interface YnabTransactionWithCategory {
  id: string;
  categoryName: string | null | undefined;
}

export interface FetchCategorizedTransactionsOptions {
  sinceDate: string;
  serverKnowledge?: number;
}

export interface MonthCategoryDetail {
  name: string;
  budgeted: number;
  activity: number;
  balance: number;
}

export interface MonthSummary {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  categories: MonthCategoryDetail[];
}

export interface YnabClient {
  pushTransactions(
    planId: string,
    accountId: string,
    transactions: NormalizedTransaction[],
  ): Promise<PushResult>;
  fetchCategorizedTransactions(
    planId: string,
    accountId: string,
    options: FetchCategorizedTransactionsOptions,
  ): Promise<{ transactions: YnabTransactionWithCategory[]; serverKnowledge: number }>;
  fetchMonthSummary(planId: string, month: string): Promise<MonthSummary>;
  listAccounts(planId: string): Promise<ynab.Account[]>;
  listCategories(planId: string): Promise<ynab.CategoryGroupWithCategories[]>;
}

function buildYnabSaveTransactions(
  accountId: string,
  transactions: NormalizedTransaction[],
): ynab.NewTransaction[] {
  return transactions.map((tx) => ({
    account_id: accountId,
    date: tx.transactionDate,
    amount: tx.milliunits,
    payee_name: tx.description.slice(0, MAX_PAYEE_NAME_LENGTH),
    memo: tx.memo?.slice(0, MAX_MEMO_LENGTH) ?? undefined,
    cleared: ynab.TransactionClearedStatus.Cleared,
    approved: false,
    import_id: tx.importId,
  }));
}

function mapYnabTransactionsWithCategory(
  transactions: ynab.TransactionDetail[],
): YnabTransactionWithCategory[] {
  return transactions.map((tx) => ({
    id: tx.id,
    categoryName: tx.category_name,
  }));
}

function mapYnabCategories(categories: ynab.Category[]): MonthCategoryDetail[] {
  return categories.map((cat) => ({
    name: cat.name,
    budgeted: cat.budgeted,
    activity: cat.activity,
    balance: cat.balance,
  }));
}

interface PushTransactionsParams {
  planId: string;
  accountId: string;
  transactions: NormalizedTransaction[];
}

async function pushTransactionsImpl(
  api: ynab.API,
  params: PushTransactionsParams,
): Promise<PushResult> {
  const { planId, accountId, transactions } = params;
  if (transactions.length === 0) {
    return { duplicateImportIds: [], transactionIds: [] };
  }

  const response = await api.transactions.createTransaction(planId, {
    transactions: buildYnabSaveTransactions(accountId, transactions),
  });

  const data = response.data;
  return {
    duplicateImportIds: data.duplicate_import_ids ?? [],
    transactionIds: (data.transaction_ids ?? []) as string[],
  };
}

interface FetchCategorizedTransactionsParams {
  planId: string;
  accountId: string;
  options: FetchCategorizedTransactionsOptions;
}

async function fetchCategorizedTransactionsImpl(
  api: ynab.API,
  params: FetchCategorizedTransactionsParams,
): Promise<{ transactions: YnabTransactionWithCategory[]; serverKnowledge: number }> {
  const { planId, accountId, options } = params;
  const { sinceDate, serverKnowledge } = options;
  const response = await api.transactions.getTransactionsByAccount(
    planId,
    accountId,
    sinceDate,
    undefined, // type
    serverKnowledge,
  );

  return {
    transactions: mapYnabTransactionsWithCategory(response.data.transactions),
    serverKnowledge: response.data.server_knowledge,
  };
}

interface FetchMonthSummaryParams {
  planId: string;
  month: string;
}

async function fetchMonthSummaryImpl(
  api: ynab.API,
  params: FetchMonthSummaryParams,
): Promise<MonthSummary> {
  const { planId, month } = params;
  const response = await api.months.getPlanMonth(planId, month);
  const monthData = response.data.month;

  return {
    month: monthData.month,
    income: monthData.income,
    budgeted: monthData.budgeted,
    activity: monthData.activity,
    categories: mapYnabCategories(monthData.categories ?? []),
  };
}

export function createYnabClient(accessToken: string): YnabClient {
  const api = new ynab.API(accessToken);

  return {
    async pushTransactions(
      planId: string,
      accountId: string,
      transactions: NormalizedTransaction[],
    ): Promise<PushResult> {
      return pushTransactionsImpl(api, { planId, accountId, transactions });
    },

    async fetchCategorizedTransactions(
      planId: string,
      accountId: string,
      options: FetchCategorizedTransactionsOptions,
    ): Promise<{ transactions: YnabTransactionWithCategory[]; serverKnowledge: number }> {
      return fetchCategorizedTransactionsImpl(api, { planId, accountId, options });
    },

    async fetchMonthSummary(planId: string, month: string): Promise<MonthSummary> {
      return fetchMonthSummaryImpl(api, { planId, month });
    },

    async listAccounts(planId: string): Promise<ynab.Account[]> {
      const response = await api.accounts.getAccounts(planId);
      return response.data.accounts;
    },

    async listCategories(planId: string): Promise<ynab.CategoryGroupWithCategories[]> {
      const response = await api.categories.getCategories(planId);
      return response.data.category_groups;
    },
  };
}

log.debug('YNAB client module loaded');
