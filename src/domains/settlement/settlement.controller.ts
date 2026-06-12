import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { createAuditEvent } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit.types";
import { saveLedgerTransactions } from "../ledger/ledger.repository";
import type { LedgerTransaction } from "../ledger/ledger.types";
import type { Ticket, TicketLine } from "../tickets/ticket.types";
import type {
  KenoDrawMetrics,
  PayTableRow,
  WagerOption,
  WagerType,
} from "../wagers/wager.types";
import {
  findSettlementRunById,
  saveSettlementRecords,
  saveSettlementRun,
  updateSettlementRun,
} from "./settlement.repository";
import { executeSettlementRun } from "./settlement-engine.service";
import { canResumeSettlementRun, resumeSettlementRun } from "./settlement-recovery.service";
import { createLedgerTransactionsForSettlementRecords } from "./settlement-ledger.service";
import {
  applySettlementRunStatusTransition,
  buildPlaceholderSettlementRecords,
  buildSettlementRunPayload,
  reverseSettlementRecords,
} from "./settlement.service";
import type {
  SettlementRecord,
  SettlementRun,
  SettlementRunStatus,
} from "./settlement.types";
import {
  validatePlaceholderSettlementRecords,
  validateSettlementRunCreation,
  validateSettlementStatusTransition,
} from "./settlement.validation";

function mergeSettlementRecordsForRun({
  records,
  settlementRunId,
  runRecords,
}: {
  records: SettlementRecord[];
  settlementRunId: string;
  runRecords: SettlementRecord[];
}) {
  return [
    ...records.filter((record) => record.settlementRunId !== settlementRunId),
    ...runRecords,
  ];
}

function getSettlementStatusAuditAction(status: SettlementRunStatus) {
  if (status === "completed") return AUDIT_ACTIONS.SETTLEMENT_RUN_COMPLETED;
  if (status === "failed") return AUDIT_ACTIONS.SETTLEMENT_RUN_FAILED;

  return "";
}

export function createSettlementRunController({
  drawingId,
  gameId,
  notes,
  runs,
}: {
  drawingId: string;
  gameId: string;
  notes: string;
  runs: SettlementRun[];
}) {
  const validation = validateSettlementRunCreation({ drawingId, runs });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const run = buildSettlementRunPayload({ drawingId, gameId, notes });

  return controllerSuccess({
    run,
    auditEvents: [
      createAuditEvent({
        entityType: "settlement_run",
        entityId: run.id,
        action: AUDIT_ACTIONS.SETTLEMENT_RUN_CREATED,
        actorType: "admin",
        actorId: "admin",
        newValue: run,
      }),
    ],
    runs: saveSettlementRun(runs, run),
  });
}

