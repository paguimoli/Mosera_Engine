import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { createAuditEvent } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit.types";
import { attachIntegrityHash } from "../integrity/integrity.helpers";
import { saveLedgerTransaction } from "./ledger.helpers";
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
    walletType?: LedgerTransaction["walletType"];
    amount: string;
    description: string;
    referenceId: string;
    createdBy: string;
  };
  transactions: LedgerTransaction[];
}) {
  // TODO Phase 5.10 integration: require ledger.adjust authorization for
  // manual adjustments once authenticated actor context is available.
  const validation = validateLedgerTransactionForm(form);

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const transactionId = `LEDGER-${Date.now()}`;
  const transaction: LedgerTransaction = attachIntegrityHash({
    id: transactionId,
    accountId: form.accountId,
    category: form.category,
    transactionType: form.transactionType,
    walletType: form.walletType || null,
    amount: Number(form.amount || 0),
    description: form.description.trim(),
    referenceId: form.referenceId.trim() || null,
    parentTransactionId: null,
    createdBy: form.createdBy.trim() || null,
    createdAt: new Date().toISOString(),
  }, "ledger_transaction", transactionId);

  return controllerSuccess({
    transaction,
    auditEvents: [
      createAuditEvent({
        entityType: "ledger_transaction",
        entityId: transaction.id,
        action:
          transaction.transactionType === "manual_adjustment"
            ? AUDIT_ACTIONS.MANUAL_ADJUSTMENT_CREATED
            : AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
        actorType: "admin",
        actorId: transaction.createdBy || "admin",
        newValue: transaction,
      }),
    ],
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

  const reversalId = `LEDGER-${Date.now()}-REVERSAL`;
  const reversal: LedgerTransaction = attachIntegrityHash({
    id: reversalId,
    accountId: transaction.accountId,
    category: transaction.category,
    transactionType: "reversal",
    walletType: transaction.walletType || null,
    amount: -transaction.amount,
    description: `Reversal of ${transaction.id}: ${transaction.description}`,
    referenceId: transaction.referenceId || null,
    parentTransactionId: transaction.id,
    createdBy: createdBy.trim() || "admin",
    createdAt: new Date().toISOString(),
  }, "ledger_transaction", reversalId, transaction.recordHash || null);

  return controllerSuccess({
    reversal,
    auditEvents: [
      createAuditEvent({
        entityType: "ledger_transaction",
        entityId: reversal.id,
        action: AUDIT_ACTIONS.LEDGER_REVERSAL_CREATED,
        actorType: "admin",
        actorId: reversal.createdBy || "admin",
        oldValue: transaction,
        newValue: reversal,
      }),
    ],
    transactions: saveLedgerTransaction(transactions, reversal),
  });
}
