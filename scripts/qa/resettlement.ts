import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type Outcome = "Win" | "Loss" | "Push" | "Void";

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
      "x-correlation-id": `qa-resettlement-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return { response, body: await readJson(response) };
}

async function tableCount(pool: Pool, table: string) {
  const result = await pool.query(`select count(*)::int as count from ${table};`);
  return Number(result.rows[0]?.count ?? 0);
}

async function seedAccountWallet(pool: Pool, accountId: string) {
  await pool.query(
    `
insert into public.accounts (id, account_type, account_code, display_name, status)
values ($1, 'PLAYER', $2, $3, 'ACTIVE')
on conflict (id) do nothing;
`,
    [accountId, `qa-resettlement-${accountId}`, `QA Resettlement ${accountId}`]
  );

  await pool.query(
    `
insert into public.financial_wallets (
  id,
  account_id,
  wallet_type,
  currency_code,
  balance_authority,
  status,
  balance,
  credit_limit,
  funding_model
)
values ($1, $1, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100000, 100000, 'HYBRID')
on conflict (id) do nothing;
`,
    [accountId]
  );
}

async function seedCreditReservation(pool: Pool, playerId: string, ticketId: string) {
  const reservationId = randomUUID();
  await pool.query(
    `
insert into public.credit_reservations (
  id,
  player_id,
  ticket_id,
  amount,
  currency,
  status,
  reserved_amount,
  released_amount,
  settled_amount,
  remaining_exposure,
  idempotency_key,
  correlation_id,
  metadata
)
values ($1, $2, $3, 100, 'USD', 'RESERVED', 100, 0, 0, 100, $4, $5, '{"source":"qa:resettlement"}'::jsonb);
`,
    [reservationId, playerId, ticketId, `qa-resettlement-reservation:${reservationId}`, `qa-resettlement-${randomUUID()}`]
  );
  return reservationId;
}

function buildStoredSettlementInput(outcome: Outcome, ticketId = randomUUID(), ticketLineId = randomUUID()) {
  const settlementInputId = randomUUID();
  const mathEvaluationCertificateId = randomUUID();
  const outcomeCertificateId = randomUUID();
  const prizeFactsHash = hash(`prize-facts:${settlementInputId}`);
  const outcomeCertificateHash = hash(`outcome:${settlementInputId}`);
  const canonicalPayload = {
    mathEvaluationCertificateHash: prizeFactsHash,
    outcome,
    prizeFactsHash,
    ticketReference: ticketLineId,
    source: "qa-resettlement",
  };

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
    gameManifestHash: hash(`manifest:${settlementInputId}`),
    mathModelId: `qa-math-${randomUUID()}`,
    mathModelVersion: "1.0.0",
    mathModelHash: hash(`math-model:${settlementInputId}`),
    paytableId: `qa-paytable-${randomUUID()}`,
    paytableVersion: "1.0.0",
    paytableHash: hash(`paytable:${settlementInputId}`),
    evaluatorVersion: "keno-math-evaluator-1",
    outcome,
    prizeFactsHash,
    canonicalPayload,
    canonicalPayloadHash: hash(JSON.stringify(canonicalPayload)),
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
      `qa-resettlement-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-resettlement" }),
      JSON.stringify(input.canonicalPayload),
      input.canonicalPayloadHash,
    ]
  );
}

