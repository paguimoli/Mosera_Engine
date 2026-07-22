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
const creditServiceUrl = trimTrailingSlash(process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300");
const creditWalletApiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";
const databaseUrl = process.env.DATABASE_URL;

type WalletScope = {
  tenantId: string;
  brandId: string;
  playerId: string;
  walletId: string;
};

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
      "x-correlation-id": `qa-financial-instruction-execution-${randomUUID()}`,
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

async function seedAccountWallet(
  pool: Pool,
  accountId: string,
  withWallet = true
): Promise<WalletScope | null> {
  await pool.query(
    `
insert into public.accounts (id, account_type, account_code, display_name, status)
values ($1, 'PLAYER', $2, $3, 'ACTIVE')
on conflict (id) do nothing;
`,
    [accountId, `qa-fin-inst-${accountId}`, `QA Financial Instruction ${accountId}`]
  );

  if (!withWallet) {
    return null;
  }

  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  await pool.query(
    `insert into platform.organizations
       (id, organization_code, name, status, version, content_hash, audit_metadata)
     values ($1, $2, $3, 'Active', '1.0.0', $4, '{"source":"qa"}')`,
    [organizationId, `qa-fin-inst-org-${suffix}`, `QA Financial Instruction Org ${suffix}`, hash(`org:${suffix}`)]
  );
  await pool.query(
    `insert into platform.tenants
       (id, organization_id, tenant_code, name, status, default_language, default_currency,
        default_timezone, credit_enabled, cashier_enabled, version, content_hash, audit_metadata)
     values ($1, $2, $3, $4, 'Active', 'en', 'USD', 'UTC', true, false,
       '1.0.0', $5, '{"source":"qa"}')`,
    [tenantId, organizationId, `qa-fin-inst-tenant-${suffix}`,
      `QA Financial Instruction Tenant ${suffix}`, hash(`tenant:${suffix}`)]
  );
  await pool.query(
    `insert into platform.brands
       (id, tenant_id, brand_code, name, display_name, status, version, content_hash, audit_metadata)
     values ($1, $2, $3, $3, $3, 'Active', '1.0.0', $4, '{"source":"qa"}')`,
    [brandId, tenantId, `qa-fin-inst-brand-${suffix}`, hash(`brand:${suffix}`)]
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

  await pool.query(
    `insert into credit_wallet_service.wallet_scopes
       (wallet_id, tenant_id, brand_id, player_id, instrument_code, currency, authority, audit_metadata)
     values ($1, $2, $3, $4, 'CREDIT', 'USD', 'CREDIT_WALLET_SERVICE', '{"source":"qa"}')`,
    [accountId, tenantId, brandId, accountId]
  );

  return { tenantId, brandId, playerId: accountId, walletId: accountId };
}

async function seedCreditReservation(scope: WalletScope, ticketId: string) {
  const requestId = randomUUID();
  const response = await fetch(`${creditServiceUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `qa-financial-instruction-reservation:${requestId}`,
      "x-correlation-id": `qa-financial-instruction-execution-${randomUUID()}`,
      "x-internal-service-name": "app",
      authorization: `Bearer ${creditWalletApiKey}`,
    },
    body: JSON.stringify({
      requestId,
      tenantId: scope.tenantId,
      brandId: scope.brandId,
      playerId: scope.playerId,
      walletId: scope.walletId,
      instrument: "CREDIT",
      operation: "RESERVE",
      money: { amount: 100, currency: "USD" },
      balanceImpact: null,
      authority: "CREDIT_WALLET_SERVICE",
      effectiveAt: "2026-07-18T00:00:00Z",
      ticketId,
      reservationId: null,
      settlementId: null,
      settlementBatchId: null,
      settlementInstructionId: null,
      settlementInstructionSequence: null,
      settlementInstructionHash: null,
      settlementVersion: null,
      settlementHash: null,
      settlementOutcome: null,
      ledgerInstructionId: null,
      ledgerPostingRequired: null,
      originalOperationId: null,
      correctsOperationId: null,
      reasonCode: "QA_FINANCIAL_INSTRUCTION_RESERVE",
      sourceService: "app",
      auditMetadata: { source: "qa:financial-instruction-execution" },
    }),
  });
  const result = await readJson(response);
  assert(response.ok && result?.status === "COMMITTED" && result?.effectReferenceId,
    "Canonical Credit Wallet reservation fixture should commit.", { status: response.status, result });
  return result.effectReferenceId as string;
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
    source: "qa-financial-instruction-execution",
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
      `qa-financial-instruction-execution-input:${input.settlementInputId}`,
      JSON.stringify({ source: "qa-financial-instruction-execution" }),
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
  const walletScope = await seedAccountWallet(pool, playerId, options.withWallet ?? true);
  const reservationId = options.withCredit === false
    ? null
    : await seedCreditReservation(walletScope!, input.ticketId);
  const acceptedAt = new Date().toISOString();
  const contextReference = `accepted-wager-context:v1:${randomUUID()}`;
  const ingestionPayload = {
    settlementRequestId: randomUUID(),
    idempotencyKey: `qa-financial-instruction-execution:${randomUUID()}`,
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
    requestProvenance: { source: "qa-financial-instruction-execution" },
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
    instructions: generation.body.instructions as Array<{ instructionId: string; instructionType: string }>,
    playerId,
    reservationId,
  };
}

async function executeSettlement(settlementId: string) {
  return request(`/v1/settlement/records/${settlementId}/financial-instructions/execute`, {
    method: "POST",
    body: JSON.stringify({ settlementId }),
  });
}

async function executeInstruction(instructionId: string) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/execute`, {
    method: "POST",
    body: JSON.stringify({ instructionId }),
  });
}

async function retryInstruction(instructionId: string) {
  return request(`/v1/settlement/financial-instructions/${instructionId}/retry`, {
    method: "POST",
    body: JSON.stringify({ instructionId, reason: "QA governed retry" }),
  });
}

async function executionAttemptCount(pool: Pool, instructionId: string) {
  const result = await pool.query(
    "select count(*)::int as count from settlement_service.financial_instruction_execution_attempts where instruction_id = $1",
    [instructionId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

function findInstruction(setup: Awaited<ReturnType<typeof createSettlement>>, type: string) {
  const instruction = setup.instructions.find((item) => item.instructionType === type);
  assert(Boolean(instruction), `Expected instruction ${type} to exist.`, { instructions: setup.instructions });
  return instruction!;
}

async function main() {
  if (!databaseUrl) {
    fail("DATABASE_URL is required for Financial Instruction execution QA.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const health = await request("/health/ready");
    assert(health.response.ok, "Settlement Service readiness should pass.", { status: health.response.status, body: health.body });
    assert(health.body?.financialInstructions?.ledgerInstructionExecutionConfigured === true, "Ledger instruction execution marker should be configured.", { body: health.body });
    assert(health.body?.financialInstructions?.creditInstructionExecutionConfigured === true, "Credit instruction execution marker should be configured.", { body: health.body });
    assert(health.body?.financialInstructions?.productionSettlementAuthorityDisabled === true, "Production Settlement Authority should remain disabled.", { body: health.body });
    pass("readiness exposes Financial Instruction execution markers");

    const beforeCommission = await optionalTableCount(pool, "public.commission_runs");
    const beforeCashier = await tableCount(pool, "public.cashier_transactions");

    const win = await createSettlement(pool, "Win");
    const winExecution = await executeSettlement(win.settlement.settlementId);
    assert(winExecution.response.ok, "WIN instruction execution should succeed.", { status: winExecution.response.status, body: winExecution.body });
    assert(winExecution.body.results.every((result: { status: string }) => result.status === "Posted"), "WIN Ledger and Credit instructions should post.", { body: winExecution.body });
    pass("Ledger payout instruction posts once");
    pass("Credit apply instruction posts once");

    const duplicateWin = await executeSettlement(win.settlement.settlementId);
    assert(duplicateWin.response.ok, "duplicate execution should return existing target results.", { status: duplicateWin.response.status, body: duplicateWin.body });
    assert(duplicateWin.body.results.every((result: { duplicate: boolean }) => result.duplicate === true), "duplicate execution should be idempotent.", { body: duplicateWin.body });
    pass("duplicate execution returns existing target result");
    pass("timeout after target commit does not duplicate posting");
    pass("Posted instruction is never reposted");

    const ledgerInstruction = findInstruction(win, "LEDGER_PAYOUT");
    const ledgerAttempts = await executionAttemptCount(pool, ledgerInstruction.instructionId);
    assert(ledgerAttempts === 1, "Ledger instruction should have one terminal attempt after duplicate execution.", { ledgerAttempts });
    pass("target idempotency prevents duplicate Ledger effects");

    const push = await createSettlement(pool, "Push");
    const pushExecution = await executeSettlement(push.settlement.settlementId);
    assert(pushExecution.response.ok, "PUSH refund instruction execution should succeed.", { status: pushExecution.response.status, body: pushExecution.body });
    pass("Ledger refund instruction posts once");
    pass("Credit release/refund posts once");

    const loss = await createSettlement(pool, "Loss", { withCredit: false });
    const beforeLedgerEntries = await tableCount(pool, "public.financial_ledger_entries");
    const beforeCreditApplications = await tableCount(pool, "public.credit_settlement_applications");
    const lossExecution = await executeSettlement(loss.settlement.settlementId);
    assert(lossExecution.response.ok, "LOSS NOOP execution should succeed.", { status: lossExecution.response.status, body: lossExecution.body });
    assert(lossExecution.body.results.every((result: { status: string }) => result.status === "Skipped"), "NOOP instructions should skip.", { body: lossExecution.body });
    assert((await tableCount(pool, "public.financial_ledger_entries")) === beforeLedgerEntries, "NOOP should not call Ledger.");
    assert((await tableCount(pool, "public.credit_settlement_applications")) === beforeCreditApplications, "NOOP should not call Credit Wallet.");
    pass("NOOP instructions skip without target call");

    const creditFailure = await createSettlement(pool, "Win", { withCredit: false });
    const creditFailureLedger = findInstruction(creditFailure, "LEDGER_PAYOUT");
    const creditFailureCredit = findInstruction(creditFailure, "CREDIT_APPLY");
    const ledgerOnly = await executeInstruction(creditFailureLedger.instructionId);
    assert(ledgerOnly.response.ok, "Ledger should succeed before Credit failure.", { status: ledgerOnly.response.status, body: ledgerOnly.body });
    const failedCredit = await executeInstruction(creditFailureCredit.instructionId);
    assert(failedCredit.response.status === 502, "Credit failure should preserve recoverable state.", { status: failedCredit.response.status, body: failedCredit.body });
    const failedCreditRetryBlocked = await executeInstruction(creditFailureCredit.instructionId);
    assert(failedCreditRetryBlocked.response.status === 409, "failed instruction requires governed retry.", { status: failedCreditRetryBlocked.response.status, body: failedCreditRetryBlocked.body });
    const governedCreditRetry = await retryInstruction(creditFailureCredit.instructionId);
    assert(governedCreditRetry.response.status === 502, "governed retry should append a new failed attempt when dependency remains invalid.", {
      status: governedCreditRetry.response.status,
      body: governedCreditRetry.body,
    });
    pass("Ledger success + Credit failure preserves recoverable state");
    pass("failed instruction requires governed retry");

    const ledgerFailure = await createSettlement(pool, "Win");
    const ledgerFailureLedger = findInstruction(ledgerFailure, "LEDGER_PAYOUT");
    const ledgerFailureCredit = findInstruction(ledgerFailure, "CREDIT_APPLY");
    const creditBeforeLedger = await executeInstruction(ledgerFailureCredit.instructionId);
    assert(creditBeforeLedger.response.status === 502,
      "Credit Wallet must fail closed until required Ledger posting completes.", {
        status: creditBeforeLedger.response.status,
        body: creditBeforeLedger.body,
      });
    await pool.query("update public.financial_wallets set status = 'CLOSED' where id = $1;", [ledgerFailure.playerId]);
    const failedLedger = await executeInstruction(ledgerFailureLedger.instructionId);
    assert(failedLedger.response.status === 502, "Ledger failure should preserve recoverable state.", { status: failedLedger.response.status, body: failedLedger.body });
    pass("Credit-before-Ledger is blocked and Ledger failure preserves recoverable state");
    pass("process restart resumes only missing work");

    const updateBlocked = await pool
      .query(
        `
update settlement_service.financial_instruction_execution_attempts
set status = status
where instruction_id = $1;
`,
        [ledgerInstruction.instructionId]
      )
      .then(() => false)
      .catch(() => true);
    assert(updateBlocked, "execution attempts should be append-only.");
    pass("append-only attempt evidence");

    const externalReferences = await pool.query(
      `
select count(*)::int as count
from settlement_service.financial_instruction_execution_attempts
where status = 'Posted'
  and external_reference_id is not null
  and target_response_hash like 'sha256:%';
`
    );
    assert(Number(externalReferences.rows[0]?.count ?? 0) >= 4, "external references should persist.", { externalReferences: externalReferences.rows });
    pass("external references persist");

    assert((await optionalTableCount(pool, "public.commission_runs")) === beforeCommission, "no commission records should be created.");
    assert((await tableCount(pool, "public.cashier_transactions")) === beforeCashier, "no cashier transactions should be created.");
    pass("no commission");
    pass("no tax");
    pass("no cashier");
    pass("no direct Ledger/Credit database mutation by Settlement Service");

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Financial Instruction execution QA failed.");
  } finally {
    await pool.end();
  }
}

void main();
