import type { Ticket, TicketLine, TicketLineStatus } from "../tickets/ticket.types";
import type {
  KenoDrawMetrics,
  PayTableRow,
  WagerOption,
  WagerType,
} from "../wagers/wager.types";
import {
  failedResult,
  type SettlementEvaluationResult,
} from "./evaluators/settlement-evaluator.types";
import { evaluateTicketLine } from "./settlement-evaluator-router.service";
import type {
  SettlementOutcome,
  SettlementRecord,
  SettlementRecordStatus,
  SettlementRun,
} from "./settlement.types";

export type SettlementExecutionInput = {
  settlementRun: SettlementRun;
  drawingId: string;
  gameId: string;
  tickets: Ticket[];
  ticketLines: TicketLine[];
  wagerTypes: WagerType[];
  wagerOptions: WagerOption[];
  payTableRows: PayTableRow[];
  winningNumbers: number[];
  bullseyeNumber?: number | null;
  drawMetrics?: KenoDrawMetrics | null;
  officialResultPostedAt?: string | null;
  existingSettlementRecords?: SettlementRecord[];
};

export type SettlementExecutionSummary = {
  settlementRunId: string;
  drawingId: string;
  gameId: string;
  processedTicketCount: number;
  processedLineCount: number;
  winCount: number;
  lossCount: number;
  pushCount: number;
  failedCount: number;
  totalStake: number;
  totalPayout: number;
  totalNet: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ticketsPerSecond: number;
  linesPerSecond: number;
  drawToSettlementMs?: number | null;
};

export type SettlementExecutionResult = {
  summary: SettlementExecutionSummary;
  settlementRecords: SettlementRecord[];
  updatedTickets: Ticket[];
  updatedTicketLines: TicketLine[];
  errors: string[];
};

const FINAL_LINE_STATUSES: TicketLineStatus[] = [
  "won",
  "lost",
  "push",
  "void",
  "cancelled",
  "resettled",
];

function createSettlementRecordId({
  settlementRunId,
  ticketLineId,
  index,
}: {
  settlementRunId: string;
  ticketLineId: string;
  index: number;
}) {
  return `SETTLEMENT-RECORD-${settlementRunId}-${ticketLineId}-${index}`;
}

function mapEvaluationToRecordStatus(
  outcome: SettlementEvaluationResult["outcome"]
): SettlementRecordStatus {
  if (outcome === "void") {
    return "void";
  }

  if (outcome === "failed") {
    return "failed";
  }

  return "settled";
}

function mapEvaluationToLineStatus(
  outcome: SettlementEvaluationResult["outcome"]
): TicketLineStatus | null {
  if (outcome === "win") {
    return "won";
  }

  if (outcome === "loss") {
    return "lost";
  }

  if (outcome === "push") {
    return "push";
  }

  if (outcome === "void") {
    return "void";
  }

  return null;
}

function calculateRate(count: number, durationMs: number) {
  if (durationMs <= 0) {
    return count;
  }

  return count / (durationMs / 1000);
}

function calculateDrawToSettlementMs({
  officialResultPostedAt,
  completedAt,
}: {
  officialResultPostedAt?: string | null;
  completedAt: Date;
}) {
  if (!officialResultPostedAt) {
    return null;
  }

  const postedAtMs = new Date(officialResultPostedAt).getTime();

  if (Number.isNaN(postedAtMs)) {
    return null;
  }

  return completedAt.getTime() - postedAtMs;
}

