import { z } from 'zod';

export const MonobankAccountSchema = z.object({
  bank: z.literal('monobank'),
  displayName: z.string(),
  bankAccountId: z.string().default('0'),
  ynabAccountId: z.uuid(),
  currency: z.string().default('UAH'),
  enabled: z.boolean().default(true),
});

export const PrivatBankAccountSchema = z.object({
  bank: z.literal('privatbank'),
  displayName: z.string(),
  iban: z.string().startsWith('UA'),
  ynabAccountId: z.uuid(),
  currency: z.string().default('UAH'),
  enabled: z.boolean().default(true),
});

export const AccountEntrySchema = z.discriminatedUnion('bank', [
  MonobankAccountSchema,
  PrivatBankAccountSchema,
]);

export const IntegrationsConfigSchema = z.object({
  ynab: z
    .object({
      planId: z.string().default('default'),
      defaultAccountId: z.uuid().optional(),
    })
    .default({ planId: 'default' }),
  accounts: z.array(AccountEntrySchema).default([]),
});

export type MonobankAccount = z.infer<typeof MonobankAccountSchema>;
export type PrivatBankAccount = z.infer<typeof PrivatBankAccountSchema>;
export type AccountEntry = z.infer<typeof AccountEntrySchema>;
export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;
