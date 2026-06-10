import {
  controllerFailure,
  controllerSuccess,
} from "@/src/lib/controller/controller.types";
import type { Ticket, TicketLine } from "../tickets/ticket.types";
import {
  findSettlementRunById,
  saveSettlementRecords,
  saveSettlementRun,
  updateSettlementRun,
} from "./settlement.repository";
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
