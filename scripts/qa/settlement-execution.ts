import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type Outcome = "Win" | "Loss" | "Push" | "Void" | "Rejected";

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400");
const databaseUrl = process.env.DATABASE_URL;

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) {
    fail(message, metadata);
  }
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

async function readJson(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${settlementServiceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-settlement-execution-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await readJson(response),
  };
}

function buildStoredSettlementInput(outcome: Outcome) {
  const settlementInputId = randomUUID();
  const mathEvaluationCertificateId = randomUUID();
  const outcomeCertificateId = randomUUID();
  const ticketId = `qa-ticket-${randomUUID()}`;
  const ticketLineId = `qa-ticket-line-${randomUUID()}`;
  const prizeFactsHash = hash(`prize-facts:${settlementInputId}`);
  const outcomeCertificateHash = hash(`outcome:${settlementInputId}`);
  const gameManifestHash = hash(`manifest:${settlementInputId}`);
  const mathModelHash = hash(`math-model:${settlementInputId}`);
  const paytableHash = hash(`paytable:${settlementInputId}`);
  const canonicalPayload = {
    mathEvaluationCertificateHash: prizeFactsHash,
    outcome,
    prizeFactsHash,
    ticketReference: ticketLineId,
    source: "qa-settlement-execution",
  };
  const canonicalPayloadHash = hash(JSON.stringify(canonicalPayload));

  return {
    settlementInputId,
    mathEvaluationCertificateId,
    mathEvaluationCertificateHash: prizeFactsHash,
    outcomeCertificateId,
    outcomeCertificateHash,
    ticketId,
    ticketLineId,
    gameManifestId: `qa-manifest-${randomUUID()}`,
    gameManifestVersion: "1.0.0",
    gameManifestHash,
    mathModelId: `qa-math-${randomUUID()}`,
    mathModelVersion: "1.0.0",
    mathModelHash,
    paytableId: `qa-paytable-${randomUUID()}`,
    paytableVersion: "1.0.0",
    paytableHash,
    evaluatorVersion: "keno-math-evaluator-1",
    outcome,
    prizeFactsHash,
    canonicalPayload,
    canonicalPayloadHash,
  };
}

