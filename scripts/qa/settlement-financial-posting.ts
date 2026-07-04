import {
  applySettlementLedgerEffects,
  generateSettlementLedgerEffects,
} from "@/src/domains/settlement/settlement-financial-effects.service";
import {
  createInMemorySettlementLedgerEffectRepository,
  createSettlementLedgerEffectRepository,
  type SettlementLedgerEffectRepository,
} from "@/src/domains/settlement/settlement-ledger-effects.repository";
import {
  createInMemorySettlementPersistenceRepository,
  createSettlementPersistenceRepository,
  type SettlementPersistenceRepository,
} from "@/src/domains/settlement/settlement-persistence.repository";
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

function settlementRun(id: string, drawingId: string): SettlementRun {
  const now = new Date().toISOString();

  return {
    id,
    drawingId,
    gameId: "qa-game",
    status: "completed",
    expectedTicketCount: 5,
    expectedLineCount: 5,
    startedAt: now,
    completedAt: now,
    executionId: `execution-${id}`,
    processedTicketCount: 5,
    processedLineCount: 5,
    winCount: 1,
    lossCount: 1,
    pushCount: 1,
    failedCount: 0,
    totalStake: 50,
    totalPayout: 40,
    totalNet: -10,
    durationMs: 10,
    ticketsPerSecond: 500,
    linesPerSecond: 500,
    drawToSettlementMs: null,
    peakConcurrentSettlements: 1,
    notes: "settlement financial posting QA",
    recordHash: `hash-${id}`,
    previousHash: null,
    hashVersion: "v1",
    createdAt: now,
  };
}

function record({
  id,
  settlementRunId,
  drawingId,
  ticketId,
  ticketLineId,
  outcome,
  status,
  stake,
  payout,
  netAmount,
  version = 1,
  reversalOfSettlementRecordId = null,
}: {
  id: string;
  settlementRunId: string;
  drawingId: string;
  ticketId: string;
  ticketLineId: string;
  outcome: SettlementRecord["outcome"];
  status: SettlementRecord["status"];
  stake: number;
  payout: number;
  netAmount: number;
  version?: number;
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
    stake,
    payout,
    netAmount,
    outcome,
    status,
    version,
    previousSettlementRecordId: reversalOfSettlementRecordId,
    reversalOfSettlementRecordId,
    ledgerTransactionIds: [],
    recordHash: `hash-${id}`,
    previousHash: null,
    hashVersion: "v1",
    createdAt: new Date().toISOString(),
  };
}

