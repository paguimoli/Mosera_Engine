import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { seedSettlementFixture, sha256 } from "./lib/credit-wallet-settlement-fixture";

type Check = { name: string; status: "PASS" };
type Scope = {
  organizationId: string;
  tenantId: string;
  brandId: string;
  playerId: string;
  walletId: string;
  ticketId: string;
};

const checks: Check[] = [];
const creditUrl = (process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300").replace(/\/$/, "");
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://localhost:5200").replace(/\/$/, "");
const apiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";
const cleanRehearsal = process.env.CREDIT_WALLET_CLEAN_REHEARSAL === "true";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) fail(message, metadata);
}
function pass(name: string) { checks.push({ name, status: "PASS" }); }
async function json(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function seedScope(pool: Pool): Promise<Scope> {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const playerId = randomUUID();
  const ticketId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await pool.query(
    `insert into platform.organizations(id, organization_code, name, status, version, content_hash)
     values ($1,$2,$3,'Active','1.0.0',$4)`,
    [organizationId, `qa-settle-org-${suffix}`, `QA Settle Org ${suffix}`, sha256(`org:${suffix}`)]
  );
  await pool.query(
    `insert into platform.tenants(id, organization_id, tenant_code, name, status,
       default_language, default_currency, default_timezone, credit_enabled,
       cashier_enabled, version, content_hash)
     values ($1,$2,$3,$4,'Active','en','USD','UTC',true,false,'1.0.0',$5)`,
    [tenantId, organizationId, `qa-settle-tenant-${suffix}`,
      `QA Settle Tenant ${suffix}`, sha256(`tenant:${suffix}`)]
  );
  await pool.query(
    `insert into platform.brands(id, tenant_id, brand_code, name, display_name,
       status, version, content_hash)
     values ($1,$2,$3,$3,$3,'Active','1.0.0',$4)`,
    [brandId, tenantId, `qa-settle-brand-${suffix}`, sha256(`brand:${suffix}`)]
  );
  await pool.query(
    `insert into public.accounts(id, account_type, account_code, display_name, status)
     values ($1,'PLAYER',$2,$3,'ACTIVE')`,
    [playerId, `qa-settle-player-${suffix}`, `QA Settle Player ${suffix}`]
  );
  const wallet = await pool.query<{ id: string }>(
    `insert into public.financial_wallets(account_id, wallet_type, currency_code,
       balance_authority, status, balance, credit_limit, funding_model)
     values ($1,'CREDIT','USD','INTERNAL','ACTIVE',100,2000,'CREDIT') returning id::text`,
    [playerId]
  );
  const walletId = wallet.rows[0].id;
  await pool.query(
    `insert into credit_wallet_service.wallet_scopes(
       wallet_id, tenant_id, brand_id, player_id, instrument_code, currency, authority)
     values ($1,$2,$3,$4,'CREDIT','USD','CREDIT_WALLET_SERVICE')`,
    [walletId, tenantId, brandId, playerId]
  );
  return { organizationId, tenantId, brandId, playerId, walletId, ticketId };
}

async function operation(body: Record<string, unknown>, key = `qa-wallet-settle-${randomUUID()}`,
  serviceName = "settlement-service") {
  const response = await fetch(`${creditUrl}/v1/credit-wallets/internal/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-internal-service-name": serviceName,
      authorization: `Bearer ${apiKey}`,
      "x-correlation-id": `qa-wallet-settle-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await json(response), key };
}

function baseOperation(scope: Scope, type: string, amount: number) {
  return {
    requestId: randomUUID(), tenantId: scope.tenantId, brandId: scope.brandId,
    playerId: scope.playerId, walletId: scope.walletId, instrument: "CREDIT",
    operation: type, money: { amount, currency: "USD" }, balanceImpact: null,
    authority: type === "RESERVE" ? "WAGER_AUTHORITY" : "settlement-service",
    effectiveAt: "2026-07-17T00:00:00Z", ticketId: scope.ticketId,
    reservationId: null, settlementId: null, settlementBatchId: null,
    settlementInstructionId: null, settlementInstructionSequence: null,
    settlementInstructionHash: null, settlementVersion: null, settlementHash: null,
    settlementOutcome: null, ledgerInstructionId: null,
    ledgerPostingRequired: null, originalOperationId: null,
    correctsOperationId: null, reasonCode: null,
    sourceService: type === "RESERVE" ? "app" : "settlement-service",
    auditMetadata: { qa: "credit-wallet-settlement-authority" },
  };
}

async function reserve(scope: Scope, amount: number) {
  const result = await operation(baseOperation(scope, "RESERVE", amount), undefined, "app");
  assert(result.response.ok && result.body?.status === "COMMITTED", "Reservation must commit.", { result });
  return result.body.effectReferenceId as string;
}

function settlementBody(scope: Scope, reservationId: string,
  fixture: Awaited<ReturnType<typeof seedSettlementFixture>>, operationType: "SETTLE" | "REVERSE",
  amount: number, impact: number, links: { original?: string; corrects?: string } = {}) {
  return {
    ...baseOperation(scope, operationType, amount),
    reservationId,
    balanceImpact: { amount: impact, currency: "USD" },
    settlementId: fixture.settlementId,
    settlementBatchId: randomUUID(),
    settlementInstructionId: fixture.creditInstructionId,
    settlementInstructionSequence: 2,
    settlementInstructionHash: fixture.creditInstructionHash,
    settlementVersion: fixture.settlementVersion,
    settlementHash: fixture.settlementHash,
    settlementOutcome: "WIN",
    ledgerInstructionId: fixture.ledgerInstructionId,
    ledgerPostingRequired: true,
    originalOperationId: links.original ?? null,
    correctsOperationId: links.corrects ?? null,
    reasonCode: operationType === "REVERSE" ? "QA_GOVERNED_CORRECTION" : "QA_SETTLEMENT",
  };
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  )).replaceAll("+", "\\u002B");
}
function dotnetTimestamp(value: string) {
  return new Date(value).toISOString().replace("Z", "0000+00:00");
}