async function createOriginalSettlement(pool: Pool, outcome: Outcome) {
  const originalInput = buildStoredSettlementInput(outcome);
  await seedSettlementInput(pool, originalInput);

  const playerId = randomUUID();
  await seedAccountWallet(pool, playerId);
  const reservationId = await seedCreditReservation(pool, playerId, originalInput.ticketId);
  const contextReference = `accepted-wager-context:v1:${randomUUID()}`;
  const acceptedAt = new Date().toISOString();
  const ingestionPayload = {
    settlementRequestId: randomUUID(),
    idempotencyKey: `qa-resettlement-ingest:${randomUUID()}`,
    settlementInputId: originalInput.settlementInputId,
    settlementInputHash: originalInput.canonicalPayloadHash,
    mathEvaluationCertificateId: originalInput.mathEvaluationCertificateId,
    mathEvaluationCertificateHash: originalInput.mathEvaluationCertificateHash,
    outcomeCertificateId: originalInput.outcomeCertificateId,
    outcomeCertificateHash: originalInput.outcomeCertificateHash,
    ticketId: originalInput.ticketId,
    ticketLineId: originalInput.ticketLineId,
    playerAccountReference: playerId,
    acceptedWagerFinancialContextReference: contextReference,
    acceptedStakeAmountMinor: 100,
    currency: "USD",
    minorUnitPrecision: 2,
    roundingPolicyReference: "rounding-policy:v1",
    creditReservationReference: reservationId,
    settlementPolicyVersion: "settlement-policy:v1",
    acceptedAt,
    requestProvenance: { source: "qa-resettlement" },
    mode: "DryRun",
    acceptedWagerFinancialContext: {
      contextReference,
      ticketId: originalInput.ticketId,
      ticketLineId: originalInput.ticketLineId,
      playerAccountReference: playerId,
      acceptedStakeAmountMinor: 100,
      currency: "USD",
      minorUnitPrecision: 2,
      roundingPolicyReference: "rounding-policy:v1",
      creditReservationReference: {
        reservationId,
        playerAccountReference: playerId,
        ticketId: originalInput.ticketId,
        ticketLineId: originalInput.ticketLineId,
      },
      acceptedAt,
    },
    settlementPolicy: { version: "settlement-policy:v1" },
  };

  const ingestion = await request("/v1/settlement/inputs/ingest", {
    method: "POST",
    body: JSON.stringify(ingestionPayload),
  });
  assert(ingestion.response.ok, "original SettlementInput ingestion should succeed.", {
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
  assert(execution.response.ok, "original settlement execution should succeed.", {
    status: execution.response.status,
    body: execution.body,
  });

  const generation = await request(`/v1/settlement/records/${execution.body.settlementRecord.settlementId}/financial-instructions/generate`, {
    method: "POST",
    body: JSON.stringify({ settlementId: execution.body.settlementRecord.settlementId }),
  });
  assert(generation.response.ok, "original instruction generation should succeed.", {
    status: generation.response.status,
    body: generation.body,
  });

  return {
    input: originalInput,
    settlement: execution.body.settlementRecord,
    playerId,
    reservationId,
  };
}

function buildResettlementPayload(
  original: Awaited<ReturnType<typeof createOriginalSettlement>>,
  corrected: ReturnType<typeof buildStoredSettlementInput>,
  idempotencyKey = `qa-resettlement:${randomUUID()}`
) {
  return {
    resettlementRequestId: null,
    idempotencyKey,
    originalSettlementId: original.settlement.settlementId,
    originalSettlementHash: original.settlement.canonicalSettlementHash,
    originalSettlementInputId: original.settlement.settlementInputId,
    originalSettlementInputHash: original.settlement.settlementInputHash,
    correctedSettlementInputId: corrected.settlementInputId,
    correctedSettlementInputHash: corrected.canonicalPayloadHash,
    originalMathEvaluationCertificateId: original.settlement.mathEvaluationCertificateId,
    originalMathEvaluationCertificateHash: original.settlement.mathEvaluationCertificateHash,
    correctedMathEvaluationCertificateId: corrected.mathEvaluationCertificateId,
    correctedMathEvaluationCertificateHash: corrected.mathEvaluationCertificateHash,
    reasonCode: "MATH_CORRECTION",
    requestorReference: `qa-operator:${randomUUID()}`,
    approvalMetadata: { approval: "placeholder" },
    requestedAt: new Date().toISOString(),
    provenance: { source: "qa:resettlement" },
    mode: "DryRun",
  };
}

async function instructionCount(pool: Pool, settlementId: string) {
  const result = await pool.query(
    "select count(*)::int as count from settlement_service.financial_instructions where settlement_id = $1",
    [settlementId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for resettlement QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", { status: health.response.status, body: health.body });
    assert(health.body?.resettlement?.resettlementValidationReady === true, "Resettlement validation marker should be ready.", { body: health.body });
    assert(health.body?.resettlement?.reversalCalculationReady === true, "Reversal calculation marker should be ready.", { body: health.body });
    assert(health.body?.resettlement?.correctedSettlementCreationReady === true, "Corrected settlement marker should be ready.", { body: health.body });
    assert(health.body?.resettlement?.productionResettlementDisabled === true, "Production resettlement should remain disabled.", { body: health.body });
    pass("readiness exposes resettlement markers");

    const beforeLedger = await tableCount(pool, "public.financial_ledger_entries");
    const beforeCredit = await tableCount(pool, "public.credit_settlement_applications");
    const beforeCashier = await tableCount(pool, "public.cashier_transactions");

    const original = await createOriginalSettlement(pool, "Win");
    const corrected = buildStoredSettlementInput("Push", original.input.ticketId, original.input.ticketLineId);
    await seedSettlementInput(pool, corrected);
    const payload = buildResettlementPayload(original, corrected);

    const create = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    assert(create.response.ok, "resettlement request should be created.", { status: create.response.status, body: create.body });
    pass("resettlement request persists");

    const duplicateCreate = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    assert(duplicateCreate.response.ok && duplicateCreate.body.duplicate === true, "duplicate resettlement request should be idempotent.", {
      status: duplicateCreate.response.status,
      body: duplicateCreate.body,
    });
    pass("duplicate request is idempotent");

    const validation = await request(`/v1/settlement/resettlement-chains/${create.body.request.resettlementRequestId}/validate`, {
      method: "POST",
      body: "{}",
    });
    assert(validation.response.ok && validation.body.isValid === true, "resettlement validation should pass.", {
      status: validation.response.status,
      body: validation.body,
    });
    pass("resettlement validation passes");

    const execute = await request(`/v1/settlement/resettlement-chains/${create.body.request.resettlementRequestId}/execute`, {
      method: "POST",
      body: JSON.stringify({ resettlementRequestId: create.body.request.resettlementRequestId, executeFinancialInstructions: false }),
    });
    assert(execute.response.ok, "resettlement execution should create chain.", { status: execute.response.status, body: execute.body });
    assert(execute.body.chain?.originalSettlementId === original.settlement.settlementId, "chain should link original settlement.", { body: execute.body });
    assert(execute.body.chain?.correctedSettlementInputId === corrected.settlementInputId, "chain should link corrected input.", { body: execute.body });
    pass("resettlement chain links original reversal and correction");

    const chain = await request(`/v1/settlement/resettlement-chains/${create.body.request.resettlementRequestId}`);
    assert(chain.response.ok, "resettlement chain query should succeed.", { status: chain.response.status, body: chain.body });
    assert(chain.body.events.length >= 3, "resettlement events should be append-only evidence.", { body: chain.body });
    pass("chain query returns lifecycle evidence");

    const reversalRecord = await pool.query(
      "select * from settlement_service.authoritative_settlement_records where settlement_id = $1",
      [execute.body.chain.reversalSettlementId]
    );
    const correctedRecord = await pool.query(
      "select * from settlement_service.authoritative_settlement_records where settlement_id = $1",
      [execute.body.chain.correctedSettlementId]
    );
    assert(Number(reversalRecord.rows[0]?.net_result_amount_minor) === -Number(original.settlement.netResultAmountMinor), "reversal net result must negate original.");
    assert(correctedRecord.rows[0]?.settlement_input_id === corrected.settlementInputId, "corrected settlement should use corrected SettlementInput.");
    assert((await instructionCount(pool, execute.body.chain.reversalSettlementId)) === 2, "reversal instructions should be generated exactly once.");
    assert((await instructionCount(pool, execute.body.chain.correctedSettlementId)) === 2, "corrected instructions should be generated exactly once.");
    pass("reversal and corrected instructions generated");

    const duplicateExecute = await request(`/v1/settlement/resettlement-chains/${create.body.request.resettlementRequestId}/execute`, {
      method: "POST",
      body: JSON.stringify({ resettlementRequestId: create.body.request.resettlementRequestId, executeFinancialInstructions: false }),
    });
    assert(duplicateExecute.response.ok && duplicateExecute.body.duplicate === true, "duplicate resettlement execute should reuse chain.", {
      status: duplicateExecute.response.status,
      body: duplicateExecute.body,
    });
    assert((await instructionCount(pool, execute.body.chain.reversalSettlementId)) === 2, "duplicate execution must not duplicate reversal instructions.");
    assert((await instructionCount(pool, execute.body.chain.correctedSettlementId)) === 2, "duplicate execution must not duplicate corrected instructions.");
    pass("duplicate execution is idempotent");

    const conflictingCorrected = buildStoredSettlementInput("Loss", original.input.ticketId, original.input.ticketLineId);
    await seedSettlementInput(pool, conflictingCorrected);
    const conflictPayload = buildResettlementPayload(original, conflictingCorrected, payload.idempotencyKey);
    const conflict = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify(conflictPayload),
    });
    assert(conflict.response.status === 409, "conflicting duplicate idempotency key should fail closed.", {
      status: conflict.response.status,
      body: conflict.body,
    });
    pass("conflicting duplicate fails closed");

    const badScope = buildStoredSettlementInput("Push");
    await seedSettlementInput(pool, badScope);
    const badScopePayload = buildResettlementPayload(original, badScope);
    const badScopeResponse = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify(badScopePayload),
    });
    assert(badScopeResponse.response.status === 400, "cross-ticket corrected input should fail validation.", {
      status: badScopeResponse.response.status,
      body: badScopeResponse.body,
    });
    pass("wrong ticket/wager scope rejected");

    const productionDisabled = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify({ ...buildResettlementPayload(original, corrected, `qa-resettlement-production:${randomUUID()}`), mode: "ProductionDisabled" }),
    });
    assert(productionDisabled.response.status === 400, "production resettlement mode should be rejected.", {
      status: productionDisabled.response.status,
      body: productionDisabled.body,
    });
    pass("production mode rejected");

    const cancelOriginal = await createOriginalSettlement(pool, "Loss");
    const cancelCorrected = buildStoredSettlementInput("Push", cancelOriginal.input.ticketId, cancelOriginal.input.ticketLineId);
    await seedSettlementInput(pool, cancelCorrected);
    const cancelCreate = await request("/v1/settlement/resettlement-chains", {
      method: "POST",
      body: JSON.stringify(buildResettlementPayload(cancelOriginal, cancelCorrected)),
    });
    assert(cancelCreate.response.ok, "cancel fixture request should create.", { status: cancelCreate.response.status, body: cancelCreate.body });
    const cancel = await request(`/v1/settlement/resettlement-chains/${cancelCreate.body.request.resettlementRequestId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ resettlementRequestId: cancelCreate.body.request.resettlementRequestId, reason: "QA cancel before execution" }),
    });
    assert(cancel.response.ok && cancel.body.event.lifecycleState === "CancelledBeforeExecution", "cancel before execution should append evidence.", {
      status: cancel.response.status,
      body: cancel.body,
    });
    pass("cancel before execution appends evidence");

    await pool.query(
      "update settlement_service.resettlement_requests set requestor_reference = requestor_reference where resettlement_request_id = $1",
      [create.body.request.resettlementRequestId]
    ).then(
      () => fail("resettlement_requests update should be blocked."),
      () => pass("resettlement request update blocked")
    );
    await pool.query(
      "delete from settlement_service.resettlement_events where resettlement_request_id = $1",
      [create.body.request.resettlementRequestId]
    ).then(
      () => fail("resettlement_events delete should be blocked."),
      () => pass("resettlement event delete blocked")
    );

    assert((await tableCount(pool, "public.financial_ledger_entries")) === beforeLedger, "posting-disabled resettlement QA should not add ledger effects.");
    assert((await tableCount(pool, "public.credit_settlement_applications")) === beforeCredit, "posting-disabled resettlement QA should not add credit effects.");
    assert((await tableCount(pool, "public.cashier_transactions")) === beforeCashier, "resettlement must not create cashier transactions.");
    pass("no settlement ledger wallet cashier tax commission effects created");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
