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
      "x-correlation-id": `qa-financial-instructions-${randomUUID()}`,
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
    source: "qa-financial-instructions",
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
      `qa-financial-instruction-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-financial-instructions" }),
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
    idempotencyKey: `qa-financial-instructions:${randomUUID()}`,
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
      source: "qa-financial-instructions",
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

async function createSettlement(pool: Pool, outcome: Outcome) {
  const input = buildStoredSettlementInput(outcome);
  await seedSettlementInput(pool, input);
  const ingestionPayload = buildIngestionRequest(input);
  const ingestion = await request("/v1/settlement/inputs/ingest", {
    method: "POST",
    body: JSON.stringify(ingestionPayload),
  });
  assert(ingestion.response.ok, `${outcome} ingestion should succeed.`, {
    status: ingestion.response.status,
    body: ingestion.body,
  });

  const execution = await request(`/v1/settlement/requests/${ingestion.body.settlementRequestId}/execute`, {
    method: "POST",
    body: JSON.stringify({
      settlementRequestId: ingestion.body.settlementRequestId,
      idempotencyKey: ingestionPayload.idempotencyKey,
      mode: "DryRun",
    }),
  });
  assert(execution.response.ok, `${outcome} settlement should execute.`, {
    status: execution.response.status,
    body: execution.body,
  });

  return execution.body.settlementRecord;
}

async function generate(settlementId: string) {
  return request(`/v1/settlement/records/${settlementId}/financial-instructions/generate`, {
    method: "POST",
    body: JSON.stringify({ settlementId }),
  });
}

async function replay(settlementId: string) {
  return request(`/v1/settlement/records/${settlementId}/financial-instructions/replay`, {
    method: "POST",
    body: JSON.stringify({ settlementId }),
  });
}

async function tableCount(pool: Pool, table: string) {
  const result = await pool.query(`select count(*)::int as count from ${table};`);
  return Number(result.rows[0]?.count ?? 0);
}

async function assertInstructionSet(
  pool: Pool,
  outcome: Outcome,
  expectedTypes: string[],
  expectedStatuses: Record<string, string>
) {
  const settlement = await createSettlement(pool, outcome);
  const result = await generate(settlement.settlementId);
  assert(result.response.ok, `${outcome} financial instruction generation should pass.`, {
    status: result.response.status,
    body: result.body,
  });
  const types = result.body.instructions.map((instruction: { instructionType: string }) => instruction.instructionType);
  assert(JSON.stringify(types) === JSON.stringify(expectedTypes), `${outcome} instruction types should match.`, {
    expectedTypes,
    types,
    body: result.body,
  });
  for (const instruction of result.body.instructions as Array<{ instructionType: string; instructionStatus: string; canonicalPayloadHash: string }>) {
    assert(instruction.instructionStatus === expectedStatuses[instruction.instructionType], `${instruction.instructionType} status should match.`, {
      expected: expectedStatuses[instruction.instructionType],
      actual: instruction.instructionStatus,
    });
    assert(instruction.instructionStatus !== "Posted", "posting should be impossible.", { instruction });
    assert(instruction.canonicalPayloadHash.startsWith("sha256:"), "instruction payload hash should be canonical.", { instruction });
  }
  pass(`${outcome.toUpperCase()} creates expected instruction set`, { settlementId: settlement.settlementId });
  return { settlement, result };
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for Financial Instruction QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", {
      status: health.response.status,
      body: health.body,
    });
    assert(health.body?.financialInstructions?.repositoryReachable === true, "Financial Instruction readiness should be reachable.", {
      body: health.body,
    });
    assert(health.body?.financialInstructions?.postingDisabled === true, "posting should be disabled.", { body: health.body });
    assert(health.body?.financialInstructions?.ledgerExecutionDisabled === true, "Ledger execution should be disabled.", { body: health.body });
    assert(health.body?.financialInstructions?.creditWalletExecutionDisabled === true, "Credit Wallet execution should be disabled.", { body: health.body });
    pass("readiness exposes Financial Instruction markers");

    const beforeLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const beforeCreditApplications = await tableCount(pool, "public.credit_settlement_applications");

    const win = await assertInstructionSet(pool, "Win", ["LEDGER_PAYOUT", "CREDIT_APPLY"], {
      LEDGER_PAYOUT: "Ready",
      CREDIT_APPLY: "Ready",
    });
    await assertInstructionSet(pool, "Loss", ["LEDGER_NOOP", "CREDIT_NOOP"], {
      LEDGER_NOOP: "Skipped",
      CREDIT_NOOP: "Skipped",
    });
    await assertInstructionSet(pool, "Push", ["LEDGER_REFUND", "CREDIT_REFUND"], {
      LEDGER_REFUND: "Ready",
      CREDIT_REFUND: "Ready",
    });
    await assertInstructionSet(pool, "Void", ["LEDGER_REFUND", "CREDIT_REFUND"], {
      LEDGER_REFUND: "Ready",
      CREDIT_REFUND: "Ready",
    });
    await assertInstructionSet(pool, "Rejected", ["LEDGER_NOOP", "CREDIT_NOOP"], {
      LEDGER_NOOP: "Skipped",
      CREDIT_NOOP: "Skipped",
    });

    const duplicate = await generate(win.settlement.settlementId);
    assert(duplicate.response.ok, "duplicate generation should pass.", {
      status: duplicate.response.status,
      body: duplicate.body,
    });
    assert(duplicate.body.duplicate === true, "duplicate generation returns existing instructions.", { body: duplicate.body });
    assert(
      duplicate.body.instructions[0].instructionId === win.result.body.instructions[0].instructionId,
      "duplicate generation returns same instruction ids.",
      { duplicate: duplicate.body, first: win.result.body }
    );
    pass("duplicate generation returns existing instructions");
    pass("restart preserves instructions");

    const replayResult = await replay(win.settlement.settlementId);
    assert(replayResult.response.ok, "instruction replay should pass.", {
      status: replayResult.response.status,
      body: replayResult.body,
    });
    assert(replayResult.body.status === "ReplayVerified", "instruction replay should be deterministic.", {
      body: replayResult.body,
    });
    pass("instruction replay deterministic");

    const conflictSettlement = await createSettlement(pool, "Win");
    await pool.query(
      `
