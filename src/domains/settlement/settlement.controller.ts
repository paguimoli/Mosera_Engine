import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import { createAuditEvent } from "../audit/audit.service";
import { AUDIT_ACTIONS } from "../audit/audit.types";
import { attachIntegrityHash } from "../integrity/integrity.helpers";
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
import {
  applyCreditSettlementForRecords,
  type SettlementCreditApplicationResult,
} from "./settlement-credit.service";
import { applySettlementLedgerEffects } from "./settlement-financial-effects.service";
import { runSettlementShadowComparison } from "./settlement-shadow-client";
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
import { logger } from "@/src/lib/observability/logger";

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

function hasCreditBackedSettlements({
  settlementRecords,
  tickets,
}: {
  settlementRecords: SettlementRecord[];
  tickets: Ticket[];
}) {
  const ticketsById = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  return settlementRecords.some((record) => {
    const ticket = ticketsById.get(record.ticketId);

    return Boolean(ticket?.reservationId);
  });
}

async function applyCreditSettlementsForRun({
  settlementRecords,
  tickets,
  settlementRunId,
  currency,
  correlationId,
}: {
  settlementRecords: SettlementRecord[];
  tickets: Ticket[];
  settlementRunId: string;
  currency?: string | null;
  correlationId?: string | null;
}) {
  const hasCreditSettlements = hasCreditBackedSettlements({
    settlementRecords,
    tickets,
  });

  if (!hasCreditSettlements) {
    return {
      creditSettlementResults: [] as SettlementCreditApplicationResult[],
      creditSettlementFailures: [] as SettlementCreditApplicationResult[],
    };
  }

  const creditSettlementResults = currency
    ? await applyCreditSettlementForRecords({
        settlementRecords,
        tickets,
        currency,
        correlationId,
      })
    : settlementRecords
        .filter((record) => {
          const ticket = tickets.find(
            (updatedTicket) => updatedTicket.id === record.ticketId
          );

          return Boolean(ticket?.reservationId);
        })
        .map((record): SettlementCreditApplicationResult => {
          const ticket = tickets.find(
            (updatedTicket) => updatedTicket.id === record.ticketId
          );

          return {
            settlementRecordId: record.id,
            ticketId: record.ticketId,
            reservationId: ticket?.reservationId ?? null,
            status: "failed",
            reason: "Currency is required to apply credit settlement release.",
          };
        });

  const creditSettlementFailures = creditSettlementResults.filter(
    (result) => result.status === "failed"
  );

  for (const failure of creditSettlementFailures) {
    logger.error({
      message: "Credit settlement application failed during settlement execution.",
      correlationId,
      metadata: {
        ticketId: failure.ticketId,
        reservationId: failure.reservationId ?? null,
        settlementRecordId: failure.settlementRecordId,
        settlementRunId,
        error: failure.reason ?? "Credit settlement application failed.",
      },
    });
  }

  return {
    creditSettlementResults,
    creditSettlementFailures,
  };
}

