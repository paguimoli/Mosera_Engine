import { invalid, valid } from "@/src/lib/validation/validation.types";
import type { LedgerTransaction } from "./ledger.types";

export function validateLedgerTransactionForm(form: {
  accountId: string;
  category: string;
  transactionType: string;
  amount: string;
  description: string;
}) {
  const amount = Number(form.amount || 0);

  if (!form.accountId || !form.category || !form.transactionType) {
    return invalid("Please select account, category, and transaction type.");
  }

  if (Number.isNaN(amount) || amount <= 0) {
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
