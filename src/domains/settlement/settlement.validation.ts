import { invalid, valid } from "@/src/lib/validation/validation.types";
import type {
  SettlementRecord,
  SettlementRun,
  SettlementRunStatus,
} from "./settlement.types";
import {
  canTransitionSettlementRunStatus,
  getSettlementRecordsForRun,
  getSettlementRunsForDrawing,
  hasExistingCompletedSettlementForDrawing,
} from "./settlement.service";

export function validateSettlementRunCreation({
  drawingId,
  runs,
}: {
  drawingId: string;
  runs: SettlementRun[];
}) {
  if (!drawingId) {
    return invalid("Please select a drawing.");
  }

  if (hasExistingCompletedSettlementForDrawing(runs, drawingId)) {
    return invalid(
      "A completed settlement run already exists for this drawing. Future resettlement will require explicit override authorization."
    );
  }

  return valid();
}

export function hasExistingSettlementRunForDrawing(
  runs: SettlementRun[],
  drawingId: string
) {
  return getSettlementRunsForDrawing(runs, drawingId).length > 0;
}

export function validatePlaceholderSettlementRecords({
  records,
  settlementRunId,
}: {
  records: SettlementRecord[];
  settlementRunId: string;
}) {
  if (getSettlementRecordsForRun(records, settlementRunId).length > 0) {
    return invalid("Placeholder settlement records already exist for this run.");
  }

  return valid();
}

export function validateSettlementStatusTransition({
  run,
  nextStatus,
  runs,
}: {
  run: SettlementRun | undefined;
  nextStatus: SettlementRunStatus;
  runs: SettlementRun[];
}) {
  if (!run) {
    return invalid("Settlement run not found.");
  }

  if (nextStatus === "completed") {
    if (
      hasExistingCompletedSettlementForDrawing(runs, run.drawingId, run.id)
    ) {
      return invalid("A completed settlement run already exists for this drawing.");
    }
  }

  if (!canTransitionSettlementRunStatus(run, nextStatus, runs)) {
    return invalid("Invalid settlement run status transition.");
  }

  return valid();
}
