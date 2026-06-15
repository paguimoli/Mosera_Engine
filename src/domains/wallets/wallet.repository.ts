import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  BalanceAuthority,
  CreateWalletInput,
  FundingModel,
  OperatingMode,
  PersistedWalletStatus,
  PersistedWalletType,
  UpdateWalletInput,
  Wallet,
  WalletType,
} from "./wallet.types";
import { normalizeCreateWalletInput } from "./wallet.validation";

type WalletRow = {
  id: string;
  account_id: string;
  wallet_type: PersistedWalletType;
  currency_code: string;
  balance_authority: BalanceAuthority;
  status: PersistedWalletStatus;
  balance: string | number;
  credit_limit?: string | number | null;
  funding_model: FundingModel;
  operating_mode?: OperatingMode | null;
  default_funding_source?: PersistedWalletType | null;
  created_at: string;
  updated_at?: string | null;
};

const WALLET_SELECT =
  "id, account_id, wallet_type, currency_code, balance_authority, status, balance, credit_limit, funding_model, operating_mode, default_funding_source, created_at, updated_at";
const FINANCIAL_WALLETS_TABLE = "financial_wallets";

export class WalletRepositoryError extends Error {
  constructor(message = "Wallet persistence operation failed.") {
    super(message);
    this.name = "WalletRepositoryError";
  }
}

function mapWalletRow(row: WalletRow | null): Wallet | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    accountId: row.account_id,
    walletType: row.wallet_type,
    status: row.status,
    currency: row.currency_code,
    currencyCode: row.currency_code,
    balanceAuthority: row.balance_authority,
    balance: Number(row.balance),
    creditLimit:
      row.credit_limit === null || row.credit_limit === undefined
        ? null
        : Number(row.credit_limit),
    fundingModel: row.funding_model,
    operatingMode: row.operating_mode ?? null,
    defaultFundingSource: row.default_funding_source ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function createWallet(input: CreateWalletInput): Promise<Wallet> {
  const normalized = normalizeCreateWalletInput(input);
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_WALLETS_TABLE)
    .upsert(
      {
        account_id: normalized.accountId,
        wallet_type: normalized.walletType,
        currency_code: normalized.currencyCode,
        balance_authority: normalized.balanceAuthority ?? "INTERNAL",
        status: normalized.status ?? "ACTIVE",
        balance: normalized.balance ?? 0,
        credit_limit: normalized.creditLimit ?? null,
        funding_model: normalized.fundingModel,
        operating_mode: normalized.operatingMode ?? null,
        default_funding_source: normalized.defaultFundingSource ?? null,
      },
      {
        onConflict: "account_id,wallet_type",
        ignoreDuplicates: false,
      }
    )
    .select(WALLET_SELECT)
    .single();

  if (error) {
    throw new WalletRepositoryError();
  }

  const wallet = mapWalletRow(data as WalletRow | null);

  if (!wallet) {
    throw new WalletRepositoryError();
  }

  return wallet;
}

export function saveWallet(wallets: Wallet[], wallet: Wallet) {
  return [...wallets, wallet];
}

export function saveWallets(wallets: Wallet[], newWallets: Wallet[]) {
  return [...wallets, ...newWallets];
}

export function updateWallet(wallets: Wallet[], wallet: Wallet) {
  return wallets.map((createdWallet) =>
    createdWallet.id === wallet.id ? wallet : createdWallet
  );
}

export function findWalletById(
  wallets: Wallet[],
  walletId: string
): Wallet | undefined;
export function findWalletById(id: string): Promise<Wallet | null>;
export function findWalletById(
  walletsOrId: Wallet[] | string,
  walletId?: string
): Wallet | undefined | Promise<Wallet | null> {
  if (Array.isArray(walletsOrId)) {
    return walletsOrId.find((wallet) => wallet.id === walletId);
  }

  return findPersistedWalletById(walletsOrId);
}

async function findPersistedWalletById(id: string): Promise<Wallet | null> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_WALLETS_TABLE)
    .select(WALLET_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new WalletRepositoryError();
  }

  return mapWalletRow(data as WalletRow | null);
}

export function listWalletsByAccountId(wallets: Wallet[], accountId: string) {
  return wallets.filter((wallet) => wallet.accountId === accountId);
}

export async function listWalletsForAccount(accountId: string): Promise<Wallet[]> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_WALLETS_TABLE)
    .select(WALLET_SELECT)
    .eq("account_id", accountId)
    .order("wallet_type", { ascending: true });

  if (error) {
    throw new WalletRepositoryError();
  }

  return ((data ?? []) as WalletRow[])
    .map(mapWalletRow)
    .filter((wallet): wallet is Wallet => Boolean(wallet));
}

export function findWalletByAccountAndType({
  wallets,
  accountId,
  walletType,
}: {
  wallets: Wallet[];
  accountId: string;
  walletType: WalletType;
}) {
  return wallets.find(
    (wallet) =>
      wallet.accountId === accountId && wallet.walletType === walletType
  );
}

export async function findPersistedWalletByAccountAndType(
  accountId: string,
  walletType: PersistedWalletType
): Promise<Wallet | null> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_WALLETS_TABLE)
    .select(WALLET_SELECT)
    .eq("account_id", accountId)
    .eq("wallet_type", walletType)
    .maybeSingle();

  if (error) {
    throw new WalletRepositoryError();
  }

  return mapWalletRow(data as WalletRow | null);
}

export async function updateWalletRecord(
  id: string,
  input: UpdateWalletInput
): Promise<Wallet> {
  const updatePayload: Record<string, string | number | null> = {};

  if (input.currencyCode !== undefined) {
    updatePayload.currency_code = input.currencyCode;
  }
  if (input.balanceAuthority !== undefined) {
    updatePayload.balance_authority = input.balanceAuthority;
  }
  if (input.status !== undefined) updatePayload.status = input.status;
  if (input.balance !== undefined) updatePayload.balance = input.balance;
  if (input.creditLimit !== undefined) {
    updatePayload.credit_limit = input.creditLimit;
  }
  if (input.fundingModel !== undefined) {
    updatePayload.funding_model = input.fundingModel;
  }
  if (input.operatingMode !== undefined) {
    updatePayload.operating_mode = input.operatingMode;
  }
  if (input.defaultFundingSource !== undefined) {
    updatePayload.default_funding_source = input.defaultFundingSource;
  }

  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_WALLETS_TABLE)
    .update(updatePayload)
    .eq("id", id)
    .select(WALLET_SELECT)
    .single();

  if (error) {
    throw new WalletRepositoryError();
  }

  const wallet = mapWalletRow(data as WalletRow | null);

  if (!wallet) {
    throw new WalletRepositoryError();
  }

  return wallet;
}

export async function updateWalletBalance(
  id: string,
  balance: number
): Promise<Wallet> {
  return updateWalletRecord(id, { balance });
}