async function verifyFinancialPosting({
  settlementRepository,
  ledgerEffectRepository,
  scope,
}: {
  settlementRepository: SettlementPersistenceRepository;
  ledgerEffectRepository: SettlementLedgerEffectRepository;
  scope: string;
}) {
  const unique = `${scope}-${Date.now()}`;
  const drawingId = `financial-draw-${unique}`;
  const run = settlementRun(`financial-run-${unique}`, drawingId);
  const records = [
    record({
      id: `financial-win-${unique}`,
      settlementRunId: run.id,
      drawingId,
      ticketId: `ticket-win-${unique}`,
      ticketLineId: `line-win-${unique}`,
      outcome: "win",
      status: "settled",
      stake: 10,
      payout: 30,
      netAmount: 20,
    }),
    record({
      id: `financial-loss-${unique}`,
      settlementRunId: run.id,
      drawingId,
      ticketId: `ticket-loss-${unique}`,
      ticketLineId: `line-loss-${unique}`,
      outcome: "loss",
      status: "settled",
      stake: 10,
      payout: 0,
      netAmount: -10,
    }),
    record({
      id: `financial-push-${unique}`,
      settlementRunId: run.id,
      drawingId,
      ticketId: `ticket-push-${unique}`,
      ticketLineId: `line-push-${unique}`,
      outcome: "push",
      status: "settled",
      stake: 10,
      payout: 10,
      netAmount: 0,
    }),
    record({
      id: `financial-void-${unique}`,
      settlementRunId: run.id,
      drawingId,
      ticketId: `ticket-void-${unique}`,
      ticketLineId: `line-void-${unique}`,
      outcome: "void",
      status: "void",
      stake: 10,
      payout: 0,
      netAmount: 0,
    }),
    record({
      id: `financial-reversal-${unique}`,
      settlementRunId: run.id,
      drawingId,
      ticketId: `ticket-win-${unique}`,
      ticketLineId: `line-win-reversal-${unique}`,
      outcome: "win",
      status: "reversed",
      stake: 10,
      payout: -30,
      netAmount: -20,
      version: 2,
      reversalOfSettlementRecordId: `financial-win-${unique}`,
    }),
  ];

  await settlementRepository.saveRun(run);
  const result = await applySettlementLedgerEffects({ settlementRecords: records });
  const persistedEffects = await ledgerEffectRepository.appendEffects(result.ledgerEffects);
  await ledgerEffectRepository.appendEffects(result.ledgerEffects);
  await settlementRepository.appendRecords(result.settlementRecords);

  const effectsForRun = await ledgerEffectRepository.listEffectsByRunId(run.id);
  assert(
    effectsForRun.length === persistedEffects.length,
    `${scope} duplicate execution should not create additional ledger effects.`,
    { effectsForRun, persistedEffects }
  );

  const win = effectsForRun.find((effect) => effect.effectType === "WIN_PAYOUT");
  assert(
    win?.direction === "CREDIT" && win.amount === 30 && win.transactionType === "SETTLEMENT_CREDIT",
    `${scope} win should create a credit payout effect.`,
    { win }
  );
  pass(`${scope} win posts correct ledger effect`, { mode: ledgerEffectRepository.mode });

  const loss = effectsForRun.find((effect) => effect.effectType === "LOSS_RECOGNITION_NOOP");
  assert(
    loss?.postingStatus === "NO_OP" && loss.direction === "NOOP" && loss.amount === 0,
    `${scope} loss should be represented as a no-op when stake is already recognized.`,
    { loss }
  );
  pass(`${scope} loss no-op is explicit`, { mode: ledgerEffectRepository.mode });

  const push = effectsForRun.find((effect) => effect.effectType === "PUSH_REFUND");
  assert(
    push?.direction === "CREDIT" && push.amount === 10 && push.transactionType === "TICKET_REFUND",
    `${scope} push should create a refund effect.`,
    { push }
  );
  const voidEffect = effectsForRun.find((effect) => effect.effectType === "VOID_REFUND");
  assert(
    voidEffect?.direction === "CREDIT" && voidEffect.amount === 10 && voidEffect.transactionType === "TICKET_VOID",
    `${scope} void should create a void refund effect.`,
    { voidEffect }
  );
  pass(`${scope} refund and void effects are correct`, { mode: ledgerEffectRepository.mode });

  const reversal = effectsForRun.find((effect) => effect.effectType === "SETTLEMENT_REVERSAL");
  assert(
    reversal?.direction === "DEBIT" && reversal.amount === 30 && reversal.transactionType === "REVERSAL",
    `${scope} resettlement reversal should create an opposing ledger effect.`,
    { reversal }
  );
  pass(`${scope} resettlement reversal creates opposing effect`, { mode: ledgerEffectRepository.mode });

  const persistedRecords = await settlementRepository.listRecordsByRunId(run.id);
  const persistedWin = persistedRecords.find((item) => item.id === `financial-win-${unique}`);
  assert(
    Boolean(win && persistedWin?.ledgerTransactionIds.includes(win.id)),
    `${scope} settlement record should store ledger transaction/effect reference.`,
    { persistedWin, win }
  );
  pass(`${scope} settlement record stores ledger reference`, { mode: settlementRepository.mode });

  const duplicate = await ledgerEffectRepository.findEffectByIdempotencyKey(win?.idempotencyKey ?? "");
  assert(duplicate?.id === win?.id, `${scope} idempotency key lookup should return existing effect.`, {
    duplicate,
    win,
  });
  pass(`${scope} idempotency lookup returns existing effect`, { mode: ledgerEffectRepository.mode });

  const generatedAgain = generateSettlementLedgerEffects(records);
  assert(
    generatedAgain.map((effect) => effect.idempotencyKey).join("|") ===
      result.ledgerEffects.map((effect) => effect.idempotencyKey).join("|"),
    `${scope} generated idempotency keys should be deterministic.`,
    { generatedAgain, ledgerEffects: result.ledgerEffects }
  );
  pass(`${scope} deterministic idempotency keys`, { mode: ledgerEffectRepository.mode });
}

async function withRepositories(
  scope: string,
  settlementRepository: SettlementPersistenceRepository,
  ledgerEffectRepository: SettlementLedgerEffectRepository
) {
  try {
    await verifyFinancialPosting({ settlementRepository, ledgerEffectRepository, scope });
  } finally {
    await ledgerEffectRepository.close();
    await settlementRepository.close();
  }
}

async function main() {
  await withRepositories(
    "postgres",
    await createSettlementPersistenceRepository(),
    await createSettlementLedgerEffectRepository()
  );
  await withRepositories(
    "fallback",
    await createSettlementPersistenceRepository({ databaseUrl: null }),
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
  fail("Settlement financial posting QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
