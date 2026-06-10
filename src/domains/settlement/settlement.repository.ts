import type { SettlementRecord, SettlementRun } from "./settlement.types";

export function findSettlementRunById(runs: SettlementRun[], settlementRunId: string) {
  return runs.find((run) => run.id === settlementRunId);
}

export function saveSettlementRun(runs: SettlementRun[], run: SettlementRun) {
  return [...runs, run];
}

export function saveSettlementRecords(
  records: SettlementRecord[],
  newRecords: SettlementRecord[]
) {
  return [...records, ...newRecords];
}

export function listSettlementRunsByDrawingId(
  runs: SettlementRun[],
  drawingId: string
) {
  return runs.filter((run) => run.drawingId === drawingId);
}

export function listSettlementRecordsByRunId(
  records: SettlementRecord[],
  settlementRunId: string
) {
  return records.filter((record) => record.settlementRunId === settlementRunId);
}

export function updateSettlementRunStatus(
  runs: SettlementRun[],
  nextRun: SettlementRun
) {
  return runs.map((run) => (run.id === nextRun.id ? nextRun : run));
}

export function updateSettlementRun(
  runs: SettlementRun[],
  nextRun: SettlementRun
) {
  return runs.map((run) => (run.id === nextRun.id ? nextRun : run));
}
