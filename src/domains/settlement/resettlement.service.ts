import type { LedgerTransaction } from "../ledger/ledger.types";
import { executeSettlementRun } from "./settlement-executor.service";
import { createLedgerTransactionsForSettlementRecords } from "./settlement-ledger.service";
import type { SettlementRecord } from "./settlement.types";
import type {
  ResettlementExecutionInput,
  ResettlementExecutionResult,
} from "./resettlement.types";
import { validateResettlementEligibility } from "./resettlement.validation";

function createReversalSettlementRecordId({
  resettlementRunId,
  originalRecordId,
}: {
  resettlementRunId: string;
  originalRecordId: string;
}) {
  return `SETTLEMENT-REVERSAL-${resettlementRunId}-${originalRecordId}`;
}

function hasReversalForSettlementRecord({
  records,
  originalRecordId,
}: {
  records: SettlementRecord[];
  originalRecordId: string;
}) {
  return records.some(
    (record) => record.reversalOfSettlementRecordId === originalRecordId
  );
}

function getPreviousRecordForTicketLine({
  records,
  ticketLineId,
}: {
  records: SettlementRecord[];
  ticketLineId: string;
}) {
  return records
    .filter((record) => record.ticketLineId === ticketLineId)
    .sort((a, b) => b.version - a.version)[0];
}

export function createSettlementReversalRecords({
  originalSettlementRecords,
  resettlementRunId,
  existingSettlementRecords = [],
}: {
  originalSettlementRecords: SettlementRecord[];
  resettlementRunId: string;
  existingSettlementRecords?: SettlementRecord[];
}) {
  const createdAt = new Date().toISOString();

  return originalSettlementRecords
    .filter((record) => record.status === "settled")
    .filter(
      (record) =>
        !hasReversalForSettlementRecord({
          records: [...existingSettlementRecords, ...originalSettlementRecords],
          originalRecordId: record.id,
        })
    )
    .map((record): SettlementRecord => ({
      id: createReversalSettlementRecordId({
        resettlementRunId,
        originalRecordId: record.id,
      }),
      settlementRunId: resettlementRunId,
      ticketId: record.ticketId,
      ticketLineId: record.ticketLineId,
      accountId: record.accountId,
      gameId: record.gameId,
      drawingId: record.drawingId,
      wagerTypeId: record.wagerTypeId,
      wagerOptionId: record.wagerOptionId || null,
      stake: record.stake,
      payout: -Number(record.payout || 0),
      netAmount: -Number(record.netAmount || 0),
      outcome: record.outcome,
      status: "reversed",
      version: record.version + 1,
      previousSettlementRecordId: record.id,
      reversalOfSettlementRecordId: record.id,
      ledgerTransactionIds: [],
      createdAt,
    }));
}

export function createLedgerReversalsForSettlementRecords({
  originalSettlementRecords,
  reversalSettlementRecords = [],
  ledgerTransactions,
}: {
  originalSettlementRecords: SettlementRecord[];
  reversalSettlementRecords?: SettlementRecord[];
  ledgerTransactions: LedgerTransaction[];
}) {
  const reversals: LedgerTransaction[] = [];

  for (const settlementRecord of originalSettlementRecords) {
    const reversalSettlementRecord = reversalSettlementRecords.find(
      (record) => record.reversalOfSettlementRecordId === settlementRecord.id
    );
    const linkedTransactions = ledgerTransactions.filter((transaction) =>
      settlementRecord.ledgerTransactionIds.includes(transaction.id)
    );

    for (const transaction of linkedTransactions) {
      const existingReversal = [
        ...ledgerTransactions,
        ...reversals,
      ].find(
        (createdTransaction) =>
          createdTransaction.transactionType === "settlement_reversal" &&
          createdTransaction.parentTransactionId === transaction.id
      );

      if (existingReversal) {
        continue;
      }

      reversals.push({
        id: `LEDGER-SETTLEMENT-REVERSAL-${transaction.id}`,
        accountId: transaction.accountId,
        category: transaction.category,
        transactionType: "settlement_reversal",
        amount: -Number(transaction.amount || 0),
        description: `Reversal of settlement transaction ${transaction.id}`,
        referenceId: reversalSettlementRecord?.id || settlementRecord.id,
        parentTransactionId: transaction.id,
        createdBy: "resettlement",
        createdAt: new Date().toISOString(),
      });
    }
  }

  return reversals;
}

