import { controllerSuccess } from "@/src/lib/controller/controller.types";
import { createAuditEvent } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit.types";
import { executeResettlement } from "./resettlement.service";
import type { ResettlementExecutionInput } from "./resettlement.types";

export function executeResettlementController(input: ResettlementExecutionInput) {
  const result = executeResettlement(input);

  if (!result.success) {
    return {
      success: false,
      errors: result.errors,
      data: {
        auditEvents: [
          createAuditEvent({
            entityType: "settlement_run",
            entityId: input.settlementRun.id,
            action: AUDIT_ACTIONS.RESETTLEMENT_BLOCKED,
            actorType: "admin",
            actorId: input.requestedByAdminId,
            reasonCode: result.errors.join(","),
            approvalId: input.overrideApproval?.id || null,
            metadata: {
              accountingPeriodId: input.accountingPeriod.id,
              accountingPeriodStatus: input.accountingPeriod.status,
              errors: result.errors,
            },
          }),
        ],
      },
    };
  }

  return controllerSuccess({
    ...result,
    auditEvents: [
      createAuditEvent({
        entityType: "settlement_run",
        entityId: input.settlementRun.id,
        action: AUDIT_ACTIONS.RESETTLEMENT_EXECUTED,
        actorType: "admin",
        actorId: input.requestedByAdminId,
        reasonCode: input.overrideApproval?.reasonCode || null,
        approvalId: input.overrideApproval?.id || null,
        oldValue: input.originalSettlementRecords,
        newValue: result.correctedSettlementRecords,
        metadata: {
          accountingPeriodId: input.accountingPeriod.id,
          reversalSettlementRecordCount:
            result.reversalSettlementRecords.length,
          correctedSettlementRecordCount:
            result.correctedSettlementRecords.length,
          reversalLedgerTransactionCount:
            result.reversalLedgerTransactions.length,
          correctedLedgerTransactionCount:
            result.correctedLedgerTransactions.length,
        },
      }),
      ...result.reversalLedgerTransactions.map((transaction) =>
        createAuditEvent({
          entityType: "ledger_transaction",
          entityId: transaction.id,
          action: AUDIT_ACTIONS.LEDGER_REVERSAL_CREATED,
          actorType: "admin",
          actorId: input.requestedByAdminId,
          approvalId: input.overrideApproval?.id || null,
          newValue: transaction,
        })
      ),
      ...result.correctedLedgerTransactions.map((transaction) =>
        createAuditEvent({
          entityType: "ledger_transaction",
          entityId: transaction.id,
          action: AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
          actorType: "admin",
          actorId: input.requestedByAdminId,
          approvalId: input.overrideApproval?.id || null,
          newValue: transaction,
        })
      ),
    ],
  });
}
