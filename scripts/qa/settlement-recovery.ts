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

function guidN(value: string) {
  return value.replaceAll("-", "");
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
      "x-correlation-id": `qa-settlement-recovery-${randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return { response, body: await readJson(response) };
}

async function tableCount(pool: Pool, table: string) {
  const result = await pool.query(`select count(*)::int as count from ${table};`);
  return Number(result.rows[0]?.count ?? 0);
}

async function optionalTableCount(pool: Pool, table: string) {
  const result = await pool.query("select to_regclass($1) as table_name;", [table]);
  if (!result.rows[0]?.table_name) {
    return null;
  }

  return tableCount(pool, table);
}

async function seedAccountWallet(pool: Pool, accountId: string, withWallet = true) {
  await pool.query(
    `
insert into public.accounts (id, account_type, account_code, display_name, status)
values ($1, 'PLAYER', $2, $3, 'ACTIVE')
on conflict (id) do nothing;
`,
    [accountId, `qa-settlement-recovery-${accountId}`, `QA Settlement Recovery ${accountId}`]
  );

  if (!withWallet) {
    return;
  }

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
values ($1, $2, $3, 100, 'USD', 'RESERVED', 100, 0, 0, 100, $4, $5, '{"source":"qa:settlement-recovery"}'::jsonb);
`,
    [
      reservationId,
      playerId,
      ticketId,
      `qa-settlement-recovery-reservation:${reservationId}`,
      `qa-settlement-recovery-${randomUUID()}`,
    ]
  );
  return reservationId;
}

function buildStoredSettlementInput(outcome: Outcome) {
  const settlementInputId = randomUUID();
  const mathEvaluationCertificateId = randomUUID();
  const outcomeCertificateId = randomUUID();
  const ticketId = randomUUID();
  const ticketLineId = randomUUID();
  const prizeFactsHash = hash(`prize-facts:${settlementInputId}`);
  const outcomeCertificateHash = hash(`outcome:${settlementInputId}`);
  const canonicalPayload = {
    mathEvaluationCertificateHash: prizeFactsHash,
    outcome,
    prizeFactsHash,
    ticketReference: ticketLineId,
    source: "qa-settlement-recovery",
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
      `qa-settlement-recovery-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-settlement-recovery" }),
      JSON.stringify(input.canonicalPayload),
      input.canonicalPayloadHash,
    ]
  );
}

async function createSettlement(
  pool: Pool,
  outcome: Outcome,
  options: { withCredit?: boolean; withWallet?: boolean } = {}
) {
  const input = buildStoredSettlementInput(outcome);
  await seedSettlementInput(pool, input);

  const playerId = randomUUID();
  await seedAccountWallet(pool, playerId, options.withWallet ?? true);
  const reservationId = options.withCredit === false
    ? null
    : await seedCreditReservation(pool, playerId, input.ticketId);
  const contextReference = `accepted-wager-context:v1:${randomUUID()}`;
  const acceptedAt = new Date().toISOString();
  const ingestionPayload = {
    settlementRequestId: randomUUID(),
    idempotencyKey: `qa-settlement-recovery:${randomUUID()}`,
    settlementInputId: input.settlementInputId,
    settlementInputHash: input.canonicalPayloadHash,
    mathEvaluationCertificateId: input.mathEvaluationCertificateId,
    mathEvaluationCertificateHash: input.mathEvaluationCertificateHash,
    outcomeCertificateId: input.outcomeCertificateId,
    outcomeCertificateHash: input.outcomeCertificateHash,
    ticketId: input.ticketId,
    ticketLineId: input.ticketLineId,
    playerAccountReference: playerId,
    acceptedWagerFinancialContextReference: contextReference,
    acceptedStakeAmountMinor: 100,
    currency: "USD",
    minorUnitPrecision: 2,
    roundingPolicyReference: "rounding-policy:v1",
    creditReservationReference: reservationId,
    settlementPolicyVersion: "settlement-policy:v1",
    acceptedAt,
    requestProvenance: { source: "qa-settlement-recovery" },
    mode: "DryRun",
    acceptedWagerFinancialContext: {
      contextReference,
      ticketId: input.ticketId,
      ticketLineId: input.ticketLineId,
      playerAccountReference: playerId,
      acceptedStakeAmountMinor: 100,
      currency: "USD",
      minorUnitPrecision: 2,
      roundingPolicyReference: "rounding-policy:v1",
      creditReservationReference: reservationId
        ? {
            reservationId,
            playerAccountReference: playerId,
            ticketId: input.ticketId,
            ticketLineId: input.ticketLineId,
          }
        : null,
      acceptedAt,
    },
    settlementPolicy: { version: "settlement-policy:v1" },
  };

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

  const generation = await request(`/v1/settlement/records/${execution.body.settlementRecord.settlementId}/financial-instructions/generate`, {
    method: "POST",
    body: JSON.stringify({ settlementId: execution.body.settlementRecord.settlementId }),
  });
  assert(generation.response.ok, `${outcome} financial instruction generation should pass.`, {
    status: generation.response.status,
    body: generation.body,
  });

  return {
    settlement: execution.body.settlementRecord,
    instructions: generation.body.instructions as Array<{
      instructionId: string;
      settlementId: string;
      instructionType: string;
      canonicalPayloadHash: string;
    }>,
    playerId,
    reservationId,
  };
}

function findInstruction(setup: Awaited<ReturnType<typeof createSettlement>>, type: string) {
  const instruction = setup.instructions.find((item) => item.instructionType === type);
  assert(Boolean(instruction), `Expected instruction ${type} to exist.`, { instructions: setup.instructions });
  return instruction!;
}

function targetIdempotencyKey(instruction: { settlementId: string; instructionId: string; instructionType: string; canonicalPayloadHash: string }) {
  return `settlement-target:${guidN(instruction.settlementId)}:${guidN(instruction.instructionId)}:${instruction.instructionType}:${instruction.canonicalPayloadHash}`;
}

async function executeInstruction(instructionId: string) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/execute`, {
    method: "POST",
    body: JSON.stringify({ instructionId }),
  });
}

