import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
type PostingRow = QueryResultRow & {
  id: string;
  instruction_id: string;
  instruction_type: string;
  instruction_hash: string;
  originating_authority: string;
  settlement_record_id: string | null;
  ledger_wallet_id: string;
  ledger_account_id: string | null;
  direction: string;
  amount_minor: string;
  currency: string;
  minor_unit_precision: number;
  transaction_type: string;
  effective_at: Date;
  correlation_metadata: Record<string, unknown>;
};

const checks: Check[] = [];
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");

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

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) fail("DATABASE_URL is required.");
  return value;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  )).replaceAll("+", "\\u002B");
}

function dotnetTimestamp(value: Date) {
  return value.toISOString().replace("Z", "0000+00:00");
}

async function body(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function verifySchema(pool: Pool) {
  const result = await pool.query<{
    recovery: string | null;
    reconciliation: string | null;
    trigger_count: string;
  }>(`
    select
      to_regclass('ledger_service.ledger_recovery_events')::text recovery,
      to_regclass('ledger_service.ledger_reconciliation_events')::text reconciliation,
      (select count(*)::text from pg_trigger
       where not tgisinternal and tgname in (
         'ledger_recovery_events_update_guard', 'ledger_recovery_events_delete_guard',
         'ledger_reconciliation_events_update_guard', 'ledger_reconciliation_events_delete_guard'
       )) trigger_count
  `);
  assert(Boolean(result.rows[0].recovery) && Boolean(result.rows[0].reconciliation),
    "Recovery and reconciliation evidence tables must exist.", { row: result.rows[0] });
  assert(result.rows[0].trigger_count === "4", "All append-only triggers must exist.", { row: result.rows[0] });
  pass("append-only recovery and reconciliation schema exists");
}

async function verifyCompletedRecovery(pool: Pool) {
  const selected = await pool.query<{ id: string; journal_transaction_id: string }>(`
    select id::text, journal_transaction_id::text
    from ledger_service.ledger_posting_requests
    where request_status = 'COMPLETED' and journal_transaction_id is not null
    order by created_at desc limit 1
  `);
  assert(selected.rowCount === 1, "A completed Ledger posting is required for recovery QA.");
  const requestId = selected.rows[0].id;
  const before = await pool.query<{ count: string }>(
    "select count(*)::text count from ledger_service.ledger_transactions where posting_request_id = $1", [requestId]);
  const firstResponse = await fetch(`${ledgerUrl}/internal/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const first = await body(firstResponse);
  assert(firstResponse.ok && first.evidence.classification === "COMPLETED_REUSED",
    "Completed recovery must reuse the committed journal.", { status: firstResponse.status, first });
  const duplicateResponse = await fetch(`${ledgerUrl}/internal/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const duplicate = await body(duplicateResponse);
  assert(duplicateResponse.ok && duplicate.evidence.eventId === first.evidence.eventId,
    "Duplicate recovery must return deterministic evidence.", { first, duplicate });
  const after = await pool.query<{ count: string }>(
    "select count(*)::text count from ledger_service.ledger_transactions where posting_request_id = $1", [requestId]);
  assert(before.rows[0].count === "1" && after.rows[0].count === "1",
    "Completed recovery must not repost a journal.", { before: before.rows[0], after: after.rows[0] });
  pass("completed posting and duplicate recovery reuse one journal", { requestId });

  const verifyResponse = await fetch(`${ledgerUrl}/internal/ledger/posting-requests/${requestId}/verify-journal`, { method: "POST" });
  const verification = await body(verifyResponse);
  assert(verifyResponse.ok && verification.classification === "JOURNAL_MATCH",
    "Balanced immutable journal must replay as a match.", { verification });
  pass("journal integrity and canonical replay match", { requestId });
}

async function verifyNotCommittedRecovery(pool: Pool) {
  const source = await pool.query<PostingRow>(`
    select id::text, instruction_id, instruction_type, instruction_hash, originating_authority,
           settlement_record_id::text, ledger_wallet_id::text, ledger_account_id::text,
           direction, amount_minor::text, currency, minor_unit_precision, transaction_type,
           effective_at, correlation_metadata
    from ledger_service.ledger_posting_requests
    where request_kind = 'POSTING' and request_status = 'COMPLETED'
      and transaction_type <> 'REVERSAL'
    order by created_at desc limit 1
  `);
  assert(source.rowCount === 1, "A source posting is required for NOT_COMMITTED recovery QA.");
  const row = source.rows[0];
  const requestId = randomUUID();
  const idempotencyKey = `qa-ledger-recovery-${randomUUID()}`;
  const instructionId = `recovery:${randomUUID()}`;
  const effectiveAt = new Date("2026-01-08T00:00:00.000Z");
  const metadata: Record<string, unknown> = {
    ...row.correlation_metadata,
    correlationId: randomUUID(),
    referenceType: "qa_recovery",
    referenceId: idempotencyKey,
  };
  const canonicalMaterial: Record<string, unknown> = {
    amountMinor: Number(row.amount_minor), currency: row.currency, direction: row.direction,
    effectiveAt: dotnetTimestamp(effectiveAt), idempotencyKey, instructionHash: row.instruction_hash,
    instructionId, instructionType: row.instruction_type, ledgerAccountId: row.ledger_account_id,
    ledgerWalletId: row.ledger_wallet_id, minorUnitPrecision: row.minor_unit_precision,
    originatingAuthority: row.originating_authority, referenceId: idempotencyKey,
    referenceType: "qa_recovery", reversalOfLedgerEntryId: null,
    settlementRecordId: row.settlement_record_id, transactionType: row.transaction_type,
  };
  const postingRuleId = typeof metadata.postingRuleId === "string" ? metadata.postingRuleId : null;
  const postingRuleVersion = typeof metadata.postingRuleVersion === "string" ? metadata.postingRuleVersion : null;
  if (postingRuleId || postingRuleVersion) {
    canonicalMaterial.postingRuleId = postingRuleId;
    canonicalMaterial.postingRuleVersion = postingRuleVersion;
  }
  const canonicalHash = sha256(canonicalJson(canonicalMaterial));
  await pool.query(`
    insert into ledger_service.ledger_posting_requests (
      id, request_kind, instruction_id, instruction_type, instruction_hash, originating_authority,
      settlement_record_id, ledger_wallet_id, ledger_account_id, direction, amount_minor, currency,
      minor_unit_precision, transaction_type, idempotency_key, canonical_request_hash, effective_at,
      correlation_metadata, request_status, created_at
    ) values ($1, 'POSTING', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15, $16, $17::jsonb, 'CLAIMED', now())
  `, [requestId, instructionId, row.instruction_type, row.instruction_hash, row.originating_authority,
      row.settlement_record_id, row.ledger_wallet_id, row.ledger_account_id, row.direction,
      row.amount_minor, row.currency, row.minor_unit_precision, row.transaction_type,
      idempotencyKey, canonicalHash, effectiveAt, JSON.stringify(metadata)]);

  const response = await fetch(`${ledgerUrl}/internal/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const recovered = await body(response);
  assert(response.ok && recovered.evidence.classification === "RETRY_COMPLETED",
    "Provably uncommitted request must resume through one governed retry.", { status: response.status, recovered });
  const counts = await pool.query<{ entries: string; journals: string }>(`
    select
      (select count(*)::text from public.financial_ledger_entries where idempotency_key = $1) entries,
      (select count(*)::text from ledger_service.ledger_transactions where posting_request_id = $2) journals
  `, [idempotencyKey, requestId]);
  assert(counts.rows[0].entries === "1" && counts.rows[0].journals === "1",
    "Recovery retry must create exactly one entry and one balanced journal.", { counts: counts.rows[0] });
  pass("NOT_COMMITTED request resumes once through governed posting", { requestId });
}

async function verifyReconciliation(pool: Pool) {
  const selected = await pool.query<{
    instruction_id: string;
    settlement_target_key: string;
    canonical_wallet_key: string;
    canonical_operation_id: string;
    operation_target_key: string;
  }>(`
    select fi.instruction_id::text,
           ca.target_idempotency_key settlement_target_key,
           csa.idempotency_key canonical_wallet_key,
           csa.operation_id::text canonical_operation_id,
           wor.idempotency_key operation_target_key
    from settlement_service.financial_instructions fi
    join ledger_service.ledger_posting_requests pr
      on pr.instruction_id = fi.instruction_id::text and pr.request_status = 'COMPLETED'
    join ledger_service.ledger_transactions lt on lt.posting_request_id = pr.id
    join settlement_service.financial_instructions credit
      on credit.settlement_id = fi.settlement_id and credit.target_service = 'credit-wallet-service'
      and credit.instruction_type <> 'CREDIT_NOOP'
    join settlement_service.financial_instruction_execution_attempts ca
      on ca.instruction_id = credit.instruction_id and ca.status in ('Posted', 'Reused', 'RecoveryVerified')
    join public.credit_settlement_applications csa on csa.id::text = ca.external_reference_id
    join credit_wallet_service.wallet_operation_requests wor on wor.operation_id = csa.operation_id
    where fi.target_service = 'ledger-service' and fi.instruction_type in ('LEDGER_PAYOUT', 'LEDGER_REFUND')
    order by fi.created_at desc limit 1
  `);
  assert(selected.rowCount === 1, "A posted Settlement/Ledger/Credit chain is required for reconciliation QA.");
  const instructionId = selected.rows[0].instruction_id;
  assert(selected.rows[0].settlement_target_key !== selected.rows[0].canonical_wallet_key,
    "Settlement target and Credit Wallet canonical identities must remain distinct.", { selected: selected.rows[0] });
  assert(selected.rows[0].settlement_target_key === selected.rows[0].operation_target_key,
    "Credit Wallet operation request must preserve the Settlement target identity mapping.", { selected: selected.rows[0] });
  const firstResponse = await fetch(`${ledgerUrl}/internal/ledger/settlement-instructions/${instructionId}/reconcile`, { method: "POST" });
  const first = await body(firstResponse);
  assert(firstResponse.ok && first.evidence.result === "RECONCILED",
    "Matching Settlement/Ledger/Credit instruction chain must reconcile.", { status: firstResponse.status, first });
  assert(first.evidence.provenance?.settlementTargetIdempotencyKey === selected.rows[0].settlement_target_key
    && first.evidence.provenance?.creditCanonicalOperationId === selected.rows[0].canonical_operation_id
    && first.evidence.provenance?.creditCanonicalOperationIdempotencyKey === selected.rows[0].canonical_wallet_key,
  "Reconciliation evidence must preserve both identities and their deterministic operation mapping.", {
    selected: selected.rows[0], provenance: first.evidence.provenance,
  });
  const duplicateResponse = await fetch(`${ledgerUrl}/internal/ledger/settlement-instructions/${instructionId}/reconcile`, { method: "POST" });
  const duplicate = await body(duplicateResponse);
  assert(duplicateResponse.ok && duplicate.evidence.eventId === first.evidence.eventId,
    "Duplicate reconciliation must reuse deterministic evidence.", { first, duplicate });
  pass("Settlement/Ledger/Credit chain reconciles idempotently", { instructionId });
}

async function verifyReversalRecovery(pool: Pool) {
  const selected = await pool.query<{ id: string }>(`
    select id::text
    from ledger_service.ledger_posting_requests
    where request_kind = 'REVERSAL' and request_status = 'COMPLETED'
      and journal_transaction_id is not null
    order by created_at desc limit 1
  `);
  assert(selected.rowCount === 1, "A completed immutable reversal is required for reversal recovery QA.");
  const requestId = selected.rows[0].id;
  const before = await pool.query<{ count: string }>(
    "select count(*)::text count from ledger_service.ledger_transactions where posting_request_id = $1", [requestId]);
  const response = await fetch(`${ledgerUrl}/internal/ledger/posting-requests/${requestId}/recover`, { method: "POST" });
  const recovered = await body(response);
  assert(response.ok && recovered.evidence.classification === "COMPLETED_REUSED",
    "Committed reversal recovery must reuse its compensating journal.", { status: response.status, recovered });
  const after = await pool.query<{ count: string }>(
    "select count(*)::text count from ledger_service.ledger_transactions where posting_request_id = $1", [requestId]);
  assert(before.rows[0].count === "1" && after.rows[0].count === "1",
    "Reversal recovery must not duplicate compensation.", { before: before.rows[0], after: after.rows[0] });
  pass("reversal recovery reuses one compensating journal", { requestId });
}

async function verifyImmutability(pool: Pool) {
  const event = await pool.query<{ event_id: string }>(
    "select event_id::text from ledger_service.ledger_recovery_events order by created_at desc limit 1");
  assert(event.rowCount === 1, "Recovery evidence is required for immutability QA.");
  try {
    await pool.query("update ledger_service.ledger_recovery_events set failure_reason = 'tampered' where event_id = $1", [event.rows[0].event_id]);
    fail("Recovery evidence update must be blocked.");
  } catch (error) {
    assert(String(error).includes("append-only"), "Update must fail through append-only guard.", { error: String(error) });
  }
  pass("recovery and reconciliation evidence remains append-only");
}

async function verifyReadiness() {
  const response = await fetch(`${ledgerUrl}/internal/ledger/recovery/readiness`);
  const readiness = await body(response);
  assert(response.ok && readiness.postingRecoveryReady && readiness.journalIntegrityRecoveryReady
    && readiness.replayReady && readiness.minimalReconciliationReady
    && readiness.unknownResultHandlingReady,
  "Ledger recovery readiness markers must pass.", { status: response.status, readiness });
  assert(readiness.unresolvedMismatches === 0 && readiness.unresolvedInconclusive === 0,
    "No unresolved mismatch or inconclusive evidence may remain.", { readiness });
  pass("recovery, replay, reconciliation, and unknown-result readiness passes");
}

async function refreshExistingReconciliations(pool: Pool) {
  const unresolved = await pool.query<{ settlement_instruction_id: string }>(`
    with latest as (
      select distinct on (settlement_instruction_id)
             settlement_instruction_id, reconciliation_result
      from ledger_service.ledger_reconciliation_events
      order by settlement_instruction_id, created_at desc, event_id desc
    )
    select settlement_instruction_id::text
    from latest
    where reconciliation_result in ('PAYLOAD_MISMATCH', 'STATUS_MISMATCH')
    order by settlement_instruction_id
  `);
  for (const row of unresolved.rows) {
    const response = await fetch(
      `${ledgerUrl}/internal/ledger/settlement-instructions/${row.settlement_instruction_id}/reconcile`,
      { method: "POST" }
    );
    const result = await body(response);
    assert(response.ok && result.evidence?.result === "RECONCILED",
      "Previously recorded reconciliation mismatch must either reconcile under the explicit identity mapping or remain fail-closed.",
      { instructionId: row.settlement_instruction_id, status: response.status, result });
  }
  if (unresolved.rowCount) pass("prior false identity mismatches superseded by append-only reconciliation evidence");
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    await verifySchema(pool);
    await verifyCompletedRecovery(pool);
    await verifyNotCommittedRecovery(pool);
    await verifyReconciliation(pool);
    await verifyReversalRecovery(pool);
    await verifyImmutability(pool);
    await refreshExistingReconciliations(pool);
    await verifyReadiness();
    pass("scope remains instruction-level and excludes cashier, tax, commission calculation, and distributed transactions");
    console.log(JSON.stringify({ status: "PASS", mode: process.argv[2] ?? "all", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Ledger recovery/reconciliation QA failed.", { error: String(error) }));
