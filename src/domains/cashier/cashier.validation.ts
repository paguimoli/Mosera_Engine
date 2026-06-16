import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type {
  CashierTransactionType,
  CreateCashierTransactionInput,
} from "./cashier.types";

const CASHIER_TRANSACTION_TYPES: CashierTransactionType[] = [
  "DEPOSIT",
  "WITHDRAWAL",
];

function isCashierTransactionType(
  value: string
): value is CashierTransactionType {
  return CASHIER_TRANSACTION_TYPES.includes(value as CashierTransactionType);
}

function normalizeOptionalString(value?: string | null) {
  const normalized = value?.trim();

  return normalized ? normalized : null;
}

export function normalizeCreateCashierTransactionInput(
  input: CreateCashierTransactionInput
): CreateCashierTransactionInput {
  return {
    accountId: input.accountId.trim(),
    walletId: normalizeOptionalString(input.walletId),
    transactionType: input.transactionType,
    amount: Number(input.amount),
    currencyCode: input.currencyCode.trim().toUpperCase(),
    paymentMethod: normalizeOptionalString(input.paymentMethod),
    provider: normalizeOptionalString(input.provider),
    providerReference: normalizeOptionalString(input.providerReference),
    requestedByUserId: normalizeOptionalString(input.requestedByUserId),
    reason: normalizeOptionalString(input.reason),
    metadata: input.metadata ?? {},
  };
}

export function validateCreateCashierTransactionInput(
  input: CreateCashierTransactionInput
): ValidationResult {
  const errors: string[] = [];

  if (!input.accountId?.trim()) {
    errors.push("Account id is required.");
  }

  if (!input.transactionType || !isCashierTransactionType(input.transactionType)) {
    errors.push("Cashier transaction type is invalid.");
  }

  if (Number.isNaN(Number(input.amount)) || Number(input.amount) <= 0) {
    errors.push("Amount must be greater than zero.");
  }

  if (!input.currencyCode?.trim()) {
    errors.push("Currency code is required.");
  }

  if (
    input.metadata !== undefined &&
    (typeof input.metadata !== "object" ||
      input.metadata === null ||
      Array.isArray(input.metadata))
  ) {
    errors.push("Metadata must be an object.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}
