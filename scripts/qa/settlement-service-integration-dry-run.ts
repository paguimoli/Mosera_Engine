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
    fail("DATABASE_URL is required for Settlement Service integration dry-run QA.");
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
      "x-correlation-id": `qa-settlement-service-integration-${randomUUID()}`,
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
      "x-correlation-id": `qa-settlement-credit-${randomUUID()}`,
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
    [accountId, `qa-settlement-int-${suffix}`, `QA Settlement Integration ${suffix}`]
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
        qa: "settlement-service-integration-dry-run",
      },
    },
    `qa-settlement-integration-reserve-${randomUUID()}`
  );

  assert(result.response.ok, "Credit reservation setup should succeed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body;
}

function baseRun() {
  return {
    id: `qa-settlement-integration-run-${randomUUID()}`,
    drawingId: `qa-settlement-integration-drawing-${randomUUID()}`,
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
    notes: "qa:settlement-service-integration-dry-run",
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
  assert(result.body?.capabilities?.idempotencySupportScope === "integrationDryRunOnly", "Integration dry-run scope should be exposed.", {
    body: result.body,
  });
  assert(result.body?.capabilities?.qaCapabilityMarker === "settlement-service-integration-dry-run", "Integration dry-run QA marker should be exposed.", {
    body: result.body,
  });
  pass("Settlement Service health reports integration dry-run markers");
}

async function verifyIntegrationDryRun(pool: Pool) {
  const wallet = await seedWallet(pool);
  const ticketId = randomUUID();
  const reservation = await reserveCredit(wallet.account_id, ticketId);
  const run = baseRun();
  const created = await createRun(run);

  assert(created.response.ok, "Create run should persist before integration dry run.", {
    status: created.response.status,
    body: created.body,
  });

  const executionBody = {
    executionId: `qa-integration-${run.id}`,
    integrationDryRun: true,
    ticketLines: [
      {
        ticketId,
        ticketLineId: randomUUID(),
        accountId: wallet.account_id,
        ledgerWalletId: wallet.wallet_id,
        creditPlayerId: wallet.account_id,
        creditReservationId: reservation.reservationId,
        creditSettlementId: randomUUID(),
        creditSettlementBatchId: randomUUID(),
        gameId: run.gameId,
        drawingId: run.drawingId,
        wagerTypeId: "qa-wager-win",
        wagerOptionId: "qa-option-win",
        stake: 100,
        payout: 250,
      },
    ],
  };

  const executed = await executeRun(run.id, executionBody);
  assert(executed.response.ok, "Integration dry run should execute.", {
    status: executed.response.status,
    body: executed.body,
  });
  assert(executed.body?.integrationDryRunExecuted === true, "Integration dry run flag should be true.", {
    body: executed.body,
  });
  assert(executed.body?.authoritativeLedgerPosted === false, "Settlement authority must not post authoritative ledger entries.", {
    body: executed.body,
  });
  assert(Array.isArray(executed.body?.externalReferences), "External references should be returned.", {
    body: executed.body,
  });

  const ledgerReference = executed.body.externalReferences.find(
    (reference: { referenceType: string }) => reference.referenceType === "ledger_entry"
  );
  const creditReference = executed.body.externalReferences.find(
    (reference: { referenceType: string }) => reference.referenceType === "credit_settlement_application"
  );
  assert(Boolean(ledgerReference?.referenceId), "Ledger Service should return a ledger entry reference.", {
    externalReferences: executed.body.externalReferences,
  });
  assert(Boolean(creditReference?.referenceId), "Credit Wallet Service should return a settlement application reference.", {
    externalReferences: executed.body.externalReferences,
  });
  pass("Ledger Service receives/returns idempotent effects", { ledgerEntryId: ledgerReference.referenceId });
  pass("Credit Wallet settle succeeds where reservation exists", { settlementApplicationId: creditReference.referenceId });

  const duplicate = await executeRun(run.id, executionBody);
  assert(duplicate.response.ok, "Duplicate integration dry run should be idempotent.", {
    status: duplicate.response.status,
    body: duplicate.body,
  });
  const duplicateLedgerReference = duplicate.body.externalReferences.find(
    (reference: { referenceType: string }) => reference.referenceType === "ledger_entry"
  );
  const duplicateCreditReference = duplicate.body.externalReferences.find(
    (reference: { referenceType: string }) => reference.referenceType === "credit_settlement_application"
  );
  assert(duplicateLedgerReference?.referenceId === ledgerReference.referenceId, "Duplicate execute must not double-post ledger.", {
    first: ledgerReference,
    duplicate: duplicateLedgerReference,
  });
  assert(duplicateCreditReference?.referenceId === creditReference.referenceId, "Duplicate execute must not double-apply credit settlement.", {
    first: creditReference,
    duplicate: duplicateCreditReference,
  });
  pass("duplicate execute does not double-post");
}

async function verifyDependencyFailureFailsClosed(pool: Pool) {
  const wallet = await seedWallet(pool);
  const run = baseRun();
  const created = await createRun(run);
  assert(created.response.ok, "Create run for dependency failure check should persist.", {
    status: created.response.status,
    body: created.body,
  });

  const failed = await executeRun(run.id, {
    integrationDryRun: true,
    ticketLines: [
      {
        ticketId: randomUUID(),
        ticketLineId: randomUUID(),
        accountId: wallet.account_id,
        ledgerWalletId: randomUUID(),
        gameId: run.gameId,
        drawingId: run.drawingId,
        wagerTypeId: "qa-wager-win",
        wagerOptionId: "qa-option-win",
        stake: 100,
        payout: 250,
      },
    ],
  });

  assert(failed.response.status === 503, "Unavailable/rejected dependency should fail closed.", {
    status: failed.response.status,
    body: failed.body,
  });
  pass("unavailable dependency fails closed");
}

function verifySettlementAuthorityRemainsMonolith() {
  const authority = String(process.env.SETTLEMENT_AUTHORITY ?? "MONOLITH").toUpperCase();
  assert(authority !== "SERVICE", "SETTLEMENT_AUTHORITY must not be SERVICE in integration dry-run QA.", {
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
  assert(!guardrail.productionReady, "Settlement Service integration dry run must not report production-ready authority.", {
    guardrail,
  });
  pass("guardrails keep SETTLEMENT MONOLITH");
}

async function main() {
  await verifyHealth();
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await verifyIntegrationDryRun(pool);
    await verifyDependencyFailureFailsClosed(pool);
  } finally {
    await pool.end();
  }

  verifySettlementAuthorityRemainsMonolith();

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Settlement Service integration dry-run QA failed.");
});
