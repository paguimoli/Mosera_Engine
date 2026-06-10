import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { saveLedgerTransaction } from "./ledger.repository";
import type { LedgerTransaction } from "./ledger.types";
import {
  validateLedgerReversal,
  validateLedgerTransactionForm,
} from "./ledger.validation";

export function createLedgerTransactionController({
  form,
  transactions,
}: {
  form: {
    accountId: string;
    category: LedgerTransaction["category"];
    transactionType: LedgerTransaction["transactionType"];
    amount: string;
    description: string;
    referenceId: string;
    createdBy: string;
  };
  transactions: LedgerTransaction[];
}) {
  const validation = validateLedgerTransactionForm(form);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const transaction: LedgerTransaction = {
    id: `LEDGER-${Date.now()}`,
    accountId: form.accountId,
    category: form.category,
    transactionType: form.transactionType,
    amount: Number(form.amount || 0),
    description: form.description.trim(),
    referenceId: form.referenceId.trim() || null,
    parentTransactionId: null,
    createdBy: form.createdBy.trim() || null,
    createdAt: new Date().toISOString(),
  };

  return controllerSuccess({
    transaction,
    transactions: saveLedgerTransaction(transactions, transaction),
  });
}

export function reverseLedgerTransactionController({
  transaction,
  transactions,
  createdBy,
}: {
  transaction?: LedgerTransaction;
  transactions: LedgerTransaction[];
  createdBy: string;
}) {
  const validation = validateLedgerReversal(transaction);

  if (!validation.valid || !transaction) {
    return controllerFailure(validation.errors);
  }

  const reversal: LedgerTransaction = {
    id: `LEDGER-${Date.now()}-REVERSAL`,
    accountId: transaction.accountId,
    category: transaction.category,
    transactionType: "reversal",
    amount: -transaction.amount,
    description: `Reversal of ${transaction.id}: ${transaction.description}`,
    referenceId: transaction.referenceId || null,
    parentTransactionId: transaction.id,
    createdBy: createdBy.trim() || "admin",
    createdAt: new Date().toISOString(),
  };

  return controllerSuccess({
    reversal,
    transactions: saveLedgerTransaction(transactions, reversal),
  });
}