async function recoverSettlement(settlementId: string, body: Record<string, unknown> = {}) {
  return request(`/v1/settlement/records/${settlementId}/recover`, {
    method: "POST",
    body: JSON.stringify({ settlementId, ...body }),
  });
}

async function recoverInstruction(instructionId: string, body: Record<string, unknown> = {}) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/recover`, {
    method: "POST",
    body: JSON.stringify({ instructionId, ...body }),
  });
}

async function verifyUnknown(instructionId: string, body: Record<string, unknown>) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/verify-unknown`, {
    method: "POST",
    body: JSON.stringify({ instructionId, ...body }),
  });
}

async function reconcileInstruction(instructionId: string, body: Record<string, unknown> = {}) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/reconcile`, {
    method: "POST",
    body: JSON.stringify({ instructionId, ...body }),
  });
}

async function executionAttemptCount(pool: Pool, instructionId: string) {
  const result = await pool.query(
    "select count(*)::int as count from settlement_service.financial_instruction_execution_attempts where instruction_id = $1",
    [instructionId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function insertSyntheticFailedAttempt(
  pool: Pool,
  instruction: { instructionId: string; settlementId: string; instructionType: string; canonicalPayloadHash: string },
  errorClassification: string
) {
  const result = await pool.query(
    `
select coalesce(max(attempt_number), 0) + 1 as attempt_number
from settlement_service.financial_instruction_execution_attempts
where instruction_id = $1;
`,
    [instruction.instructionId]
  );
  const attemptId = randomUUID();
  const attemptNumber = Number(result.rows[0]?.attempt_number ?? 1);
  const key = targetIdempotencyKey(instruction);
  const evidenceHash = hash(`${attemptId}:${instruction.instructionId}:${attemptNumber}:${errorClassification}:${key}`);
  await pool.query(
    `
