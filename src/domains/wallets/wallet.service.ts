import type { LedgerTransaction } from "../ledger/ledger.types";
import {
  calculateWalletBalanceSummary,
  getWalletForAccount,
  isWalletActive,
} from "./wallet.helpers";
import type {
  Wallet,
  WalletBalanceSummary,
  WalletStatus,
  WalletType,
} from "./wallet.types";
import { validateWalletTransaction } from "./wallet.validation";

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

// TODO: Future cashier integration must support approved deposit callbacks
// creating automatic cash credits, withdrawal requests with approval, failed
// withdrawal operator review, manual reconciliation, and cashier permissions.
