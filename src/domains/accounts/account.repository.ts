import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  Account,
  AccountBalanceAuthority,
  AccountDefaultFundingSource,
  AccountFundingModel,
  AccountOperatingMode,
  AccountSettlementMode,
  AccountWeeklyAccountingMode,
  CreateAccountInput,
  PersistedAccountStatus,
  PersistedAccountType,
  PlayerAccount,
  UpdateAccountInput,
} from "./account.types";
import {
  normalizeAccountCode,
  normalizeCreateAccountInput,
  normalizeUpdateAccountInput,
} from "./account.validation";

type AccountRow = {
  id: string;
  account_type: PersistedAccountType;
  account_code: string;
  display_name: string;
  parent_account_id?: string | null;
  market_id: string;
  brand_id: string;
  status: PersistedAccountStatus;
  funding_model?: AccountFundingModel | null;
  operating_mode?: AccountOperatingMode | null;
  balance_authority?: AccountBalanceAuthority | null;
  default_funding_source?: AccountDefaultFundingSource | null;
  weekly_accounting_mode?: AccountWeeklyAccountingMode | null;
  settlement_mode?: AccountSettlementMode | null;
  created_at: string;
  updated_at?: string | null;
};

const ACCOUNT_SELECT =
  "id, account_type, account_code, display_name, parent_account_id, market_id, brand_id, status, funding_model, operating_mode, balance_authority, default_funding_source, weekly_accounting_mode, settlement_mode, created_at, updated_at";

export class AccountRepositoryError extends Error {
  constructor(message = "Account persistence operation failed.") {
    super(message);
    this.name = "AccountRepositoryError";
  }
}

function mapAccountRow(row: AccountRow | null): Account | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    accountType: row.account_type,
    accountCode: row.account_code,
    displayName: row.display_name,
    parentAccountId: row.parent_account_id ?? null,
    marketId: row.market_id,
    brandId: row.brand_id,
    status: row.status,
    fundingModel: row.funding_model ?? null,
    operatingMode: row.operating_mode ?? null,
    balanceAuthority: row.balance_authority ?? null,
    defaultFundingSource: row.default_funding_source ?? null,
    weeklyAccountingMode: row.weekly_accounting_mode ?? null,
    settlementMode: row.settlement_mode ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const normalized = normalizeCreateAccountInput(input);
  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .insert({
      account_type: normalized.accountType,
      account_code: normalized.accountCode,
      display_name: normalized.displayName,
      parent_account_id: normalized.parentAccountId ?? null,
      market_id: normalized.marketId,
      brand_id: normalized.brandId,
      status: normalized.status ?? "ACTIVE",
      funding_model: normalized.fundingModel ?? null,
      operating_mode: normalized.operatingMode ?? null,
      balance_authority: normalized.balanceAuthority ?? null,
      default_funding_source: normalized.defaultFundingSource ?? null,
      weekly_accounting_mode: normalized.weeklyAccountingMode ?? null,
      settlement_mode: normalized.settlementMode ?? null,
    })
    .select(ACCOUNT_SELECT)
    .single();

  if (error) {
    throw new AccountRepositoryError();
  }

  const account = mapAccountRow(data as AccountRow | null);

  if (!account) {
    throw new AccountRepositoryError();
  }

  return account;
}

export function findAccountById(
  accounts: PlayerAccount[],
  accountId: string
): PlayerAccount | undefined;
export function findAccountById(id: string): Promise<Account | null>;
export function findAccountById(
  accountsOrId: PlayerAccount[] | string,
  accountId?: string
): PlayerAccount | undefined | Promise<Account | null> {
  if (Array.isArray(accountsOrId)) {
    return accountsOrId.find((account) => account.id === accountId);
  }

  return findPersistedAccountById(accountsOrId);
}

async function findPersistedAccountById(id: string): Promise<Account | null> {
  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .select(ACCOUNT_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new AccountRepositoryError();
  }

  return mapAccountRow(data as AccountRow | null);
}

export function findAccountByUsername(accounts: PlayerAccount[], username: string) {
  return accounts.find(
    (account) =>
      account.username.trim().toLowerCase() === username.trim().toLowerCase()
  );
}

