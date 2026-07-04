import {
  DuplicateCompletedSettlementError,
  createInMemorySettlementPersistenceRepository,
  createSettlementPersistenceRepository,
  type SettlementPersistenceRepository,
} from "@/src/domains/settlement/settlement-persistence.repository";
import {
  createInMemorySettlementLedgerEffectRepository,
  createSettlementLedgerEffectRepository,
  type SettlementLedgerEffectRepository,
} from "@/src/domains/settlement/settlement-ledger-effects.repository";
import { generateSettlementLedgerEffects } from "@/src/domains/settlement/settlement-financial-effects.service";
import type { SettlementRecord, SettlementRun } from "@/src/domains/settlement/settlement.types";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

const checks: Check[] = [];

function fail(message: string, metadata: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) fail(message, metadata);
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

function isDuplicateCompletedSettlement(error: unknown) {
  return error instanceof DuplicateCompletedSettlementError;
}

function settlementRun({
  id,
  drawingId,
  status = "pending",
}: {
  id: string;
  drawingId: string;
  status?: SettlementRun["status"];
}): SettlementRun {
  const now = new Date().toISOString();

  return {
    id,
    drawingId,
    gameId: "qa-game",
    status,
    expectedTicketCount: 1,
    expectedLineCount: 1,
    startedAt: status === "pending" ? null : now,
    completedAt: status === "completed" ? now : null,
    executionId: `qa-execution-${id}`,
    processedTicketCount: status === "completed" ? 1 : 0,
    processedLineCount: status === "completed" ? 1 : 0,
    winCount: status === "completed" ? 1 : 0,
    lossCount: 0,
    pushCount: 0,
    failedCount: 0,
    totalStake: 10,
    totalPayout: status === "completed" ? 20 : 0,
    totalNet: status === "completed" ? 10 : 0,
    durationMs: status === "completed" ? 10 : 0,
    ticketsPerSecond: status === "completed" ? 100 : 0,
    linesPerSecond: status === "completed" ? 100 : 0,
    drawToSettlementMs: null,
    peakConcurrentSettlements: 1,
    notes: "durable settlement QA",
    recordHash: `hash-${id}`,
    previousHash: null,
    hashVersion: "v1",
    createdAt: now,
  };
}

function settlementRecord({
  id,
  settlementRunId,
  drawingId,
  ticketId,
  ticketLineId,
  status = "settled",
  reversalOfSettlementRecordId = null,
}: {
  id: string;
  settlementRunId: string;
  drawingId: string;
  ticketId: string;
  ticketLineId: string;
  status?: SettlementRecord["status"];
  reversalOfSettlementRecordId?: string | null;
}): SettlementRecord {
  return {
    id,
    settlementRunId,
    ticketId,
    ticketLineId,
    accountId: "qa-account",
    gameId: "qa-game",
    drawingId,
    wagerTypeId: "qa-wager-type",
    wagerOptionId: null,
    stake: 10,
    payout: status === "settled" ? 20 : 0,
    netAmount: status === "settled" ? 10 : 0,
    outcome: status === "settled" ? "win" : "push",
    status,
    version: 1,
    previousSettlementRecordId: null,
    reversalOfSettlementRecordId,
    ledgerTransactionIds: [],
    recordHash: `hash-${id}`,
    previousHash: null,
    hashVersion: "v1",
    createdAt: new Date().toISOString(),
  };
}

