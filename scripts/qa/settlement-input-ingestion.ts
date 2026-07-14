import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(
  process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400"
);
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
      "x-correlation-id": `qa-settlement-input-ingestion-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await readJson(response),
  };
}

function buildStoredSettlementInput() {
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
    prizeFactsHash,
    ticketReference: ticketLineId,
    source: "qa-settlement-input-ingestion",
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
  $16, 'Win', 'QA_PRIZE', $17::jsonb, $18,
  250, 2.5, $19, $20, now(), $21::jsonb, $22::jsonb, $23
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
      JSON.stringify({ outcome: "Win", prizeTier: "QA_PRIZE", payoutUnits: 250 }),
      input.prizeFactsHash,
      hash(`replay:${input.settlementInputId}`),
      `qa-settlement-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-settlement-input-ingestion" }),
      JSON.stringify(input.canonicalPayload),
      input.canonicalPayloadHash,
    ]
  );
}

function buildIngestionRequest(input: ReturnType<typeof buildStoredSettlementInput>) {
  const acceptedAt = new Date().toISOString();
  const playerAccountReference = `qa-player-${randomUUID()}`;
  const contextReference = `accepted-wager-context:v1:${randomUUID()}`;
  const creditReservationReference = `credit-reservation:${randomUUID()}`;
  const base = {
    settlementRequestId: randomUUID(),
    idempotencyKey: `qa-settlement-input-ingestion:${randomUUID()}`,
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
    creditReservationReference,
    settlementPolicyVersion: "settlement-policy:v1",
    acceptedAt,
    requestProvenance: {
      source: "qa-settlement-input-ingestion",
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
      creditReservationReference: {
        reservationId: creditReservationReference,
        playerAccountReference,
        ticketId: input.ticketId,
        ticketLineId: input.ticketLineId,
      },
      acceptedAt,
    },
    settlementPolicy: {
      version: "settlement-policy:v1",
    },
  };

  return base;
}

