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

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(
  process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400"
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
    fail("DATABASE_URL is required for Settlement Service resettlement dry-run QA.");
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
      "x-correlation-id": `qa-settlement-resettlement-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
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
    [accountId, `qa-resettlement-${suffix}`, `QA Resettlement ${suffix}`]
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

function baseRun() {
  return {
    id: `qa-settlement-resettlement-original-run-${randomUUID()}`,
    drawingId: `qa-settlement-resettlement-drawing-${randomUUID()}`,
    gameId: `qa-game-${randomUUID()}`,
    status: "running",
    expectedTicketCount: 1,
    expectedLineCount: 1,
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
    notes: "qa:settlement-service-resettlement-dry-run",
    recordHash: null,
    previousHash: null,
    hashVersion: null,
    createdAt: new Date().toISOString(),
  };
}

async function createRun(run: ReturnType<typeof baseRun>) {
  return settlementRequest("/v1/settlement/runs", {
    method: "POST",
    body: JSON.stringify(run),
  });
}

async function executeRun(runId: string, body: Record<string, unknown>) {
  return settlementRequest(`/v1/settlement/runs/${encodeURIComponent(runId)}/execute`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function createResettlement(body: Record<string, unknown>) {
  return settlementRequest("/v1/settlement/resettlements", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function createOriginalSettlement(pool: Pool) {
  const wallet = await seedWallet(pool);
  const run = baseRun();
  const created = await createRun(run);
  assert(created.response.ok, "Original settlement run should be created.", {
    status: created.response.status,
    body: created.body,
  });

  const ticketId = randomUUID();
  const ticketLineId = randomUUID();
  const executed = await executeRun(run.id, {
    executionId: `qa-original-${run.id}`,
    integrationDryRun: true,
    ticketLines: [
      {
        ticketId,
        ticketLineId,
        accountId: wallet.account_id,
        ledgerWalletId: wallet.wallet_id,
        gameId: run.gameId,
        drawingId: run.drawingId,
        wagerTypeId: "qa-wager-win",
        wagerOptionId: "qa-option-win",
        stake: 100,
        payout: 250,
      },
    ],
  });

  assert(executed.response.ok, "Original settlement should execute.", {
    status: executed.response.status,
    body: executed.body,
  });
  assert(executed.body?.records?.length === 1, "Original settlement should create one record.", {
    body: executed.body,
  });
  assert(executed.body?.ledgerEffects?.length === 1, "Original settlement should create one ledger effect.", {
    body: executed.body,
  });
  pass("original settlement then resettlement setup", { runId: run.id });

  return {
    wallet,
    run,
    originalRecord: executed.body.records[0],
    originalEffect: executed.body.ledgerEffects[0],
  };
}

async function verifyResettlementDryRun(pool: Pool) {
  const { wallet, run, originalRecord, originalEffect } = await createOriginalSettlement(pool);
  const body = {
    resettlementId: `qa-resettlement-${run.id}`,
    originalRunId: run.id,
    integrationDryRun: true,
    lines: [
      {
        originalSettlementRecordId: originalRecord.id,
        ledgerWalletId: wallet.wallet_id,
        correctedStake: 100,
        correctedPayout: 0,
        reason: "qa corrected payout to loss",
      },
    ],
  };
  const resettled = await createResettlement(body);

  assert(resettled.response.ok, "Resettlement should execute.", {
    status: resettled.response.status,
    body: resettled.body,
  });
  assert(resettled.body?.authoritativeLedgerPosted === false, "Resettlement must not post authoritative settlement ledger.", {
    body: resettled.body,
  });
  assert(resettled.body?.integrationDryRunExecuted === true, "Resettlement should run in integration dry-run mode.", {
    body: resettled.body,
  });

  const reversalEffect = resettled.body?.reversalEffects?.[0];
  const correctionEffect = resettled.body?.correctionEffects?.[0];
  assert(
    reversalEffect?.direction === "DEBIT" &&
      reversalEffect?.transactionType === "REVERSAL" &&
      Number(reversalEffect?.amount) === Number(originalEffect.amount),
    "Reversal effect should oppose the original ledger effect.",
    { reversalEffect, originalEffect }
  );
  assert(
    correctionEffect?.direction === "NOOP" &&
      Number(correctionEffect?.amount) === 0,
    "Correction effect should be an explicit no-op for zero corrected payout.",
    { correctionEffect }
  );
  pass("reversal effects are opposing", { reversalEffectId: reversalEffect.id });

  const reversalRecord = resettled.body?.reversalRecords?.[0];
  const correctionRecord = resettled.body?.correctionRecords?.[0];
  assert(
    reversalRecord?.reversalOfSettlementRecordId === originalRecord.id &&
      correctionRecord?.reversalOfSettlementRecordId === originalRecord.id &&
      correctionRecord?.previousSettlementRecordId === originalRecord.id,
    "Correction records should link to the original settlement.",
    { reversalRecord, correctionRecord, originalRecord }
  );
  pass("correction records are linked", { correctionRecordId: correctionRecord.id });

  const ledgerReference = resettled.body?.externalReferences?.find(
    (reference: { settlementRecordId: string; referenceType: string }) =>
      reference.settlementRecordId === reversalRecord.id && reference.referenceType === "ledger_entry"
  );
  assert(Boolean(ledgerReference?.referenceId), "Integration dry-run should post reversal to Ledger Service once.", {
    externalReferences: resettled.body?.externalReferences,
  });

  const duplicate = await createResettlement(body);
  assert(duplicate.response.ok, "Duplicate resettlement should be idempotent.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  assert(duplicate.body?.resettlementNoOp === true, "Duplicate resettlement should report no-op.", {
    body: duplicate.body,
  });
  const duplicateLedgerReference = duplicate.body?.externalReferences?.find(
    (reference: { settlementRecordId: string; referenceType: string }) =>
      reference.settlementRecordId === reversalRecord.id && reference.referenceType === "ledger_entry"
  );
  assert(
    duplicateLedgerReference?.referenceId === ledgerReference.referenceId,
    "Duplicate resettlement must not double-post Ledger Service entry.",
    { ledgerReference, duplicateLedgerReference }
  );
  assert(duplicate.body?.reversalEffects?.length === 1 && duplicate.body?.correctionEffects?.length === 1, "Duplicate resettlement must not duplicate effects.", {
    body: duplicate.body,
  });
  pass("duplicate resettlement idempotent");
  pass("integration dry-run does not double-post");
}

async function verifyInvalidOriginalSettlementFailsClosed() {
  const failed = await createResettlement({
    resettlementId: `qa-resettlement-invalid-${randomUUID()}`,
    originalRunId: `missing-run-${randomUUID()}`,
    integrationDryRun: true,
    lines: [
      {
        originalSettlementRecordId: `missing-record-${randomUUID()}`,
        ledgerWalletId: randomUUID(),
        correctedStake: 100,
        correctedPayout: 0,
        reason: "qa invalid original",
      },
    ],
  });

  assert(failed.response.status === 404, "Invalid original settlement should fail closed.", {
    status: failed.response.status,
    body: failed.body,
  });
  pass("invalid original settlement fails closed");
}

function verifySettlementAuthorityRemainsMonolith() {
  const authority = String(process.env.SETTLEMENT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "SETTLEMENT_AUTHORITY must not be SERVICE in resettlement dry-run QA.", {
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
  assert(!guardrail.productionReady, "Settlement Service resettlement dry run must not report production-ready authority.", {
    guardrail,
  });
  pass("guardrails keep SETTLEMENT MONOLITH");
}

async function main() {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyResettlementDryRun(pool);
    await verifyInvalidOriginalSettlementFailsClosed();
  } finally {
    await pool.end();
  }

  verifySettlementAuthorityRemainsMonolith();

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Settlement Service resettlement dry-run QA failed.");
});