async function expectDuplicateCompletedSettlement(
  action: () => Promise<unknown>,
  message: string
) {
  try {
    await action();
  } catch (error) {
    assert(isDuplicateCompletedSettlement(error), message, {
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    return;
  }

  fail(message);
}

async function verifyRepository(
  repository: SettlementPersistenceRepository,
  ledgerEffectRepository: SettlementLedgerEffectRepository,
  scope: string
) {
  const unique = `${scope}-${Date.now()}`;
  const drawingId = `qa-draw-${unique}`;
  const run = settlementRun({ id: `qa-run-${unique}`, drawingId, status: "running" });
  const completedRun = settlementRun({
    id: `qa-completed-run-${unique}`,
    drawingId: `qa-completed-draw-${unique}`,
    status: "completed",
  });
  const record = settlementRecord({
    id: `qa-record-${unique}`,
    settlementRunId: run.id,
    drawingId,
    ticketId: `qa-ticket-${unique}`,
    ticketLineId: `qa-line-${unique}`,
  });

  const savedRun = await repository.saveRun(run);
  assert(savedRun.id === run.id, `${scope} settlement run should persist.`, { savedRun });
  const loadedRun = await repository.findRunById(run.id);
  assert(loadedRun?.id === run.id, `${scope} settlement run should read back.`, { loadedRun });
  pass(`${scope} settlement run persists`, { mode: repository.mode });

  await repository.appendRecords([record]);
  const ledgerEffects = await ledgerEffectRepository.appendEffects(
    generateSettlementLedgerEffects([record])
  );
  const runRecords = await repository.listRecordsByRunId(run.id);
  assert(runRecords.some((item) => item.id === record.id), `${scope} settlement record should persist.`, {
    runRecords,
  });
  const ticketRecords = await repository.listRecordsByTicketAndDraw(record.ticketId, drawingId);
  assert(
    ticketRecords.some((item) => item.id === record.id),
    `${scope} deterministic ticket/draw lookup should return the record.`,
    { ticketRecords }
  );
  pass(`${scope} settlement record and lookup persist`, { mode: repository.mode });
  assert(
    ledgerEffects.length > 0 &&
      (await ledgerEffectRepository.listEffectsByRunId(run.id)).length === ledgerEffects.length,
    `${scope} settlement ledger effect should persist.`,
    { ledgerEffects }
  );
  pass(`${scope} settlement ledger effect persists`, { mode: ledgerEffectRepository.mode });

  await repository.updateRun({ ...run, status: "recovering" });
  const incompleteRuns = await repository.listIncompleteRuns();
  assert(
    incompleteRuns.some((item) => item.id === run.id && item.status === "recovering"),
    `${scope} recovery lookup should include recovering runs.`,
    { incompleteRuns }
  );
  pass(`${scope} recovery lookup works`, { mode: repository.mode });

  await expectDuplicateCompletedSettlement(
    async () =>
      repository.appendRecords([
        settlementRecord({
          id: `qa-record-duplicate-${unique}`,
          settlementRunId: run.id,
          drawingId,
          ticketId: record.ticketId,
          ticketLineId: record.ticketLineId,
        }),
      ]),
    `${scope} duplicate completed settlement record should be blocked.`
  );
  pass(`${scope} duplicate completed record blocked`, { mode: repository.mode });

  await repository.saveRun(completedRun);
  await expectDuplicateCompletedSettlement(
    async () =>
      repository.saveRun(
        settlementRun({
          id: `qa-completed-run-duplicate-${unique}`,
          drawingId: completedRun.drawingId,
          status: "completed",
        })
      ),
    `${scope} duplicate completed settlement run should be blocked.`
  );
  pass(`${scope} duplicate completed run blocked`, { mode: repository.mode });
}

async function withRepositories(
  scope: string,
  repository: SettlementPersistenceRepository,
  ledgerEffectRepository: SettlementLedgerEffectRepository
) {
  try {
    await verifyRepository(repository, ledgerEffectRepository, scope);
  } finally {
    await ledgerEffectRepository.close();
    await repository.close();
  }
}

async function main() {
  const postgresRepository = await createSettlementPersistenceRepository();
  assert(
    postgresRepository.mode === "postgres",
    "DATABASE_URL-backed settlement persistence should use Postgres when configured.",
    { mode: postgresRepository.mode }
  );
  await withRepositories(
    "postgres",
    postgresRepository,
    await createSettlementLedgerEffectRepository()
  );

  const fallbackRepository = await createSettlementPersistenceRepository({ databaseUrl: null });
  assert(fallbackRepository.mode === "in-memory", "Missing DATABASE_URL should use in-memory fallback.", {
    mode: fallbackRepository.mode,
  });
  await withRepositories(
    "fallback",
    fallbackRepository,
    await createSettlementLedgerEffectRepository({ databaseUrl: null })
  );

  await withRepositories(
    "explicit-memory",
    createInMemorySettlementPersistenceRepository(),
    createInMemorySettlementLedgerEffectRepository()
  );

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error: unknown) => {
  fail("Durable settlement persistence QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