async function completeLedger(scope: Scope,
  fixture: Awaited<ReturnType<typeof seedSettlementFixture>>,
  amount: number, direction: "CREDIT" | "DEBIT") {
  const idempotencyKey = `qa-settlement-ledger-${fixture.ledgerInstructionId}`;
  const effectiveAt = "2026-07-17T00:01:00.000Z";
  const transactionType = direction === "CREDIT" ? "SETTLEMENT_CREDIT" : "SETTLEMENT_DEBIT";
  const material = {
    amountMinor: amount, currency: "USD", direction,
    effectiveAt: dotnetTimestamp(effectiveAt), idempotencyKey,
    instructionHash: fixture.ledgerInstructionHash,
    instructionId: fixture.ledgerInstructionId,
    instructionType: direction === "CREDIT" ? "LEDGER_PAYOUT" : "LEDGER_REVERSAL",
    ledgerAccountId: scope.playerId, ledgerWalletId: scope.walletId,
    minorUnitPrecision: 2, originatingAuthority: "settlement-service",
    referenceId: fixture.settlementId, referenceType: "settlement_record",
    reversalOfLedgerEntryId: null, settlementRecordId: fixture.settlementId,
    transactionType,
  };
  const response = await fetch(`${ledgerUrl}/v1/ledger/entries`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey,
      "x-correlation-id": `qa-settlement-ledger-${randomUUID()}` },
    body: JSON.stringify({
      walletId: scope.walletId, ledgerAccountId: scope.playerId,
      instructionId: fixture.ledgerInstructionId,
      instructionType: material.instructionType,
      instructionHash: fixture.ledgerInstructionHash,
      originatingAuthority: "settlement-service",
      settlementRecordId: fixture.settlementId,
      transactionType, direction, money: { amount, currency: "USD" },
      minorUnitPrecision: 2, canonicalRequestHash: sha256(canonicalJson(material)),
      effectiveAt, reference: { type: "settlement_record", id: fixture.settlementId },
      reversalOfLedgerEntryId: null,
      metadata: { qa: "credit-wallet-settlement-authority" },
    }),
  });
  const body = await json(response);
  assert(response.ok && body?.postingRequestId && body?.journalTransactionId,
    "Ledger instruction must complete before Credit Wallet mutation.", { status: response.status, body });
  return body;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const scope = await seedScope(pool);
    const reservationId = await reserve(scope, 100);
    const originalFixture = await seedSettlementFixture(pool, {
      reservationId, ticketId: scope.ticketId, amountMinor: 100,
      balanceImpactMinor: 25, ledgerRequired: true,
    });
    await completeLedger(scope, originalFixture, 25, "CREDIT");
    const originalBody = settlementBody(scope, reservationId, originalFixture, "SETTLE", 100, 25);

    const unauthorized = await operation(originalBody, undefined, "app");
    assert([400, 403].includes(unauthorized.response.status), "Non-Settlement caller must be rejected.", { unauthorized });
    pass("authenticated Settlement service identity required");

    const tampered = await operation({ ...originalBody,
      requestId: randomUUID(), settlementInstructionHash: sha256("tampered") });
    assert(tampered.response.status === 400, "Tampered instruction payload must fail closed.", { tampered });
    const missingSettlement = await operation({ ...originalBody,
      requestId: randomUUID(), settlementId: randomUUID() });
    assert(missingSettlement.response.status === 400, "Missing Settlement reference must fail closed.", { missingSettlement });
    for (const [field, value] of [
      ["tenantId", randomUUID()], ["brandId", randomUUID()],
      ["playerId", randomUUID()], ["walletId", randomUUID()],
      ["instrument", "CASH"],
    ] as const) {
      const mismatch = await operation({ ...originalBody, requestId: randomUUID(), [field]: value });
      assert(mismatch.response.status === 400,
        `Settlement ${field} mismatch must fail closed.`, { field, mismatch });
    }
    const unsupportedInstrument = await operation({ ...originalBody,
      requestId: randomUUID(), instrument: "BONUS" });
    assert(unsupportedInstrument.response.status === 400,
      "Unsupported settlement destination must fail closed.", { unsupportedInstrument });
    pass("tampered, missing, cross-scope, and unsupported destinations rejected");

    const key = `qa-authoritative-settlement-${randomUUID()}`;
    const original = await operation(originalBody, key);
    assert(original.response.ok && original.body?.status === "COMMITTED", "Authenticated settlement must commit.", { original });
    const duplicate = await operation(originalBody, key);
    assert(duplicate.response.ok && duplicate.body?.reused === true &&
      duplicate.body?.operationId === original.body?.operationId,
    "Duplicate authoritative settlement must return its immutable result.", { duplicate });
    const conflict = await operation({ ...originalBody, balanceImpact: { amount: 24, currency: "USD" } }, key);
    assert(conflict.response.status === 409, "Conflicting idempotency payload must fail closed.", { conflict });
    pass("cross-authority provenance and conflict-safe idempotency enforced");

    const persisted = await pool.query(
      `select settlement_authority, authenticated_service, authentication_result,
        ledger_posting_request_id, ledger_journal_id, ledger_entry_id
       from public.credit_settlement_applications where operation_id=$1`,
      [original.body.operationId]
    );
    assert(persisted.rows[0]?.settlement_authority === "settlement-service" &&
      persisted.rows[0]?.authentication_result === "AUTHENTICATED" &&
      persisted.rows[0]?.ledger_posting_request_id && persisted.rows[0]?.ledger_journal_id &&
      persisted.rows[0]?.ledger_entry_id,
    "Committed application must retain Settlement and Ledger references.", { row: persisted.rows[0] });
    pass("durable Settlement and Ledger references retained");

    if (!cleanRehearsal) {
      const missingScope = { ...scope, ticketId: randomUUID() };
      const missingReservation = await reserve(missingScope, 50);
      const missingLedgerFixture = await seedSettlementFixture(pool, {
        reservationId: missingReservation, ticketId: missingScope.ticketId,
        amountMinor: 50, balanceImpactMinor: 10, ledgerRequired: true,
      });
      const missingLedger = await operation(settlementBody(
        missingScope, missingReservation, missingLedgerFixture, "SETTLE", 50, 10));
      assert(missingLedger.response.status === 400,
        "Credit mutation must fail when required Ledger completion is absent.", { missingLedger });
      pass("required Ledger completion fails closed");
    }

    const reversalFixture = await seedSettlementFixture(pool, {
      reservationId, ticketId: scope.ticketId, amountMinor: 100,
      balanceImpactMinor: -25, outcome: "VOID", ledgerRequired: true,
      ledgerInstructionType: "LEDGER_REVERSAL", creditInstructionType: "CREDIT_REFUND",
      provenance: { resettlementRole: "reversal", originalSettlementId: originalFixture.settlementId },
    });
    await completeLedger(scope, reversalFixture, 25, "DEBIT");
    const reversal = await operation(settlementBody(
      scope, reservationId, reversalFixture, "REVERSE", 100, -25,
      { original: original.body.operationId }));
    assert(reversal.response.ok && reversal.body?.status === "COMMITTED",
      "Governed reversal must commit.", { reversal });

    const correctionFixture = await seedSettlementFixture(pool, {
      reservationId, ticketId: scope.ticketId, amountMinor: 100,
      balanceImpactMinor: 15, ledgerRequired: true,
      provenance: { resettlementRole: "corrected", originalSettlementId: originalFixture.settlementId },
    });
    await completeLedger(scope, correctionFixture, 15, "CREDIT");
    const correctionBody = settlementBody(
      scope, reservationId, correctionFixture, "SETTLE", 100, 15,
      { corrects: reversal.body.operationId });
    const correctionKey = `qa-corrected-settlement-${randomUUID()}`;
    const correction = await operation(correctionBody, correctionKey);
    assert(correction.response.ok && correction.body?.status === "COMMITTED",
      "Corrected settlement must commit only after reversal.", { correction });
    const duplicateCorrection = await operation(correctionBody, correctionKey);
    assert(duplicateCorrection.response.ok && duplicateCorrection.body?.reused === true &&
      duplicateCorrection.body?.operationId === correction.body?.operationId,
    "Duplicate corrected settlement must return the immutable correction.", { duplicateCorrection });
    const chain = await pool.query(
      `select operation_type, original_application_id, reversal_of_operation_id,
        correction_of_operation_id from public.credit_settlement_applications
       where operation_id in ($1,$2,$3) order by created_at`,
      [original.body.operationId, reversal.body.operationId, correction.body.operationId]
    );
    assert(chain.rowCount === 3 && chain.rows[1]?.operation_type === "REVERSAL" &&
      chain.rows[1]?.reversal_of_operation_id === original.body.operationId &&
      chain.rows[2]?.correction_of_operation_id === reversal.body.operationId,
    "Correction chain must retain original, reversal, and corrected operations.", { chain: chain.rows });
    pass("reversal and corrected settlement chain is immutable and linked");

    const evidence = await pool.query(
      `select count(*)::int as count from credit_wallet_service.settlement_instruction_authentication_evidence
       where operation_id in ($1,$2,$3)`,
      [original.body.operationId, reversal.body.operationId, correction.body.operationId]
    );
    assert(evidence.rows[0]?.count === 3, "Every committed authority mutation needs authentication evidence.");
    try {
      await pool.query(`update credit_wallet_service.settlement_instruction_authentication_evidence
        set authentication_result=authentication_result where operation_id=$1`, [original.body.operationId]);
      fail("Settlement authentication evidence update must be blocked.");
    } catch { pass("settlement authentication evidence is append-only"); }

    const healthResponse = await fetch(`${creditUrl}/v1/credit-wallets/health`);
    const health = await json(healthResponse);
    assert(healthResponse.ok && health?.canonicalOperations?.settlementIntegration?.authenticatedSettlementReady === true &&
      health?.canonicalOperations?.settlementIntegration?.ledgerCoordinationReady === true &&
      health?.canonicalOperations?.settlementIntegration?.reversalChainsReady === true &&
      health?.canonicalOperations?.settlementIntegration?.productionReady === false,
    "Settlement integration readiness markers must be explicit and remain non-production.", { health });
    pass("readiness reports settlement authority capability without promotion");

    console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