export function generatePlaceholderSettlementRecordsController({
  settlementRunId,
  runs,
  records,
  tickets,
  ticketLines,
}: {
  settlementRunId: string;
  runs: SettlementRun[];
  records: SettlementRecord[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
}) {
  const run = findSettlementRunById(runs, settlementRunId);

  if (!run) {
    return controllerFailure("Settlement run not found.");
  }

  const validation = validatePlaceholderSettlementRecords({
    records,
    settlementRunId,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  const built = buildPlaceholderSettlementRecords({ run, tickets, ticketLines });

  return controllerSuccess({
    acceptedTickets: built.acceptedTickets,
    records: saveSettlementRecords(records, built.records),
    newRecords: built.records,
    runs: updateSettlementRun(runs, {
      ...run,
      processedTicketCount: built.acceptedTickets.length,
      processedLineCount: built.records.length,
      totalStake: built.totals.totalStake,
      totalPayout: built.totals.totalPayout,
      totalNet: built.totals.totalNet,
    }),
  });
}

export function updateSettlementRunStatusController({
  settlementRunId,
  nextStatus,
  runs,
  records,
}: {
  settlementRunId: string;
  nextStatus: SettlementRunStatus;
  runs: SettlementRun[];
  records: SettlementRecord[];
}) {
  const run = findSettlementRunById(runs, settlementRunId);
  const validation = validateSettlementStatusTransition({
    run,
    nextStatus,
    runs,
  });

  if (!validation.valid) {
    return controllerFailure(validation.errors);
  }

  if (!run) {
    return controllerFailure("Settlement run not found.");
  }

  const nextRun = applySettlementRunStatusTransition({
    run,
    nextStatus,
    records,
    runs,
  });

  return controllerSuccess({
    auditEvents: getSettlementStatusAuditAction(nextStatus)
      ? [
          createAuditEvent({
            entityType: "settlement_run",
            entityId: nextRun.id,
            action: getSettlementStatusAuditAction(nextStatus),
            actorType: "admin",
            actorId: "admin",
            oldValue: run,
            newValue: nextRun,
          }),
        ]
      : [],
    runs: updateSettlementRun(runs, nextRun),
    records:
      nextStatus === "reversed"
        ? reverseSettlementRecords(records, settlementRunId)
        : records,
  });
}

export function reverseSettlementRunController({
  settlementRunId,
  runs,
  records,
}: {
  settlementRunId: string;
  runs: SettlementRun[];
  records: SettlementRecord[];
}) {
  return updateSettlementRunStatusController({
    settlementRunId,
    nextStatus: "reversed",
    runs,
    records,
  });
}

export function executeSettlementRunController({
  settlementRunId,
  runs,
  records,
  tickets,
  ticketLines,
  wagerTypes,
  wagerOptions,
  payTableRows,
  winningNumbers,
  bullseyeNumber,
  drawMetrics,
  officialResultPostedAt,
  ledgerTransactions = [],
}: {
  settlementRunId: string;
  runs: SettlementRun[];
  records: SettlementRecord[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
  wagerTypes: WagerType[];
  wagerOptions: WagerOption[];
  payTableRows: PayTableRow[];
  winningNumbers: number[];
  bullseyeNumber?: number | null;
  drawMetrics?: KenoDrawMetrics | null;
  officialResultPostedAt?: string | null;
  ledgerTransactions?: LedgerTransaction[];
}) {
  const run = findSettlementRunById(runs, settlementRunId);

  if (!run) {
    return controllerFailure("Settlement run not found.");
  }

  const execution = executeSettlementRun({
    settlementRun: run,
    drawingId: run.drawingId,
    gameId: run.gameId,
    tickets,
    ticketLines,
    wagerTypes,
    wagerOptions,
    payTableRows,
    winningNumbers,
    bullseyeNumber,
    drawMetrics,
    officialResultPostedAt,
    existingSettlementRecords: records,
  });
  const runRecords = records.filter(
    (record) => record.settlementRunId === run.id
  );
  const ledgerPosting = createLedgerTransactionsForSettlementRecords({
    settlementRecords: [...runRecords, ...execution.settlementRecords],
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    existingLedgerTransactions: ledgerTransactions,
  });
  const completedRun: SettlementRun = {
    ...run,
    status: execution.summary.status,
    expectedTicketCount: execution.summary.expectedTicketCount,
    expectedLineCount: execution.summary.expectedLineCount,
    startedAt: execution.summary.startedAt,
    completedAt: execution.summary.completedAt,
    executionId: execution.summary.executionId,
    processedTicketCount: execution.summary.processedTicketCount,
    processedLineCount: execution.summary.processedLineCount,
    winCount: execution.summary.winCount,
    lossCount: execution.summary.lossCount,
    pushCount: execution.summary.pushCount,
    failedCount: execution.summary.failedCount,
    totalStake: execution.summary.totalStake,
    totalPayout: execution.summary.totalPayout,
    totalNet: execution.summary.totalNet,
    durationMs: execution.summary.durationMs,
    ticketsPerSecond: execution.summary.ticketsPerSecond,
    linesPerSecond: execution.summary.linesPerSecond,
    drawToSettlementMs: execution.summary.drawToSettlementMs,
    peakConcurrentSettlements: execution.summary.peakConcurrentSettlements,
  };

  return controllerSuccess({
    execution: {
      ...execution,
      settlementRecords: ledgerPosting.settlementRecords,
    },
    auditEvents: [
      createAuditEvent({
        entityType: "settlement_run",
        entityId: completedRun.id,
        action:
          completedRun.status === "completed"
            ? AUDIT_ACTIONS.SETTLEMENT_RUN_COMPLETED
            : AUDIT_ACTIONS.SETTLEMENT_RUN_FAILED,
        actorType: "system",
        actorId: "settlement-engine",
        oldValue: run,
        newValue: completedRun,
        metadata: {
          executionId: execution.summary.executionId,
          processedLineCount: execution.summary.processedLineCount,
          failedCount: execution.summary.failedCount,
        },
      }),
      ...ledgerPosting.ledgerTransactions.map((transaction) =>
        createAuditEvent({
          entityType: "ledger_transaction",
          entityId: transaction.id,
          action: AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
          actorType: "system",
          actorId: "settlement-engine",
          newValue: transaction,
          metadata: { settlementRunId: completedRun.id },
        })
      ),
    ],
    runs: updateSettlementRun(runs, completedRun),
    records: mergeSettlementRecordsForRun({
      records,
      settlementRunId: run.id,
      runRecords: ledgerPosting.settlementRecords,
    }),
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    ledgerTransactions: saveLedgerTransactions(
      ledgerTransactions,
      ledgerPosting.ledgerTransactions
    ),
    newLedgerTransactions: ledgerPosting.ledgerTransactions,
  });
}

export function resumeSettlementRunController({
  settlementRunId,
  runs,
  records,
  tickets,
  ticketLines,
  wagerTypes,
  wagerOptions,
  payTableRows,
  winningNumbers,
  bullseyeNumber,
  drawMetrics,
  officialResultPostedAt,
  ledgerTransactions = [],
}: {
  settlementRunId: string;
  runs: SettlementRun[];
  records: SettlementRecord[];
  tickets: Ticket[];
  ticketLines: TicketLine[];
  wagerTypes: WagerType[];
  wagerOptions: WagerOption[];
  payTableRows: PayTableRow[];
  winningNumbers: number[];
  bullseyeNumber?: number | null;
  drawMetrics?: KenoDrawMetrics | null;
  officialResultPostedAt?: string | null;
  ledgerTransactions?: LedgerTransaction[];
}) {
  const run = findSettlementRunById(runs, settlementRunId);

  if (!run) {
    return controllerFailure("Settlement run not found.");
  }

  if (!canResumeSettlementRun(run)) {
    return controllerFailure("Settlement run cannot be resumed.");
  }

  const execution = resumeSettlementRun({
    settlementRun: run,
    drawingId: run.drawingId,
    gameId: run.gameId,
    tickets,
    ticketLines,
    wagerTypes,
    wagerOptions,
    payTableRows,
    winningNumbers,
    bullseyeNumber,
    drawMetrics,
    officialResultPostedAt,
    existingSettlementRecords: records,
  });
  const runRecords = records.filter(
    (record) => record.settlementRunId === run.id
  );
  const ledgerPosting = createLedgerTransactionsForSettlementRecords({
    settlementRecords: [...runRecords, ...execution.settlementRecords],
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    existingLedgerTransactions: ledgerTransactions,
  });
  const nextRun: SettlementRun = {
    ...run,
    status: execution.summary.status,
    expectedTicketCount: execution.summary.expectedTicketCount,
    expectedLineCount: execution.summary.expectedLineCount,
    startedAt: execution.summary.startedAt,
    completedAt: execution.summary.completedAt,
    executionId: execution.summary.executionId,
    processedTicketCount: execution.summary.processedTicketCount,
    processedLineCount: execution.summary.processedLineCount,
    winCount: execution.summary.winCount,
    lossCount: execution.summary.lossCount,
    pushCount: execution.summary.pushCount,
    failedCount: execution.summary.failedCount,
    totalStake: execution.summary.totalStake,
    totalPayout: execution.summary.totalPayout,
    totalNet: execution.summary.totalNet,
    durationMs: execution.summary.durationMs,
    ticketsPerSecond: execution.summary.ticketsPerSecond,
    linesPerSecond: execution.summary.linesPerSecond,
    drawToSettlementMs: execution.summary.drawToSettlementMs,
    peakConcurrentSettlements: execution.summary.peakConcurrentSettlements,
  };

  return controllerSuccess({
    execution: {
      ...execution,
      settlementRecords: ledgerPosting.settlementRecords,
    },
    auditEvents: [
      createAuditEvent({
        entityType: "settlement_run",
        entityId: nextRun.id,
        action:
          nextRun.status === "completed"
            ? AUDIT_ACTIONS.SETTLEMENT_RUN_COMPLETED
            : AUDIT_ACTIONS.SETTLEMENT_RUN_FAILED,
        actorType: "worker",
        actorId: "settlement-recovery",
        oldValue: run,
        newValue: nextRun,
        metadata: {
          executionId: execution.summary.executionId,
          processedLineCount: execution.summary.processedLineCount,
          failedCount: execution.summary.failedCount,
        },
      }),
      ...ledgerPosting.ledgerTransactions.map((transaction) =>
        createAuditEvent({
          entityType: "ledger_transaction",
          entityId: transaction.id,
          action: AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
          actorType: "worker",
          actorId: "settlement-recovery",
          newValue: transaction,
          metadata: { settlementRunId: nextRun.id },
        })
      ),
    ],
    runs: updateSettlementRun(runs, nextRun),
    records: mergeSettlementRecordsForRun({
      records,
      settlementRunId: run.id,
      runRecords: ledgerPosting.settlementRecords,
    }),
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    ledgerTransactions: saveLedgerTransactions(
      ledgerTransactions,
      ledgerPosting.ledgerTransactions
    ),
    newLedgerTransactions: ledgerPosting.ledgerTransactions,
  });
}