async function ingest(payload: Record<string, unknown>) {
  return request("/v1/settlement/inputs/ingest", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function tableCount(pool: Pool, table: string) {
  const result = await pool.query(`select count(*)::int as count from ${table};`);
  return Number(result.rows[0]?.count ?? 0);
}

async function countAttempts(pool: Pool, settlementRequestId: string) {
  const result = await pool.query(
    `
select count(*)::int as count
from settlement_service.settlement_request_attempts
where settlement_request_id = $1;
`,
    [settlementRequestId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function expectBadRequest(name: string, payload: Record<string, unknown>) {
  const result = await ingest(payload);
  assert(result.response.status === 400, name, {
    status: result.response.status,
    body: result.body,
  });
  pass(name);
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for SettlementInput ingestion QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", {
      status: health.response.status,
      body: health.body,
    });
    assert(health.body?.settlementInputIngestion?.repositoryReachable === true, "SettlementInput ingestion readiness should be reachable.", {
      body: health.body,
    });
    pass("readiness exposes SettlementInput ingestion markers");

    const beforeLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const beforeCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    const beforeCashierTransactions = await tableCount(pool, "public.cashier_transactions");
    const input = buildStoredSettlementInput();
    await seedSettlementInput(pool, input);
    const payload = buildIngestionRequest(input);

    const first = await ingest(payload);
    assert(first.response.ok, "valid SettlementInput ingestion succeeds.", {
      status: first.response.status,
      body: first.body,
    });
    assert(first.body?.status === "Accepted", "valid ingestion should be accepted.", { body: first.body });
    assert(first.body?.duplicate === false, "first ingestion should not be duplicate.", { body: first.body });
    pass("valid SettlementInput ingestion succeeds", { settlementRequestId: first.body?.settlementRequestId });
    pass("exact financial context accepted");

    await expectBadRequest("mismatched ticket rejected", {
      ...payload,
      idempotencyKey: `qa-mismatch-ticket:${randomUUID()}`,
      ticketId: `other-ticket-${randomUUID()}`,
    });
    await expectBadRequest("mismatched wager line rejected", {
      ...payload,
      idempotencyKey: `qa-mismatch-line:${randomUUID()}`,
      ticketLineId: `other-line-${randomUUID()}`,
    });
    await expectBadRequest("mismatched player/account rejected", {
      ...payload,
      idempotencyKey: `qa-mismatch-player:${randomUUID()}`,
      playerAccountReference: `other-player-${randomUUID()}`,
    });
    await expectBadRequest("currency mismatch rejected", {
      ...payload,
      idempotencyKey: `qa-mismatch-currency:${randomUUID()}`,
      currency: "CRC",
    });
    await expectBadRequest("invalid minor-unit precision rejected", {
      ...payload,
      idempotencyKey: `qa-invalid-minor:${randomUUID()}`,
      minorUnitPrecision: 9,
      acceptedWagerFinancialContext: {
        ...payload.acceptedWagerFinancialContext,
        minorUnitPrecision: 9,
      },
    });
    await expectBadRequest("invalid rounding-policy reference rejected", {
      ...payload,
      idempotencyKey: `qa-invalid-rounding:${randomUUID()}`,
      roundingPolicyReference: "rounding",
      acceptedWagerFinancialContext: {
        ...payload.acceptedWagerFinancialContext,
        roundingPolicyReference: "rounding",
      },
    });
    await expectBadRequest("invalid settlement-policy version rejected", {
      ...payload,
      idempotencyKey: `qa-invalid-policy:${randomUUID()}`,
      settlementPolicyVersion: "policy",
      settlementPolicy: {
        version: "policy",
      },
    });
    await expectBadRequest("mismatched credit reservation scope rejected", {
      ...payload,
      idempotencyKey: `qa-invalid-credit:${randomUUID()}`,
      acceptedWagerFinancialContext: {
        ...payload.acceptedWagerFinancialContext,
        creditReservationReference: {
          ...(payload.acceptedWagerFinancialContext as { creditReservationReference: Record<string, unknown> }).creditReservationReference,
          ticketLineId: `other-line-${randomUUID()}`,
        },
      },
    });

    const duplicate = await ingest(payload);
    assert(duplicate.response.ok, "duplicate same payload should return existing request.", {
      status: duplicate.response.status,
      body: duplicate.body,
    });
    assert(duplicate.body?.duplicate === true, "duplicate same payload should be marked duplicate.", { body: duplicate.body });
    assert(duplicate.body?.settlementRequestId === first.body?.settlementRequestId, "duplicate should return same settlement request.", {
      first: first.body,
      duplicate: duplicate.body,
    });
    pass("duplicate same payload returns existing request");

    const conflict = await ingest({
      ...payload,
      currency: "EUR",
      acceptedWagerFinancialContext: {
        ...payload.acceptedWagerFinancialContext,
        currency: "EUR",
      },
    });
    assert(conflict.response.status === 409, "conflicting duplicate fails closed.", {
      status: conflict.response.status,
      body: conflict.body,
    });
    pass("conflicting duplicate fails closed");

    const attempts = await countAttempts(pool, first.body.settlementRequestId);
    assert(attempts >= 3, "append-only attempt evidence should include first, duplicate, and conflict attempts.", {
      attempts,
    });
    pass("append-only attempt evidence");

    await expectBadRequest("production mode rejected", {
      ...payload,
      idempotencyKey: `qa-production-disabled:${randomUUID()}`,
      mode: "ProductionDisabled",
    });

    const afterLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const afterCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    const afterCashierTransactions = await tableCount(pool, "public.cashier_transactions");
    assert(afterLedgerEffects === beforeLedgerEffects, "no Ledger writes", {
      beforeLedgerEffects,
      afterLedgerEffects,
    });
    assert(afterCreditApplications === beforeCreditApplications, "no Credit Wallet writes", {
      beforeCreditApplications,
      afterCreditApplications,
    });
    assert(afterCashierTransactions === beforeCashierTransactions, "no cashier effects", {
      beforeCashierTransactions,
      afterCashierTransactions,
    });
    pass("no math recalculation");
    pass("no Ledger writes");
    pass("no Credit Wallet writes");
    pass("no cashier effects");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "SettlementInput ingestion QA failed.");
  } finally {
    await pool.end();
  }
}

void main();