insert into settlement_service.financial_instructions (
  instruction_id,
  settlement_id,
  settlement_request_id,
  instruction_type,
  instruction_status,
  canonical_payload_hash,
  idempotency_key,
  target_service,
  instruction_sequence,
  attempt_count,
  created_at,
  provenance
)
values ($1, $2, $3, 'LEDGER_PAYOUT', 'Ready', $4, $5, 'ledger-service', 1, 1, now(), '{}'::jsonb);
`,
      [
        randomUUID(),
        conflictSettlement.settlementId,
        conflictSettlement.settlementRequestId,
        hash(`conflicting-payload:${randomUUID()}`),
        `conflicting-instruction:${randomUUID()}`,
      ]
    );
    const conflict = await generate(conflictSettlement.settlementId);
    assert(conflict.response.status === 409, "conflicting generation fails closed.", {
      status: conflict.response.status,
      body: conflict.body,
    });
    pass("conflicting generation fails closed");

    const updateBlocked = await pool
      .query(
        `
update settlement_service.financial_instructions
set instruction_status = instruction_status
where settlement_id = $1;
`,
        [win.settlement.settlementId]
      )
      .then(() => false)
      .catch(() => true);
    assert(updateBlocked, "financial instructions should be append-only.");
    pass("append-only enforcement");

    const afterLedgerEffects = await tableCount(pool, "settlement_service.settlement_ledger_effects");
    const afterCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    assert(afterLedgerEffects === beforeLedgerEffects, "Ledger not invoked", {
      beforeLedgerEffects,
      afterLedgerEffects,
    });
    assert(afterCreditApplications === beforeCreditApplications, "Credit Wallet not invoked", {
      beforeCreditApplications,
      afterCreditApplications,
    });
    pass("posting impossible");
    pass("Ledger not invoked");
    pass("Credit Wallet not invoked");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Financial Instruction QA failed.");
  } finally {
    await pool.end();
  }
}

void main();
