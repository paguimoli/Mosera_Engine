import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import {
  evaluateFinancialAuthorityGuardrail,
} from "@/src/domains/financial-authority/financial-authority-guardrails";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type SeededWallet = QueryResultRow & {
  account_id: string;
  wallet_id: string;
};

type TicketLine = {
  ticketId: string;
  ticketLineId: string;
  accountId: string;
  ledgerWalletId: string;
  creditPlayerId?: string;
  creditReservationId?: string;
  creditSettlementId?: string;
  creditSettlementBatchId?: string;
  gameId: string;
  drawingId: string;
  wagerTypeId: string;
  wagerOptionId: string;
  stake: number;
  payout: number;
};

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(
  process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400"
);
const creditServiceUrl = trimTrailingSlash(
  process.env.CREDIT_SERVICE_URL ?? process.env.QA_CREDIT_SERVICE_URL ?? "http://localhost:5300"
);

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

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

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    fail("DATABASE_URL is required for Settlement Service recovery/resume QA.");
  }

  return databaseUrl;
}

async function readJson(response: Response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function settlementRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${settlementServiceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-settlement-resume-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await readJson(response),
  };
}

async function creditPost(path: string, body: Record<string, unknown>, idempotencyKey: string) {
  const response = await fetch(`${creditServiceUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": `qa-settlement-resume-credit-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    body: await readJson(response),
  };
}

async function seedWallet(pool: Pool): Promise<SeededWallet> {
  const accountId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `
insert into public.accounts (
  id,
  account_type,
  account_code,
  display_name,
  status
)
values ($1, 'PLAYER', $2, $3, 'ACTIVE')
`,
    [accountId, `qa-settlement-resume-${suffix}`, `QA Settlement Resume ${suffix}`]
  );

  const wallet = await pool.query<SeededWallet>(
    `
insert into public.financial_wallets (
  account_id,
  wallet_type,
  currency_code,
  balance_authority,
  status,
  balance,
  credit_limit,
  funding_model
)
values ($1, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100, 1000, 'CREDIT')
returning account_id::text, id::text as wallet_id
`,
    [accountId]
  );

  return wallet.rows[0];
}

async function reserveCredit(accountId: string, ticketId: string) {
  const result = await creditPost(
    `/v1/credit-wallets/${accountId}/reserve`,
    {
      ticketId,
      amount: {
        amount: 100,
        currency: "USD",
      },
      sourceService: "settlement-service-qa",
      metadata: {
        qa: "settlement-service-recovery-resume",
      },
    },
    `qa-settlement-resume-reserve-${randomUUID()}`
  );

  assert(result.response.ok, "Credit reservation setup should succeed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body;
}

function baseRun() {
  return {
    id: `qa-settlement-resume-run-${randomUUID()}`,
    drawingId: `qa-settlement-resume-drawing-${randomUUID()}`,
    gameId: `qa-game-${randomUUID()}`,
    status: "running",
    expectedTicketCount: 2,
    expectedLineCount: 2,
    startedAt: new Date().toISOString(),
    completedAt: null,
    executionId: null,
    processedTicketCount: 0,
    processedLineCount: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    failedCount: 0,
    totalStake: 0,
    totalPayout: 0,
    totalNet: 0,
    durationMs: 0,
    ticketsPerSecond: 0,
    linesPerSecond: 0,
    drawToSettlementMs: 250,
    peakConcurrentSettlements: 1,
    notes: "qa:settlement-service-recovery-resume",
    recordHash: null,
    previousHash: null,
    hashVersion: null,
    createdAt: new Date().toISOString(),
  };
}

function deterministicId(prefix: string, ...parts: string[]) {
  const normalized = parts
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
    )
    .join("-");

  return `${prefix}-${normalized}`;
}

function createRecord(run: ReturnType<typeof baseRun>, line: TicketLine, index: number) {
  const stake = line.stake;
  const payout = line.payout;
  const netAmount = payout - stake;

  return {
    id: deterministicId("settlement-record", run.id, line.ticketId, line.ticketLineId, String(index)),
    ticketId: line.ticketId,
    ticketLineId: line.ticketLineId,
    accountId: line.accountId,
    gameId: line.gameId,
    drawingId: line.drawingId,
    wagerTypeId: line.wagerTypeId,
    wagerOptionId: line.wagerOptionId,
    stake,
    payout,
    netAmount,
    outcome: netAmount > 0 ? "win" : netAmount === 0 ? "push" : "loss",
    status: "settled",
    version: 1,
    previousSettlementRecordId: null,
    reversalOfSettlementRecordId: null,
    ledgerTransactionIds: [],
    recordHash: null,
    previousHash: null,
    hashVersion: "settlement-service-dry-run-v1",
    createdAt: new Date().toISOString(),
  };
}