export async function findAccountByCode(
  accountCode: string
): Promise<Account | null> {
  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .select(ACCOUNT_SELECT)
    .eq("account_code", normalizeAccountCode(accountCode))
    .maybeSingle();

  if (error) {
    throw new AccountRepositoryError();
  }

  return mapAccountRow(data as AccountRow | null);
}

export async function listAccounts(): Promise<Account[]> {
  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .select(ACCOUNT_SELECT)
    .order("account_code", { ascending: true });

  if (error) {
    throw new AccountRepositoryError();
  }

  return ((data ?? []) as AccountRow[])
    .map(mapAccountRow)
    .filter((account): account is Account => Boolean(account));
}

export function listAccountsByParentId(
  accounts: PlayerAccount[],
  parentId: string | null
) {
  return accounts.filter((account) => account.parentId === parentId);
}

export async function listChildren(parentAccountId: string): Promise<Account[]> {
  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .select(ACCOUNT_SELECT)
    .eq("parent_account_id", parentAccountId)
    .order("account_code", { ascending: true });

  if (error) {
    throw new AccountRepositoryError();
  }

  return ((data ?? []) as AccountRow[])
    .map(mapAccountRow)
    .filter((account): account is Account => Boolean(account));
}

export function saveAccount(accounts: PlayerAccount[], account: PlayerAccount) {
  return [...accounts, account];
}

export function updateAccount(
  accounts: PlayerAccount[],
  account: PlayerAccount
): PlayerAccount[];
export function updateAccount(
  id: string,
  input: UpdateAccountInput
): Promise<Account>;
export function updateAccount(
  accountsOrId: PlayerAccount[] | string,
  accountOrInput: PlayerAccount | UpdateAccountInput
): PlayerAccount[] | Promise<Account> {
  if (Array.isArray(accountsOrId)) {
    const account = accountOrInput as PlayerAccount;

    return accountsOrId.map((createdAccount) =>
      createdAccount.id === account.id ? account : createdAccount
    );
  }

  return updatePersistedAccount(accountsOrId, accountOrInput as UpdateAccountInput);
}

async function updatePersistedAccount(
  id: string,
  input: UpdateAccountInput
): Promise<Account> {
  const normalized = normalizeUpdateAccountInput(input);
  const updatePayload: Record<string, string | null> = {};

  if (normalized.accountType !== undefined) {
    updatePayload.account_type = normalized.accountType;
  }
  if (normalized.accountCode !== undefined) {
    updatePayload.account_code = normalized.accountCode;
  }
  if (normalized.displayName !== undefined) {
    updatePayload.display_name = normalized.displayName;
  }
  if (normalized.parentAccountId !== undefined) {
    updatePayload.parent_account_id = normalized.parentAccountId ?? null;
  }
  if (normalized.marketId !== undefined) updatePayload.market_id = normalized.marketId;
  if (normalized.brandId !== undefined) updatePayload.brand_id = normalized.brandId;
  if (normalized.status !== undefined) updatePayload.status = normalized.status;
  if (normalized.fundingModel !== undefined) {
    updatePayload.funding_model = normalized.fundingModel;
  }
  if (normalized.operatingMode !== undefined) {
    updatePayload.operating_mode = normalized.operatingMode;
  }
  if (normalized.balanceAuthority !== undefined) {
    updatePayload.balance_authority = normalized.balanceAuthority;
  }
  if (normalized.defaultFundingSource !== undefined) {
    updatePayload.default_funding_source = normalized.defaultFundingSource;
  }
  if (normalized.weeklyAccountingMode !== undefined) {
    updatePayload.weekly_accounting_mode = normalized.weeklyAccountingMode;
  }
  if (normalized.settlementMode !== undefined) {
    updatePayload.settlement_mode = normalized.settlementMode;
  }

  const { data, error } = await supabaseServerAdmin
    .from("accounts")
    .update(updatePayload)
    .eq("id", id)
    .select(ACCOUNT_SELECT)
    .single();

  if (error) {
    throw new AccountRepositoryError();
  }

  const account = mapAccountRow(data as AccountRow | null);

  if (!account) {
    throw new AccountRepositoryError();
  }

  return account;
}

export async function disableAccount(id: string): Promise<Account> {
  return updatePersistedAccount(id, { status: "DISABLED" });
}

export function deleteAccount(accounts: PlayerAccount[], accountId: string) {
  return accounts.filter((account) => account.id !== accountId);
}