export function executeSettlementRun(
  input: SettlementExecutionInput
): SettlementExecutionResult {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const errors: string[] = [];
  const eligibleTickets = input.tickets.filter(
    (ticket) =>
      ticket.drawingId === input.drawingId &&
      ticket.gameId === input.gameId &&
      ticket.status === "accepted"
  );
  const eligibleTicketIds = new Set(eligibleTickets.map((ticket) => ticket.id));
  const existingRecordLineIds = new Set(
    (input.existingSettlementRecords || [])
      .filter((record) => record.settlementRunId === input.settlementRun.id)
      .map((record) => record.ticketLineId)
  );
  const lineStatusUpdates = new Map<string, TicketLineStatus>();
  const settlementRecords: SettlementRecord[] = [];

  // Performance targets:
  // Rapid Draw: 25 second draw interval, 5 second lockout, settle under 5 seconds.
  // Hot Spot: 4 minute draw interval, settle under 15 seconds.
  for (const ticket of eligibleTickets) {
    const pendingLines = input.ticketLines.filter(
      (line) => line.ticketId === ticket.id && line.status === "pending"
    );

    for (const line of pendingLines) {
      if (existingRecordLineIds.has(line.id)) {
        errors.push(
          `Skipped duplicate settlement record for ticket line ${line.id}.`
        );
        continue;
      }

      const wagerType = input.wagerTypes.find(
        (type) => type.id === line.wagerTypeId
      );
      const wagerOption = line.wagerOptionId
        ? input.wagerOptions.find((option) => option.id === line.wagerOptionId)
        : null;
      const evaluation = wagerType
        ? evaluateTicketLine({
            ticketLine: line,
            wagerType,
            wagerOption,
            winningNumbers: input.winningNumbers,
            bullseyeNumber: input.bullseyeNumber,
            drawMetrics: input.drawMetrics,
            payTableRows: input.payTableRows,
          })
        : failedResult({
            reason: `Wager type not found for ticket line ${line.id}.`,
            metadata: { wagerTypeId: line.wagerTypeId },
          });

      if (!wagerType) {
        errors.push(`Wager type not found for ticket line ${line.id}.`);
      }

      const lineStatus = mapEvaluationToLineStatus(evaluation.outcome);

      if (lineStatus) {
        lineStatusUpdates.set(line.id, lineStatus);
      } else {
        errors.push(
          `Ticket line ${line.id} failed settlement evaluation and remains pending.`
        );
      }

      settlementRecords.push({
        id: createSettlementRecordId({
          settlementRunId: input.settlementRun.id,
          ticketLineId: line.id,
          index: settlementRecords.length,
        }),
        settlementRunId: input.settlementRun.id,
        ticketId: line.ticketId,
        ticketLineId: line.id,
        accountId: ticket.accountId,
        gameId: input.gameId,
        drawingId: input.drawingId,
        wagerTypeId: line.wagerTypeId,
        wagerOptionId: line.wagerOptionId || null,
        stake: Number(line.stake || 0),
        payout: Number(evaluation.payout || 0),
        netAmount: Number(evaluation.netAmount || 0),
        outcome: evaluation.outcome as SettlementOutcome,
        status: mapEvaluationToRecordStatus(evaluation.outcome),
        version: 1,
        previousSettlementRecordId: null,
        reversalOfSettlementRecordId: null,
        // TODO Phase 5.5: create idempotent operational ledger entries here.
        ledgerTransactionIds: [],
        createdAt: startedAt,
      });
    }
  }

  const completedAtDate = new Date();
  const completedAt = completedAtDate.toISOString();
  const updatedTicketLines = input.ticketLines.map((line) => {
    const nextStatus = lineStatusUpdates.get(line.id);

    if (!nextStatus) {
      return line;
    }

    return {
      ...line,
      status: nextStatus,
      resultAmount:
        nextStatus === "won"
          ? settlementRecords.find((record) => record.ticketLineId === line.id)
              ?.payout ?? line.resultAmount
          : nextStatus === "lost"
            ? 0
            : line.resultAmount,
    };
  });
  const updatedTickets = input.tickets.map((ticket) => {
    if (!eligibleTicketIds.has(ticket.id)) {
      return ticket;
    }

    const linesForTicket = updatedTicketLines.filter(
      (line) => line.ticketId === ticket.id
    );
    const allLinesFinal =
      linesForTicket.length > 0 &&
      linesForTicket.every((line) => FINAL_LINE_STATUSES.includes(line.status));

    if (!allLinesFinal) {
      return ticket;
    }

    return {
      ...ticket,
      status: "settled" as const,
      settledAt: completedAt,
    };
  });
  const durationMs = completedAtDate.getTime() - startedAtDate.getTime();
  const winCount = settlementRecords.filter(
    (record) => record.outcome === "win"
  ).length;
  const lossCount = settlementRecords.filter(
    (record) => record.outcome === "loss"
  ).length;
  const pushCount = settlementRecords.filter(
    (record) => record.outcome === "push"
  ).length;
  const failedCount = settlementRecords.filter(
    (record) => record.outcome === "failed"
  ).length;
  const totalStake = settlementRecords.reduce(
    (total, record) => total + Number(record.stake || 0),
    0
  );
  const totalPayout = settlementRecords.reduce(
    (total, record) => total + Number(record.payout || 0),
    0
  );
  const totalNet = settlementRecords.reduce(
    (total, record) => total + Number(record.netAmount || 0),
    0
  );

  return {
    summary: {
      settlementRunId: input.settlementRun.id,
      drawingId: input.drawingId,
      gameId: input.gameId,
      processedTicketCount: eligibleTickets.length,
      processedLineCount: settlementRecords.length,
      winCount,
      lossCount,
      pushCount,
      failedCount,
      totalStake,
      totalPayout,
      totalNet,
      startedAt,
      completedAt,
      durationMs,
      ticketsPerSecond: calculateRate(eligibleTickets.length, durationMs),
      linesPerSecond: calculateRate(settlementRecords.length, durationMs),
      drawToSettlementMs: calculateDrawToSettlementMs({
        officialResultPostedAt: input.officialResultPostedAt,
        completedAt: completedAtDate,
      }),
    },
    settlementRecords,
    updatedTickets,
    updatedTicketLines,
    errors,
  };
}