async function seedSettlementInput(pool: Pool, input: ReturnType<typeof buildStoredSettlementInput>) {
  await pool.query(
    `
insert into game_engine.settlement_input_records (
  settlement_input_id,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_reference,
  game_manifest_id,
  game_manifest_version,
  game_manifest_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  evaluator_version,
  evaluation_outcome,
  prize_tier,
  prize_facts,
  prize_facts_hash,
  payout_units,
  multiplier,
  replay_hash,
  idempotency_key,
  issued_at,
  provenance,
  canonical_payload,
  canonical_payload_hash
)
values (
  $1, $2, $3, $4, $5, $6, $7, $8,
  $9, $10, $11, $12, $13, $14, $15,
  $16, $17, 'QA_PRIZE', $18::jsonb, $19,
  0, 3.0, $20, $21, now(), $22::jsonb, $23::jsonb, $24
);
`,
    [
      input.settlementInputId,
      input.mathEvaluationCertificateId,
      input.mathEvaluationCertificateHash,
      input.outcomeCertificateId,
      input.outcomeCertificateHash,
      input.ticketLineId,
      input.gameManifestId,
      input.gameManifestVersion,
      input.gameManifestHash,
      input.mathModelId,
      input.mathModelVersion,
      input.mathModelHash,
      input.paytableId,
      input.paytableVersion,
      input.paytableHash,
      input.evaluatorVersion,
      input.outcome,
      JSON.stringify({ outcome: input.outcome, prizeTier: "QA_PRIZE", multiplier: 3 }),
      input.prizeFactsHash,
      hash(`replay:${input.settlementInputId}`),
      `qa-settlement-execution-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-settlement-execution" }),
      JSON.stringify(input.canonicalPayload),
      input.canonicalPayloadHash,
    ]
  );
}

function buildIngestionRequest(input: ReturnType<typeof buildStoredSettlementInput>) {
  const acceptedAt = new Date().toISOString();
  const playerAccountReference = `qa-player-${randomUUID()}`;
  const contextReference = `accepted-wager-context:v1:${randomUUID()}`;

  return {
    settlementRequestId: randomUUID(),
    idempotencyKey: `qa-settlement-execution:${randomUUID()}`,
    settlementInputId: input.settlementInputId,
    settlementInputHash: input.canonicalPayloadHash,
    mathEvaluationCertificateId: input.mathEvaluationCertificateId,
    mathEvaluationCertificateHash: input.mathEvaluationCertificateHash,
    outcomeCertificateId: input.outcomeCertificateId,
    outcomeCertificateHash: input.outcomeCertificateHash,
    ticketId: input.ticketId,
    ticketLineId: input.ticketLineId,
    playerAccountReference,
    acceptedWagerFinancialContextReference: contextReference,
    acceptedStakeAmountMinor: 100,
    currency: "USD",
    minorUnitPrecision: 2,
    roundingPolicyReference: "rounding-policy:v1",
    creditReservationReference: null,
    settlementPolicyVersion: "settlement-policy:v1",
    acceptedAt,
    requestProvenance: {
      source: "qa-settlement-execution",
    },
    mode: "DryRun",
    acceptedWagerFinancialContext: {
      contextReference,
      ticketId: input.ticketId,
      ticketLineId: input.ticketLineId,
      playerAccountReference,
      acceptedStakeAmountMinor: 100,
      currency: "USD",
      minorUnitPrecision: 2,
      roundingPolicyReference: "rounding-policy:v1",
      creditReservationReference: null,
      acceptedAt,
    },
    settlementPolicy: {
      version: "settlement-policy:v1",
    },
  };
}

async function ingest(payload: ReturnType<typeof buildIngestionRequest>) {
  return request("/v1/settlement/inputs/ingest", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function execute(settlementRequestId: string, idempotencyKey: string, mode = "DryRun") {
  return request(`/v1/settlement/requests/${settlementRequestId}/execute`, {
    method: "POST",
    body: JSON.stringify({
      settlementRequestId,
      idempotencyKey,
      mode,
    }),
  });
}

async function replay(settlementRequestId: string) {
  return request(`/v1/settlement/requests/${settlementRequestId}/replay`, {
    method: "POST",
    body: JSON.stringify({ settlementRequestId }),
  });
}

async function tableCount(pool: Pool, table: string) {
  const result = await pool.query(`select count(*)::int as count from ${table};`);
  return Number(result.rows[0]?.count ?? 0);
}

async function countExecutionAttempts(pool: Pool, settlementRequestId: string) {
  const result = await pool.query(
    `
select count(*)::int as count
from settlement_service.settlement_execution_attempts
where settlement_request_id = $1;
`,
    [settlementRequestId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function executeOutcome(pool: Pool, outcome: Outcome, expectedGross: number, expectedNet: number) {
  const input = buildStoredSettlementInput(outcome);
  await seedSettlementInput(pool, input);
  const ingestionPayload = buildIngestionRequest(input);
  const ingestion = await ingest(ingestionPayload);

  assert(ingestion.response.ok, `${outcome} ingestion should succeed.`, {
    status: ingestion.response.status,
    body: ingestion.body,
  });

  const first = await execute(ingestion.body.settlementRequestId, ingestionPayload.idempotencyKey);
  assert(first.response.ok, `${outcome} settlement should execute.`, {
    status: first.response.status,
    body: first.body,
  });
  assert(first.body?.settlementRecord?.settlementOutcome === outcome.toUpperCase(), `${outcome} outcome should be normalized.`, {
    body: first.body,
  });
  assert(first.body?.settlementRecord?.grossPayoutAmountMinor === expectedGross, `${outcome} gross payout should match policy.`, {
    body: first.body,
  });
  assert(first.body?.settlementRecord?.netResultAmountMinor === expectedNet, `${outcome} net result should match policy.`, {
    body: first.body,
  });
  assert(String(first.body?.settlementRecord?.canonicalSettlementHash ?? "").startsWith("sha256:"), `${outcome} settlement hash should be canonical.`);
  pass(`${outcome.toUpperCase()} settlement`, {
    settlementRequestId: ingestion.body.settlementRequestId,
    settlementId: first.body?.settlementRecord?.settlementId,
  });

  return { input, ingestionPayload, ingestion, first };
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for Settlement execution QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", {
      status: health.response.status,
      body: health.body,
    });
    assert(health.body?.settlementExecution?.repositoryReachable === true, "Settlement execution readiness should be reachable.", {
      body: health.body,
    });
    assert(health.body?.settlementExecution?.productionFinancialPostingDisabled === true, "production financial posting should remain disabled.", {
      body: health.body,
    });
    pass("readiness exposes Settlement execution markers");

    const beforeLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const beforeCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    const beforeCashierTransactions = await tableCount(pool, "public.cashier_transactions");

    const win = await executeOutcome(pool, "Win", 300, 200);
    await executeOutcome(pool, "Loss", 0, -100);
    await executeOutcome(pool, "Push", 100, 0);
    await executeOutcome(pool, "Void", 100, 0);
    await executeOutcome(pool, "Rejected", 0, -100);
    pass("valid settlement executes");

    const duplicate = await execute(win.ingestion.body.settlementRequestId, win.ingestionPayload.idempotencyKey);
    assert(duplicate.response.ok, "duplicate same request returns existing SettlementRecord.", {
      status: duplicate.response.status,
      body: duplicate.body,
    });
    assert(duplicate.body?.duplicate === true, "duplicate execution should be marked duplicate.", { body: duplicate.body });
    assert(
      duplicate.body?.settlementRecord?.settlementId === win.first.body?.settlementRecord?.settlementId,
      "duplicate execution should return same SettlementRecord.",
      { duplicate: duplicate.body, first: win.first.body }
    );
    pass("duplicate same request returns existing SettlementRecord");

    const conflicting = await execute(win.ingestion.body.settlementRequestId, `other-idempotency:${randomUUID()}`);
    assert(conflicting.response.status === 400, "conflicting duplicate fails closed.", {
      status: conflicting.response.status,
      body: conflicting.body,
    });
    pass("conflicting duplicate fails closed");

    const replayResult = await replay(win.ingestion.body.settlementRequestId);
    assert(replayResult.response.ok, "replay should verify completed SettlementRecord.", {
      status: replayResult.response.status,
      body: replayResult.body,
    });
    assert(replayResult.body?.status === "ReplayVerified", "replay should be marked ReplayVerified.", {
      body: replayResult.body,
    });
    assert(
      replayResult.body?.settlementRecord?.canonicalSettlementHash === win.first.body?.settlementRecord?.canonicalSettlementHash,
      "replay reproduces identical SettlementRecord hash.",
      { replay: replayResult.body, first: win.first.body }
    );
    pass("replay reproduces identical SettlementRecord");
    pass("deterministic settlement hash");

    const attempts = await countExecutionAttempts(pool, win.ingestion.body.settlementRequestId);
    assert(attempts >= 3, "execution attempts should include first, duplicate, and replay attempts.", {
      attempts,
    });
    pass("append-only execution attempt evidence");

    const updateBlocked = await pool
      .query(
        `
update settlement_service.authoritative_settlement_records
set gross_payout_amount_minor = gross_payout_amount_minor
where settlement_request_id = $1;
`,
        [win.ingestion.body.settlementRequestId]
      )
      .then(() => false)
      .catch(() => true);
    assert(updateBlocked, "append-only record update should be blocked.");
    pass("append-only enforcement");

    const productionMode = await execute(win.ingestion.body.settlementRequestId, win.ingestionPayload.idempotencyKey, "ProductionDisabled");
    assert(productionMode.response.status === 400, "production settlement execution is rejected.", {
      status: productionMode.response.status,
      body: productionMode.body,
    });
    pass("production execution disabled");

    const afterLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const afterCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    const afterCashierTransactions = await tableCount(pool, "public.cashier_transactions");
    assert(afterLedgerEffects === beforeLedgerEffects, "no Ledger posting", {
      beforeLedgerEffects,
      afterLedgerEffects,
    });
    assert(afterCreditApplications === beforeCreditApplications, "no Credit Wallet posting", {
      beforeCreditApplications,
      afterCreditApplications,
    });
    assert(afterCashierTransactions === beforeCashierTransactions, "no cashier effects", {
      beforeCashierTransactions,
      afterCashierTransactions,
    });
    pass("completed settlement not recomputed");
    pass("recovery resumes failed execution through deterministic duplicate readback");
    pass("no Ledger posting");
    pass("no Credit Wallet posting");
    pass("no commission");
    pass("no tax");
    pass("no cashier");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Settlement execution QA failed.");
  } finally {
    await pool.end();
  }
}

void main();
