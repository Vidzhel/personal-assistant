import * as ynab from 'ynab';
import { createLogger } from '@raven/shared';
import type { NormalizedTransaction } from './monobank-client.ts';

const log = createLogger('ynab-client');

export interface PushResult {
  duplicateImportIds: string[];
  transactionIds: string[];
}

export interface YnabTransactionWithCategory {
  id: string;
  categoryName: string | null | undefined;
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
    sinceDate: string,
    serverKnowledge?: number,
  ): Promise<{ transactions: YnabTransactionWithCategory[]; serverKnowledge: number }>;
  fetchMonthSummary(planId: string, month: string): Promise<MonthSummary>;
  listAccounts(planId: string): Promise<ynab.Account[]>;
  listCategories(planId: string): Promise<ynab.CategoryGroupWithCategories[]>;
}

export function createYnabClient(accessToken: string): YnabClient {
  const api = new ynab.API(accessToken);

  return {
    async pushTransactions(
      planId: string,
      accountId: string,
      transactions: NormalizedTransaction[],
    ): Promise<PushResult> {
      if (transactions.length === 0) {
        return { duplicateImportIds: [], transactionIds: [] };
      }

      const saveTransactions: ynab.SaveTransaction[] = transactions.map((tx) => ({
        account_id: accountId,
        date: tx.transactionDate,
        amount: tx.milliunits,
        payee_name: tx.description.slice(0, 200),
        memo: tx.memo?.slice(0, 500) ?? undefined,
        cleared: ynab.SaveTransaction.ClearedEnum.Cleared,
        approved: false,
        import_id: tx.importId,
      }));

      const response = await api.transactions.createTransactions(planId, {
        transactions: saveTransactions,
      });

      const data = response.data;
      return {
        duplicateImportIds: data.duplicate_import_ids ?? [],
        transactionIds: (data.transaction_ids ?? []) as string[],
      };
    },

    async fetchCategorizedTransactions(
      planId: string,
      accountId: string,
      sinceDate: string,
      serverKnowledge?: number,
    ): Promise<{ transactions: YnabTransactionWithCategory[]; serverKnowledge: number }> {
      const response = await api.transactions.getTransactionsByAccount(
        planId,
        accountId,
        sinceDate,
        undefined, // type
        serverKnowledge,
      );

      const txs = response.data.transactions.map((tx) => ({
        id: tx.id,
        categoryName: tx.category_name,
      }));

      return {
        transactions: txs,
        serverKnowledge: response.data.server_knowledge,
      };
    },

    async fetchMonthSummary(planId: string, month: string): Promise<MonthSummary> {
      const response = await api.months.getBudgetMonth(planId, month);
      const monthData = response.data.month;

      const categories: MonthCategoryDetail[] = (monthData.categories ?? []).map((cat) => ({
        name: cat.name,
        budgeted: cat.budgeted,
        activity: cat.activity,
        balance: cat.balance,
      }));

      return {
        month: monthData.month,
        income: monthData.income,
        budgeted: monthData.budgeted,
        activity: monthData.activity,
        categories,
      };
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