function formatCreditSettlementErrors({
  creditSettlementFailures,
  correlationId,
}: {
  creditSettlementFailures: SettlementCreditApplicationResult[];
  correlationId?: string | null;
}) {
  return creditSettlementFailures.map((failure) =>
    [
      "Credit settlement application failed.",
      `ticketId=${failure.ticketId}`,
      `reservationId=${failure.reservationId ?? ""}`,
      `settlementRecordId=${failure.settlementRecordId}`,
      `correlationId=${correlationId ?? ""}`,
      `error=${failure.reason ?? "Unknown error"}`,
    ].join(" ")
  );
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

export async function executeSettlementRunController({
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
  currency = null,
  correlationId = null,
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
  ledgerTransactions?: unknown[];
  currency?: string | null;
  correlationId?: string | null;
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
  const ledgerEffects = await applySettlementLedgerEffects({
    settlementRecords: [...runRecords, ...execution.settlementRecords],
  });
  const shadowSummary = await runSettlementShadowComparison({
    settlementRecords: ledgerEffects.settlementRecords,
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    winningNumbers,
    currency,
    correlationId,
  });
  const { creditSettlementResults, creditSettlementFailures } =
    await applyCreditSettlementsForRun({
      settlementRecords: ledgerEffects.settlementRecords,
      tickets: execution.updatedTickets,
      settlementRunId: run.id,
      currency,
      correlationId,
    });
  const hasCreditSettlementFailures = creditSettlementFailures.length > 0;

  const completedRun: SettlementRun = attachIntegrityHash({
    ...run,
    status: hasCreditSettlementFailures ? "failed" : execution.summary.status,
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
  }, "settlement_run", run.id, run.previousHash || null);

  return controllerSuccess({
    execution: {
      ...execution,
      settlementRecords: ledgerEffects.settlementRecords,
      creditSettlementResults,
      shadowSummary,
      errors: [
        ...execution.errors,
        ...formatCreditSettlementErrors({
          creditSettlementFailures,
          correlationId,
        }),
      ],
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
          creditSettlementFailureCount: creditSettlementFailures.length,
        },
      }),
      ...ledgerEffects.ledgerEntries.map((entry) =>
        createAuditEvent({
          entityType: "financial_ledger_entry",
          entityId: entry.id,
          action: AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
          actorType: "system",
          actorId: "settlement-engine",
          newValue: entry,
          metadata: { settlementRunId: completedRun.id },
        })
      ),
    ],
    runs: updateSettlementRun(runs, completedRun),
    records: mergeSettlementRecordsForRun({
      records,
      settlementRunId: run.id,
      runRecords: ledgerEffects.settlementRecords,
    }),
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    ledgerTransactions,
    newLedgerTransactions: ledgerEffects.legacyLedgerTransactions,
    ledgerEntries: ledgerEffects.ledgerEntries,
  });
}

export async function resumeSettlementRunController({
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
  currency = null,
  correlationId = null,
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
  ledgerTransactions?: unknown[];
  currency?: string | null;
  correlationId?: string | null;
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
  const ledgerEffects = await applySettlementLedgerEffects({
    settlementRecords: [...runRecords, ...execution.settlementRecords],
  });
  const shadowSummary = await runSettlementShadowComparison({
    settlementRecords: ledgerEffects.settlementRecords,
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    winningNumbers,
    currency,
    correlationId,
  });
  const { creditSettlementResults, creditSettlementFailures } =
    await applyCreditSettlementsForRun({
      settlementRecords: ledgerEffects.settlementRecords,
      tickets: execution.updatedTickets,
      settlementRunId: run.id,
      currency,
      correlationId,
    });
  const hasCreditSettlementFailures = creditSettlementFailures.length > 0;

  const nextRun: SettlementRun = attachIntegrityHash({
    ...run,
    status: hasCreditSettlementFailures ? "failed" : execution.summary.status,
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
  }, "settlement_run", run.id, run.previousHash || null);

  return controllerSuccess({
    execution: {
      ...execution,
      settlementRecords: ledgerEffects.settlementRecords,
      creditSettlementResults,
      shadowSummary,
      errors: [
        ...execution.errors,
        ...formatCreditSettlementErrors({
          creditSettlementFailures,
          correlationId,
        }),
      ],
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
          creditSettlementFailureCount: creditSettlementFailures.length,
        },
      }),
      ...ledgerEffects.ledgerEntries.map((entry) =>
        createAuditEvent({
          entityType: "financial_ledger_entry",
          entityId: entry.id,
          action: AUDIT_ACTIONS.LEDGER_TRANSACTION_CREATED,
          actorType: "worker",
          actorId: "settlement-recovery",
          newValue: entry,
          metadata: { settlementRunId: nextRun.id },
        })
      ),
    ],
    runs: updateSettlementRun(runs, nextRun),
    records: mergeSettlementRecordsForRun({
      records,
      settlementRunId: run.id,
      runRecords: ledgerEffects.settlementRecords,
    }),
    tickets: execution.updatedTickets,
    ticketLines: execution.updatedTicketLines,
    ledgerTransactions,
    newLedgerTransactions: ledgerEffects.legacyLedgerTransactions,
    ledgerEntries: ledgerEffects.ledgerEntries,
  });
}