function attachLedgerIdsToSettlementRecords({
  settlementRecords,
  ledgerTransactions,
}: {
  settlementRecords: SettlementRecord[];
  ledgerTransactions: LedgerTransaction[];
}) {
  return settlementRecords.map((record) => ({
    ...record,
    ledgerTransactionIds: ledgerTransactions
      .filter((transaction) => transaction.referenceId === record.id)
      .map((transaction) => transaction.id),
  }));
}

export function createCorrectedSettlementRecords({
  correctedSettlementRecords,
  previousSettlementRecords,
}: {
  correctedSettlementRecords: SettlementRecord[];
  previousSettlementRecords: SettlementRecord[];
}) {
  return correctedSettlementRecords.map((record) => {
    const previousRecord = getPreviousRecordForTicketLine({
      records: previousSettlementRecords,
      ticketLineId: record.ticketLineId,
    });

    return {
      ...record,
      version: previousRecord ? previousRecord.version + 1 : record.version,
      previousSettlementRecordId: previousRecord?.id || null,
      reversalOfSettlementRecordId: null,
    };
  });
}

export function executeResettlement({
  settlementRun,
  accountingPeriod,
  overrideApproval,
  requestedByAdminId,
  originalSettlementRecords,
  existingLedgerTransactions,
  correctedSettlementExecutionInput,
}: ResettlementExecutionInput): ResettlementExecutionResult {
  const eligibility = validateResettlementEligibility({
    settlementRun,
    accountingPeriod,
    overrideApproval,
    requestedByAdminId,
  });

  if (!eligibility.eligible) {
    return {
      success: false,
      errors: eligibility.errors,
      reversalSettlementRecords: [],
      reversalLedgerTransactions: [],
      correctedSettlementRecords: [],
      correctedLedgerTransactions: [],
    };
  }

  const reversalSettlementRecords = createSettlementReversalRecords({
    originalSettlementRecords,
    resettlementRunId: correctedSettlementExecutionInput.settlementRun.id,
    existingSettlementRecords: correctedSettlementExecutionInput.existingSettlementRecords,
  });
  const reversalLedgerTransactions = createLedgerReversalsForSettlementRecords({
    originalSettlementRecords,
    reversalSettlementRecords,
    ledgerTransactions: existingLedgerTransactions,
  });
  const linkedReversalSettlementRecords = attachLedgerIdsToSettlementRecords({
    settlementRecords: reversalSettlementRecords,
    ledgerTransactions: reversalLedgerTransactions,
  });
  const correctedExecution = executeSettlementRun(correctedSettlementExecutionInput);
  const correctedSettlementRecords = createCorrectedSettlementRecords({
    correctedSettlementRecords: correctedExecution.settlementRecords,
    previousSettlementRecords: [
      ...originalSettlementRecords,
      ...linkedReversalSettlementRecords,
    ],
  });
  const correctedLedgerPosting = createLedgerTransactionsForSettlementRecords({
    settlementRecords: correctedSettlementRecords,
    tickets: correctedExecution.updatedTickets,
    ticketLines: correctedExecution.updatedTicketLines,
    existingLedgerTransactions: [
      ...existingLedgerTransactions,
      ...reversalLedgerTransactions,
    ],
  });

  return {
    success: true,
    errors: correctedExecution.errors,
    reversalSettlementRecords: linkedReversalSettlementRecords,
    reversalLedgerTransactions,
    correctedSettlementRecords: correctedLedgerPosting.settlementRecords,
    correctedLedgerTransactions: correctedLedgerPosting.ledgerTransactions,
  };
}