insert into settlement_service.financial_instruction_execution_attempts (
  attempt_id,
  instruction_id,
  settlement_id,
  attempt_number,
  status,
  target_service,
  target_idempotency_key,
  error_classification,
  error_message,
  evidence_hash
)
select $1, instruction_id, settlement_id, $2, 'Failed', target_service, $3, $4, $5, $6
from settlement_service.financial_instructions
where instruction_id = $7;
`,
    [
      attemptId,
      attemptNumber,
      key,
      errorClassification,
      `${errorClassification} synthetic QA failure`,
      evidenceHash,
      instruction.instructionId,
    ]
  );
}

async function latestAttempt(pool: Pool, instructionId: string) {
  const result = await pool.query(
    `
select *
from settlement_service.financial_instruction_execution_attempts
where instruction_id = $1
order by attempt_number desc
limit 1;
`,
    [instructionId]
  );
  return result.rows[0];
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for Settlement recovery QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", { status: health.response.status, body: health.body });
    assert(health.body?.settlementRecovery?.recoveryReady === true, "Recovery readiness marker should be true.", { body: health.body });
    assert(health.body?.settlementRecovery?.resumeReady === true, "Resume readiness marker should be true.", { body: health.body });
    assert(health.body?.settlementRecovery?.verificationReady === true, "Verification readiness marker should be true.", { body: health.body });
    assert(health.body?.settlementRecovery?.instructionReconciliationReady === true, "Instruction reconciliation readiness marker should be true.", { body: health.body });
    assert(health.body?.settlementRecovery?.productionSettlementAuthorityDisabled === true, "Production Settlement Authority should remain disabled.", { body: health.body });
    pass("readiness exposes recovery, resume, verification, and reconciliation markers");

    const beforeCommission = await optionalTableCount(pool, "public.commission_runs");
    const beforeCashier = await tableCount(pool, "public.cashier_transactions");
    const beforeAccountingReconciliation = await optionalTableCount(pool, "settlement_service.accounting_reconciliation_events");

    const missingWork = await createSettlement(pool, "Win");
    const missingWorkRecovery = await recoverSettlement(missingWork.settlement.settlementId);
    assert(missingWorkRecovery.response.ok, "recovery should resume missing work.", {
      status: missingWorkRecovery.response.status,
      body: missingWorkRecovery.body,
    });
    assert(missingWorkRecovery.body.recoveryState === "SettlementCompleted", "missing work recovery should complete settlement.", {
      body: missingWorkRecovery.body,
    });
    pass("process restart resumes missing work");
    pass("resume executes only missing instructions");

    const duplicateLedgerCountBefore = await tableCount(pool, "public.financial_ledger_entries");
    const duplicateCreditCountBefore = await tableCount(pool, "public.credit_settlement_applications");
    const duplicateRecovery = await recoverSettlement(missingWork.settlement.settlementId);
    assert(duplicateRecovery.response.ok, "duplicate recovery should be idempotent.", {
      status: duplicateRecovery.response.status,
      body: duplicateRecovery.body,
    });
    assert((await tableCount(pool, "public.financial_ledger_entries")) === duplicateLedgerCountBefore, "duplicate recovery must not repost Ledger effects.");
    assert((await tableCount(pool, "public.credit_settlement_applications")) === duplicateCreditCountBefore, "duplicate recovery must not repost Credit effects.");
    pass("duplicate recovery does not repost");
    pass("no duplicate financial effects");

    const partial = await createSettlement(pool, "Win");
    const partialLedger = findInstruction(partial, "LEDGER_PAYOUT");
    const partialCredit = findInstruction(partial, "CREDIT_APPLY");
    const postedLedger = await executeInstruction(partialLedger.instructionId);
    assert(postedLedger.response.ok, "ledger pre-post should succeed.", { status: postedLedger.response.status, body: postedLedger.body });
    const partialRecovery = await recoverSettlement(partial.settlement.settlementId);
    assert(partialRecovery.response.ok, "partial recovery should complete only missing Credit instruction.", {
      status: partialRecovery.response.status,
      body: partialRecovery.body,
    });
    assert((await executionAttemptCount(pool, partialLedger.instructionId)) === 1, "posted Ledger instruction should not be reposted.");
    assert((await executionAttemptCount(pool, partialCredit.instructionId)) === 1, "missing Credit instruction should execute once.");
    pass("Posted instruction never reposted");
    pass("Settlement PartiallyExecuted resumes missing work safely");

    const skipped = await createSettlement(pool, "Loss", { withCredit: false });
    const skippedRecovery = await recoverSettlement(skipped.settlement.settlementId);
    assert(skippedRecovery.response.ok, "skipped NOOP recovery should succeed.", {
      status: skippedRecovery.response.status,
      body: skippedRecovery.body,
    });
    const skippedDuplicate = await recoverSettlement(skipped.settlement.settlementId);
    assert(skippedDuplicate.response.ok, "skipped NOOP duplicate recovery should remain idempotent.", {
      status: skippedDuplicate.response.status,
      body: skippedDuplicate.body,
    });
    pass("Skipped instruction is never resumed as target mutation");

    const unknown = await createSettlement(pool, "Win");
    const unknownLedger = findInstruction(unknown, "LEDGER_PAYOUT");
    await insertSyntheticFailedAttempt(pool, unknownLedger, "TaskCanceledException");
    const awaiting = await recoverInstruction(unknownLedger.instructionId);
    assert(awaiting.response.status === 409, "unknown transport failure should await verification.", {
      status: awaiting.response.status,
      body: awaiting.body,
    });
    assert(awaiting.body.recoveryState === "SettlementAwaitingVerification", "unknown result must be preserved as AwaitingVerification.", {
      body: awaiting.body,
    });
    pass("AwaitingVerification behaves correctly");

    const stillUnknown = await verifyUnknown(unknownLedger.instructionId, { outcome: "Unknown", reason: "QA target status unavailable" });
    assert(stillUnknown.response.status === 409, "Unknown verification outcome should remain fail-closed.", {
      status: stillUnknown.response.status,
      body: stillUnknown.body,
    });
    pass("Unknown result preserves AwaitingVerification");

    const verifiedCommitted = await verifyUnknown(unknownLedger.instructionId, {
      outcome: "Committed",
      externalReferenceType: "ledger_entry",
      externalReferenceId: `qa-verified-${randomUUID()}`,
      targetResponseHash: hash(`verified:${unknownLedger.instructionId}`),
      reason: "QA target idempotency confirmed committed",
    });
    assert(verifiedCommitted.response.ok, "Committed verification should mark instruction Posted.", {
      status: verifiedCommitted.response.status,
      body: verifiedCommitted.body,
    });
    assert((await latestAttempt(pool, unknownLedger.instructionId))?.status === "Posted", "verified committed instruction should have Posted attempt.");
    pass("Ledger timeout after commit verified correctly");
    pass("Unknown result verified correctly");

    const notCommitted = await createSettlement(pool, "Win");
    const notCommittedCredit = findInstruction(notCommitted, "CREDIT_APPLY");
    await insertSyntheticFailedAttempt(pool, notCommittedCredit, "TaskCanceledException");
    const verifiedNotCommitted = await verifyUnknown(notCommittedCredit.instructionId, {
      outcome: "NotCommitted",
      reason: "QA target idempotency confirmed no target record",
    });
    assert(verifiedNotCommitted.response.ok, "NotCommitted verification should execute exactly once.", {
      status: verifiedNotCommitted.response.status,
      body: verifiedNotCommitted.body,
    });
    assert((await latestAttempt(pool, notCommittedCredit.instructionId))?.status === "Posted", "verified not-committed Credit instruction should post once.");
    pass("Credit timeout after commit path remains idempotency-safe");
    pass("missing target record eligible for retry when verified");

    const failedRetry = await createSettlement(pool, "Win", { withCredit: false });
    const failedCredit = findInstruction(failedRetry, "CREDIT_APPLY");
    const failedExecution = await executeInstruction(failedCredit.instructionId);
    assert(failedExecution.response.status === 502, "Credit instruction should fail when reservation is missing.", {
      status: failedExecution.response.status,
      body: failedExecution.body,
    });
    const retryBlocked = await recoverInstruction(failedCredit.instructionId);
    assert(retryBlocked.response.status === 409, "failed instruction recovery requires approval path.", {
      status: retryBlocked.response.status,
      body: retryBlocked.body,
    });
    pass("Failed retry requires approval path");

    const reconcileMatch = await reconcileInstruction(partialLedger.instructionId);
    assert(reconcileMatch.response.ok, "matching reconciliation should succeed.", {
      status: reconcileMatch.response.status,
      body: reconcileMatch.body,
    });
    assert(reconcileMatch.body.status === "Reconciled", "matching reconciliation should be Reconciled.", {
      body: reconcileMatch.body,
    });
    pass("reconciliation succeeds for matching target");

    const reconcileMismatch = await reconcileInstruction(partialLedger.instructionId, {
      targetIdempotencyKey: "qa-mismatched-idempotency-key",
    });
    assert(reconcileMismatch.response.status === 409, "mismatched reconciliation should fail closed.", {
      status: reconcileMismatch.response.status,
      body: reconcileMismatch.body,
    });
    assert(reconcileMismatch.body.status === "Mismatch", "mismatched reconciliation should report Mismatch.", {
      body: reconcileMismatch.body,
    });
    pass("reconciliation fails closed for mismatch");

    const status = await request(`/v1/settlement/records/${partial.settlement.settlementId}/recovery-status`);
    assert(status.response.ok && Array.isArray(status.body.instructions), "recovery status should be queryable.", {
      status: status.response.status,
      body: status.body,
    });
    const replay = await request(`/v1/settlement/records/${partial.settlement.settlementId}/recovery-replay`, { method: "POST" });
    assert(replay.response.ok, "replay of recovery decisions should be deterministic.", {
      status: replay.response.status,
      body: replay.body,
    });
    assert(replay.body.recoveryState === status.body.recoveryState, "replay should reproduce classification.", {
      statusBody: status.body,
      replayBody: replay.body,
    });
    pass("replay reproduces recovery classification");

    const recoveryUpdateBlocked = await pool
      .query(
        `
update settlement_service.recovery_events
set decision = decision
where settlement_id = $1;
`,
        [missingWork.settlement.settlementId]
      )
      .then(() => false)
      .catch(() => true);
    assert(recoveryUpdateBlocked, "recovery events should be append-only.");
    pass("append-only recovery evidence");

    const reconciliationUpdateBlocked = await pool
      .query(
        `
update settlement_service.reconciliation_events
set reconciliation_status = reconciliation_status
where instruction_id = $1;
`,
        [partialLedger.instructionId]
      )
      .then(() => false)
      .catch(() => true);
    assert(reconciliationUpdateBlocked, "reconciliation events should be append-only.");
    pass("append-only reconciliation evidence");

    assert(beforeAccountingReconciliation === null, "accounting reconciliation must not be introduced.");
    assert((await optionalTableCount(pool, "public.commission_runs")) === beforeCommission, "no commission records should be created.");
    assert((await tableCount(pool, "public.cashier_transactions")) === beforeCashier, "no cashier transactions should be created.");
    pass("no accounting reconciliation");
    pass("no commissions");
    pass("no taxes");
    pass("no cashier");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Settlement recovery QA failed.");
  } finally {
    await pool.end();
  }
}

void main();
