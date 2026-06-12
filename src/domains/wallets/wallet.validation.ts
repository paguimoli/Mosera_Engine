import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { LedgerTransaction } from "../ledger/ledger.types";
import type { Wallet } from "./wallet.types";
import { WALLET_STATUSES, WALLET_TYPES } from "./wallet.types";

export function validateWallet(wallet: Partial<Wallet>) {
  if (!wallet.accountId) {
    return invalid("Wallet account id is required.");
  }

  if (!wallet.walletType || !WALLET_TYPES.includes(wallet.walletType)) {
    return invalid("Valid wallet type is required.");
  }

  if (!wallet.status || !WALLET_STATUSES.includes(wallet.status)) {
    return invalid("Valid wallet status is required.");
  }

  return valid();
}

export function validateWalletTransaction({
  wallet,
  transaction,
}: {
  wallet?: Wallet | null;
  transaction: Partial<LedgerTransaction>;
}) {
  if (!wallet) {
    return invalid("Wallet not found.");
  }

  if (wallet.status !== "active") {
    return invalid("Frozen, suspended, or closed wallets cannot accept new wagers.");
  }

  if (transaction.walletType && transaction.walletType !== wallet.walletType) {
    return invalid("Transaction wallet type does not match wallet.");
  }

  return valid();
}