async function createRun(run: ReturnType<typeof baseRun>, records: Record<string, unknown>[] = []) {
  return settlementRequest("/v1/settlement/runs", {
    method: "POST",
    body: JSON.stringify({
      ...run,
      records,
    }),
  });
}

async function resumeRun(runId: string, body: Record<string, unknown>) {
  return settlementRequest(`/v1/settlement/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getDiagnostics() {
  return settlementRequest("/v1/settlement/runs/recovery/diagnostics");
}

async function verifyHealth() {
  const result = await settlementRequest("/health/ready");

  assert(result.response.ok, "Settlement Service readiness should pass.", {
    status: result.response.status,
    body: result.body,
  });
  assert(result.body?.capabilities?.durablePersistenceConfigured === true, "Durable persistence marker should be enabled.", {
    body: result.body,
  });
  assert(result.body?.capabilities?.mutationCapabilityEnabled === false, "Production mutation capability must remain disabled.", {
    body: result.body,
  });
  pass("Settlement Service health keeps production mutation disabled");
}

async function createResumeFixture(pool: Pool) {
  const run = baseRun();
  const wallet = await seedWallet(pool);
  const firstTicketId = randomUUID();
  const secondTicketId = randomUUID();
  const firstReservation = await reserveCredit(wallet.account_id, firstTicketId);
  const secondReservation = await reserveCredit(wallet.account_id, secondTicketId);
  const lines: TicketLine[] = [
    {
      ticketId: firstTicketId,
      ticketLineId: randomUUID(),
      accountId: wallet.account_id,
      ledgerWalletId: wallet.wallet_id,
      creditPlayerId: wallet.account_id,
      creditReservationId: firstReservation.reservationId,
      creditSettlementId: randomUUID(),
      creditSettlementBatchId: randomUUID(),
      gameId: run.gameId,
      drawingId: run.drawingId,
      wagerTypeId: "qa-wager-win",
      wagerOptionId: "qa-option-win",
      stake: 100,
      payout: 250,
    },
    {
      ticketId: secondTicketId,
      ticketLineId: randomUUID(),
      accountId: wallet.account_id,
      ledgerWalletId: wallet.wallet_id,
      creditPlayerId: wallet.account_id,
      creditReservationId: secondReservation.reservationId,
      creditSettlementId: randomUUID(),
      creditSettlementBatchId: randomUUID(),
      gameId: run.gameId,
      drawingId: run.drawingId,
      wagerTypeId: "qa-wager-win",
      wagerOptionId: "qa-option-win",
      stake: 100,
      payout: 250,
    },
  ];

  return { run, lines };
}

async function verifyResumeCompletesPartialExecution(pool: Pool) {
  const { run, lines } = await createResumeFixture(pool);
  const created = await createRun(run, [createRecord(run, lines[0], 0)]);

  assert(created.response.ok, "Partial settlement run setup should persist.", {
    status: created.response.status,
    body: created.body,
  });
  pass("simulate partial execution", { runId: run.id });

  const resumed = await resumeRun(run.id, {
    executionId: `qa-resume-${run.id}`,
    integrationDryRun: true,
    ticketLines: lines,
  });

  assert(resumed.response.ok, "Resume should complete partial run.", {
    status: resumed.response.status,
    body: resumed.body,
  });
  assert(resumed.body?.records?.length === 2, "Resume should return both records.", {
    body: resumed.body,
  });
  assert(resumed.body?.ledgerEffects?.length === 2, "Resume should return both ledger effects.", {
    body: resumed.body,
  });
  assert(resumed.body?.diagnostics?.missingRecordCount === 0, "Resume should complete missing records.", {
    diagnostics: resumed.body?.diagnostics,
  });
  assert(resumed.body?.diagnostics?.missingLedgerEffectCount === 0, "Resume should complete missing effects.", {
    diagnostics: resumed.body?.diagnostics,
  });
  assert(resumed.body?.externalReferences?.filter((reference: { referenceType: string }) => reference.referenceType === "ledger_entry").length === 2, "Resume should post both ledger references idempotently.", {
    externalReferences: resumed.body?.externalReferences,
  });
  assert(resumed.body?.externalReferences?.filter((reference: { referenceType: string }) => reference.referenceType === "credit_settlement_application").length === 2, "Resume should apply both credit settlements idempotently.", {
    externalReferences: resumed.body?.externalReferences,
  });
  pass("resume completes missing records/effects", { runId: run.id });

  const duplicate = await resumeRun(run.id, {
    executionId: `qa-resume-${run.id}`,
    integrationDryRun: true,
    ticketLines: lines,
  });

  assert(duplicate.response.ok, "Duplicate resume should succeed idempotently.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  assert(duplicate.body?.resumeNoOp === true, "Completed run resume should be an explicit no-op.", {
    body: duplicate.body,
  });
  assert(duplicate.body?.records?.length === 2, "Duplicate resume must not duplicate records.", {
    body: duplicate.body,
  });
  assert(duplicate.body?.ledgerEffects?.length === 2, "Duplicate resume must not duplicate ledger effects.", {
    body: duplicate.body,
  });
  pass("duplicate resume is idempotent", { runId: run.id });
  pass("completed run resume is no-op/idempotent", { runId: run.id });
}

async function verifyDependencyUnavailableFailsClosed(pool: Pool) {
  const { run, lines } = await createResumeFixture(pool);
  const created = await createRun(run);

  assert(created.response.ok, "Dependency failure run setup should persist.", {
    status: created.response.status,
    body: created.body,
  });

  const failed = await resumeRun(run.id, {
    integrationDryRun: true,
    ticketLines: [
      {
        ...lines[0],
        ledgerWalletId: randomUUID(),
      },
    ],
  });

  assert(failed.response.status === 503, "Dependency unavailable/rejected during resume should fail closed.", {
    status: failed.response.status,
    body: failed.body,
  });

  const diagnostics = await getDiagnostics();
  assert(diagnostics.response.ok, "Recovery diagnostics should be queryable after failed resume.", {
    status: diagnostics.response.status,
    body: diagnostics.body,
  });
  const failedRun = diagnostics.body?.failedRuns?.find((candidate: { runId: string }) => candidate.runId === run.id);
  assert(Boolean(failedRun), "Recovery diagnostics should include failed run.", {
    body: diagnostics.body,
  });
  assert(Boolean(failedRun?.lastFailureReason), "Recovery diagnostics should expose last failure reason when available.", {
    failedRun,
  });
  pass("dependency unavailable during resume fails closed", { runId: run.id });
}

async function verifyRecoveryDiagnostics(pool: Pool) {
  const { run, lines } = await createResumeFixture(pool);
  const created = await createRun(run, [createRecord(run, lines[0], 0)]);
  assert(created.response.ok, "Partial diagnostics run setup should persist.", {
    status: created.response.status,
    body: created.body,
  });

  const diagnostics = await getDiagnostics();
  assert(diagnostics.response.ok, "Recovery diagnostics should be reachable.", {
    status: diagnostics.response.status,
    body: diagnostics.body,
  });
  const partial = diagnostics.body?.partiallyIntegratedRuns?.find((candidate: { runId: string }) => candidate.runId === run.id);
  assert(Boolean(partial), "Diagnostics should identify partially integrated runs.", {
    body: diagnostics.body,
  });
  pass("recovery diagnostics report incomplete/failed/partially integrated state", { runId: run.id });
}

function verifySettlementAuthorityRemainsMonolith() {
  const authority = String(process.env.SETTLEMENT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "SETTLEMENT_AUTHORITY must not be SERVICE in recovery/resume QA.", {
    authority,
  });

  const guardrail = evaluateFinancialAuthorityGuardrail({
    config: {
      domain: "SETTLEMENT",
      authority: "MONOLITH",
      comparisonMode: "ENABLED",
      mismatchAlertThreshold: 0.001,
      serviceUrl: settlementServiceUrl,
    },
    serviceReachable: true,
    readinessHealthy: true,
    mutationCapabilityEnabled: false,
    durablePersistenceConfigured: true,
    idempotencySupportConfigured: true,
    qaCapabilityMarkerPresent: true,
  });

  assert(guardrail.productionStatus === "MONOLITH_ALLOWED", "Settlement guardrail should keep MONOLITH allowed.", {
    guardrail,
  });
  assert(!guardrail.productionReady, "Settlement Service recovery/resume must not report production-ready authority.", {
    guardrail,
  });
  pass("guardrails keep SETTLEMENT MONOLITH");
}

async function main() {
  await verifyHealth();
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyResumeCompletesPartialExecution(pool);
    await verifyDependencyUnavailableFailsClosed(pool);
    await verifyRecoveryDiagnostics(pool);
  } finally {
    await pool.end();
  }

  verifySettlementAuthorityRemainsMonolith();

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Settlement Service recovery/resume QA failed.");
});
