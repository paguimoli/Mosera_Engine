import { generateSettlementRunId } from "./settlement.helpers";
import type {
  SettlementRecord,
  SettlementRun,
  SettlementRunStatus,
} from "./settlement.types";
import type { Ticket, TicketLine } from "../tickets/ticket.types";

export function getSettlementRecordsForRun(
  records: SettlementRecord[],
  settlementRunId: string
) {
  return records.filter((record) => record.settlementRunId === settlementRunId);
}

export function getSettlementRecordsForTicket(
  records: SettlementRecord[],
  ticketId: string
) {
  return records.filter((record) => record.ticketId === ticketId);
}

export function getSettlementRunsForDrawing(
  runs: SettlementRun[],
  drawingId: string
) {
  return runs.filter((run) => run.drawingId === drawingId);
}

export function calculateSettlementRunTotals(records: SettlementRecord[]) {
  const processedTicketIds = new Set(records.map((record) => record.ticketId));

  return {
    processedTicketCount: processedTicketIds.size,
    processedLineCount: records.length,
    totalStake: records.reduce(
      (total, record) => total + Number(record.stake || 0),
      0
    ),
    totalPayout: records.reduce(
      (total, record) => total + Number(record.payout || 0),
      0
    ),
    totalNet: records.reduce(
      (total, record) => total + Number(record.netAmount || 0),
      0
    ),
  };
}

export function hasExistingCompletedSettlementForDrawing(
  runs: SettlementRun[],
  drawingId: string,
  exceptRunId?: string
) {
  return runs.some(
    (run) =>
      run.id !== exceptRunId &&
      run.drawingId === drawingId &&
      run.status === "completed"
  );
}

export function buildSettlementRunPayload({
  drawingId,
  gameId,
  notes,
}: {
  drawingId: string;
  gameId: string;
  notes: string;
}): SettlementRun {
  return {
    id: generateSettlementRunId(),
    drawingId,
    gameId,
    status: "pending",
    startedAt: null,
    completedAt: null,
    processedTicketCount: 0,
    processedLineCount: 0,
    totalStake: 0,
    totalPayout: 0,
    totalNet: 0,
    notes: notes.trim(),
    createdAt: new Date().toISOString(),
  };
}

export function buildPlaceholderSettlementRecords({
  run,
  tickets,
  ticketLines,
}: {
  run: SettlementRun;
  tickets: Ticket[];
  ticketLines: TicketLine[];
}) {
  const acceptedTickets = tickets.filter(
    (ticket) => ticket.drawingId === run.drawingId && ticket.status === "accepted"
  );
  const acceptedTicketIds = new Set(acceptedTickets.map((ticket) => ticket.id));
  const createdAt = new Date().toISOString();
  const records: SettlementRecord[] = ticketLines
    .filter((line) => acceptedTicketIds.has(line.ticketId))
    .map((line, index) => {
      const ticket = acceptedTickets.find(
        (acceptedTicket) => acceptedTicket.id === line.ticketId
      );

      return {
        id: `SETTLEMENT-RECORD-${Date.now()}-${index}`,
        settlementRunId: run.id,
        ticketId: line.ticketId,
        ticketLineId: line.id,
        accountId: ticket?.accountId || "",
        gameId: run.gameId,
        drawingId: run.drawingId,
        wagerTypeId: line.wagerTypeId,
        wagerOptionId: line.wagerOptionId || null,
        stake: Number(line.stake || 0),
        payout: 0,
        netAmount: 0,
        outcome: "push",
        status: "pending",
        version: 1,
        previousSettlementRecordId: null,
        reversalOfSettlementRecordId: null,
        ledgerTransactionIds: [],
        createdAt,
      };
    });

  return {
    acceptedTickets,
    records,
    totals: {
      ...calculateSettlementRunTotals(records),
      processedTicketCount: acceptedTickets.length,
    },
  };
}

export function canTransitionSettlementRunStatus(
  run: SettlementRun,
  nextStatus: SettlementRunStatus,
  runs: SettlementRun[]
) {
  if (nextStatus === "running") {
    return run.status === "pending";
  }

  if (nextStatus === "completed") {
    return (
      run.status === "running" &&
      !hasExistingCompletedSettlementForDrawing(runs, run.drawingId, run.id)
    );
  }

  if (nextStatus === "failed") {
    return run.status === "pending" || run.status === "running";
  }

  if (nextStatus === "reversed") {
    return run.status === "completed";
  }

  return true;
}

export function applySettlementRunStatusTransition({
  run,
  nextStatus,
  records,
  runs,
}: {
  run: SettlementRun;
  nextStatus: SettlementRunStatus;
  records: SettlementRecord[];
  runs: SettlementRun[];
}) {
  if (!canTransitionSettlementRunStatus(run, nextStatus, runs)) {
    return run;
  }

  const now = new Date().toISOString();
  const totals = calculateSettlementRunTotals(
    getSettlementRecordsForRun(records, run.id)
  );

  return {
    ...run,
    ...totals,
    status: nextStatus,
    startedAt: nextStatus === "running" ? now : run.startedAt,
    completedAt:
      nextStatus === "completed" || nextStatus === "failed"
        ? now
        : run.completedAt,
  };
}

export function reverseSettlementRecords(
  records: SettlementRecord[],
  settlementRunId: string
) {
  return records.map((record) =>
    record.settlementRunId === settlementRunId
      ? {
          ...record,
          status: "reversed",
          reversalOfSettlementRecordId:
            record.reversalOfSettlementRecordId || record.id,
        }
      : record
  );
}
