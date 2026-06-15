import type { LedgerTransaction } from "../ledger/ledger.types";
import { findAccountById, updateAccount } from "../accounts/account.repository";
import { findMarketById } from "../markets/market.repository";
import {
  calculateWalletBalanceSummary,
  getWalletForAccount,
  isWalletActive,
} from "./wallet.helpers";
import type {
  CreateWalletInput,
  FundingModel,
  PersistedWalletType,
  Wallet,
  WalletBalanceSummary,
  WalletStatus,
  WalletType,
} from "./wallet.types";
import {
  validateCreateWalletInput,
  validateWalletTransaction,
} from "./wallet.validation";
import {
  createWallet as createWalletRecord,
  findPersistedWalletByAccountAndType,
  findWalletById,
  listWalletsForAccount as listWalletRecordsForAccount,
  updateWalletRecord,
} from "./wallet.repository";

export class WalletValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "WalletValidationError";
    this.errors = errors;
  }
}

export class WalletBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletBusinessRuleError";
  }
}

export function createWalletPayload(form: {
  accountId: string;
  walletType: WalletType;
  status?: WalletStatus;
  currency?: string | null;
  creditLimit?: string | number | null;
}): Wallet {
  return {
    id: `WALLET-${form.accountId}-${form.walletType}-${Date.now()}`,
    accountId: form.accountId,
    walletType: form.walletType,
    status: form.status || "active",
    currency: form.currency || null,
    creditLimit:
      form.creditLimit === null ||
      form.creditLimit === undefined ||
      form.creditLimit === ""
        ? null
        : Number(form.creditLimit),
    createdAt: new Date().toISOString(),
  };
}

export function createDefaultWalletsForAccount({
  accountId,
  currency,
}: {
  accountId: string;
  currency?: string | null;
}) {
  return (["cash", "credit", "freeplay"] as WalletType[]).map((walletType) =>
    createWalletPayload({
      accountId,
      walletType,
      status: "active",
      currency,
      creditLimit: walletType === "credit" ? 0 : null,
    })
  );
}

export function calculateAccountWalletSummary({
  accountId,
  wallets,
  transactions,
}: {
  accountId: string;
  wallets: Wallet[];
  transactions: LedgerTransaction[];
}): WalletBalanceSummary {
  return calculateWalletBalanceSummary({
    accountId,
    wallets,
    transactions,
  });
}

export function validateWalletTransactionEligibility({
  accountId,
  walletType,
  wallets,
  transaction,
}: {
  accountId: string;
  walletType: WalletType;
  wallets: Wallet[];
  transaction: Partial<LedgerTransaction>;
}) {
  const wallet = getWalletForAccount({ wallets, accountId, walletType });

  return validateWalletTransaction({
    wallet,
    transaction: {
      ...transaction,
      walletType,
    },
  });
}

export function canUseWalletForWager(wallet?: Wallet | null) {
  return isWalletActive(wallet);
}

export async function createWallet(input: CreateWalletInput): Promise<Wallet> {
  const validation = validateCreateWalletInput(input);

  if (!validation.valid) {
    throw new WalletValidationError(validation.errors);
  }

  return createWalletRecord(input);
}

export async function getWalletById(id: string): Promise<Wallet | null> {
  return findWalletById(id);
}

export async function findWalletByAccountAndType(
  accountId: string,
  walletType: PersistedWalletType
): Promise<Wallet | null> {
  return findPersistedWalletByAccountAndType(accountId, walletType);
}

export async function listWalletsForAccount(accountId: string): Promise<Wallet[]> {
  return listWalletRecordsForAccount(accountId);
}

export async function suspendWallet(id: string): Promise<Wallet> {
  return updateWalletRecord(id, { status: "SUSPENDED" });
}

export async function closeWallet(id: string): Promise<Wallet> {
  return updateWalletRecord(id, { status: "CLOSED" });
}

function getWalletTypesForFundingModel(
  fundingModel: FundingModel
): PersistedWalletType[] {
  if (fundingModel === "CASH") {
    return ["CASH", "FREE_PLAY"];
  }

  if (fundingModel === "CREDIT") {
    return ["CREDIT", "FREE_PLAY"];
  }

  return ["CASH", "CREDIT", "FREE_PLAY"];
}

export async function provisionWalletsForAccount(
  accountId: string
): Promise<Wallet[]> {
  const account = await findAccountById(accountId);

  if (!account) {
    throw new WalletBusinessRuleError("Account not found.");
  }

  const fundingModel = account.fundingModel;

  if (!fundingModel) {
    throw new WalletBusinessRuleError("Account funding model is required.");
  }

  const defaultFundingSource =
    account.defaultFundingSource ?? (fundingModel === "HYBRID" ? "CASH" : fundingModel);
  const market = await findMarketById(account.marketId);

  if (!market) {
    throw new WalletBusinessRuleError("Account market not found.");
  }

  const currencyCode = market.currencyCode;
  const balanceAuthority = account.balanceAuthority ?? "INTERNAL";
  const walletTypes = getWalletTypesForFundingModel(fundingModel);
  const provisionedWallets: Wallet[] = [];

  if (
    account.balanceAuthority === null ||
    account.balanceAuthority === undefined ||
    account.defaultFundingSource === null ||
    account.defaultFundingSource === undefined
  ) {
    await updateAccount(account.id, {
      balanceAuthority,
      defaultFundingSource,
    });
  }

  for (const walletType of walletTypes) {
    const existingWallet = await findPersistedWalletByAccountAndType(
      account.id,
      walletType
    );

    if (existingWallet) {
      provisionedWallets.push(existingWallet);
      continue;
    }

    provisionedWallets.push(
      await createWallet({
        accountId: account.id,
        walletType,
        currencyCode,
        balanceAuthority,
        status: "ACTIVE",
        balance: 0,
        creditLimit: walletType === "CREDIT" ? 0 : null,
        fundingModel,
        operatingMode: account.operatingMode ?? null,
        defaultFundingSource,
      })
    );
  }

  return provisionedWallets;
}

// TODO: Future cashier integration must support approved deposit callbacks
// creating automatic cash credits, withdrawal requests with approval, failed
// withdrawal operator review, manual reconciliation, and cashier permissions.
