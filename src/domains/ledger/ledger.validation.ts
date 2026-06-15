import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { ValidationResult } from "@/src/lib/validation/validation.types";
import type {
  CreateLedgerEntryInput,
  LedgerTransaction,
  LedgerTransactionType,
} from "./ledger.types";

export function validateLedgerTransactionForm(form: {
  accountId: string;
  category: string;
  transactionType: string;
  amount: string;
  description: string;
}) {
  const amount = Number(form.amount || 0);
  const signedTransactionTypes = ["bet_stake", "settlement_reversal"];

  if (!form.accountId || !form.category || !form.transactionType) {
    return invalid("Please select account, category, and transaction type.");
  }

  if (Number.isNaN(amount) || amount === 0) {
    return invalid("Please enter a non-zero numeric amount.");
  }

  if (!signedTransactionTypes.includes(form.transactionType) && amount <= 0) {
    return invalid("Please enter a positive numeric amount.");
  }

  if (!form.description.trim()) {
    return invalid("Please enter a transaction description.");
  }

  return valid();
}

export function validateLedgerReversal(transaction?: LedgerTransaction) {
  if (!transaction) {
    return invalid("Transaction not found.");
  }

  return valid();
}

const LEDGER_TRANSACTION_TYPES: LedgerTransactionType[] = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TICKET_STAKE",
  "TICKET_WIN",
  "TICKET_REFUND",
  "TICKET_VOID",
  "FREE_PLAY_CREDIT",
  "FREE_PLAY_STAKE",
  "FREE_PLAY_WIN",
  "MANUAL_CREDIT_ADJUSTMENT",
  "MANUAL_DEBIT_ADJUSTMENT",
  "SETTLEMENT_CREDIT",
  "SETTLEMENT_DEBIT",
  "ZERO_BALANCE_CREDIT",
  "ZERO_BALANCE_DEBIT",
  "REVERSAL",
];

export function validateCreateLedgerEntryInput(
  input: CreateLedgerEntryInput
): ValidationResult {
  const errors: string[] = [];

  if (!input.walletId.trim()) {
    errors.push("Wallet id is required.");
  }

  if (!LEDGER_TRANSACTION_TYPES.includes(input.transactionType)) {
    errors.push("Ledger transaction type is invalid.");
  }

  if (input.direction !== "CREDIT" && input.direction !== "DEBIT") {
    errors.push("Ledger direction is invalid.");
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    errors.push("Ledger amount must be positive.");
  }

  return errors.length > 0 ? invalid(errors) : valid();
}

export function isManualAdjustmentTransactionType(
  transactionType: LedgerTransactionType
) {
  return (
    transactionType === "MANUAL_CREDIT_ADJUSTMENT" ||
    transactionType === "MANUAL_DEBIT_ADJUSTMENT"
  );
}
