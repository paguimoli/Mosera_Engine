import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type { LedgerTransaction } from "../ledger/ledger.types";
import type {
  CreateWalletInput,
  PersistedWalletStatus,
  PersistedWalletType,
  Wallet,
  UpdateWalletInput,
} from "./wallet.types";
import {
  PERSISTED_WALLET_STATUSES,
  PERSISTED_WALLET_TYPES,
  WALLET_STATUSES,
  WALLET_TYPES,
} from "./wallet.types";

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

function normalizeWalletStatus(status: PersistedWalletStatus): PersistedWalletStatus {
  return status.trim().toUpperCase() as PersistedWalletStatus;
}

export function normalizeWalletType(walletType: PersistedWalletType) {
  return walletType.trim().toUpperCase() as PersistedWalletType;
}

export function validateCreateWalletInput(
  input: CreateWalletInput
): ValidationResult {
  const errors: string[] = [];
  const walletType = normalizeWalletType(input.walletType);
  const status = input.status ? normalizeWalletStatus(input.status) : "ACTIVE";

  if (!input.accountId.trim()) {
    errors.push("Wallet account id is required.");
  }

  if (!PERSISTED_WALLET_TYPES.includes(walletType)) {
    errors.push("Wallet type is invalid.");
  }

  if (!input.currencyCode.trim()) {
    errors.push("Wallet currency code is required.");
  }

  if (!PERSISTED_WALLET_STATUSES.includes(status)) {
    errors.push("Wallet status is invalid.");
  }

  if (walletType === "CREDIT" && input.creditLimit === undefined) {
    errors.push("Credit wallet requires a credit limit.");
  }

  if (walletType !== "CREDIT" && input.creditLimit !== null) {
    errors.push("Only credit wallets may have a credit limit.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function validateUpdateWalletInput(
  input: UpdateWalletInput
): ValidationResult {
  const errors: string[] = [];

  if (input.status !== undefined && !PERSISTED_WALLET_STATUSES.includes(input.status)) {
    errors.push("Wallet status is invalid.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function normalizeCreateWalletInput(
  input: CreateWalletInput
): CreateWalletInput {
  return {
    accountId: input.accountId.trim(),
    walletType: normalizeWalletType(input.walletType),
    currencyCode: input.currencyCode.trim().toUpperCase(),
    balanceAuthority: input.balanceAuthority ?? "INTERNAL",
    status: input.status ? normalizeWalletStatus(input.status) : "ACTIVE",
    balance: input.balance ?? 0,
    creditLimit: input.walletType === "CREDIT" ? input.creditLimit ?? 0 : null,
    fundingModel: input.fundingModel,
    operatingMode: input.operatingMode ?? null,
    defaultFundingSource: input.defaultFundingSource ?? null,
  };
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

  if (wallet.status !== "active" && wallet.status !== "ACTIVE") {
    return invalid("Frozen, suspended, or closed wallets cannot accept new wagers.");
  }

  if (transaction.walletType && transaction.walletType !== wallet.walletType) {
    return invalid("Transaction wallet type does not match wallet.");
  }

  return valid();
}
