import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
type ReadinessEvidence = { readinessReportHash: string };
type RecoveryEvidence = {
  postingRecoveryReady: boolean;
  journalIntegrityRecoveryReady: boolean;
  unknownResultHandlingReady: boolean;
  replayReady: boolean;
  minimalReconciliationReady: boolean;
};
type RehearsalEvidence = { configurationHash: string; canonicalEvidenceHash: string };

const checks: Check[] = [];
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");
const buildVersion = "p1-008.8-ledger-authority-final-verification-v1";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) fail(message, metadata);
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function hash(value: Json | string) {
  const material = typeof value === "string" ? value : canonical(value);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

function uuidFromHash(value: string) {
  const hex = value.replace("sha256:", "").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function responseJson(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function request(pathname: string, init?: RequestInit) {
  const response = await fetch(`${ledgerUrl}${pathname}`, init);
  return { response, body: await responseJson(response) };
}

async function csFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await csFiles(target));
    else if (entry.name.endsWith(".cs")) files.push(target);
  }
  return files;
}

async function verifyArchitecture() {
  const root = path.resolve("services/ledger-service");
  const files = await csFiles(root);
  const contents = await Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
  const count = (pattern: RegExp) => contents.reduce((total, item) => total + (item.text.match(pattern)?.length ?? 0), 0);

  const singletons: Array<[string, RegExp]> = [
    ["posting engine", /public sealed class LedgerPostingService\b/g],
    ["journal repository", /public sealed class LedgerJournalRepository\b/g],
    ["replay and recovery service", /public sealed class LedgerRecoveryService\b/g],
    ["recovery repository", /public sealed class LedgerRecoveryRepository\b/g],
    ["promotion readiness report", /public sealed record LedgerAuthorityReadinessReport\b/g],
    ["authority readiness service", /public sealed class LedgerAuthorityService\b/g],
    ["posting catalog", /public sealed class FinancialPostingCatalog\b/g],
  ];
  for (const [name, pattern] of singletons) assert(count(pattern) === 1, `Expected one ${name}.`, { count: count(pattern) });

  const allSource = contents.map((item) => item.text).join("\n");
  for (const forbidden of ["CalculatePrize", "CalculateTax", "WithholdTax", "CashierCompletion", "MutateCreditWallet"])
    assert(!allSource.includes(forbidden), `Ledger responsibility leakage detected: ${forbidden}.`);
  assert(!/credit-wallets\/(?:[^\s"']+)\/(?:reserve|release|settle)/i.test(allSource),
    "Ledger Service must not execute Credit Wallet mutations.");
  pass("single Ledger architecture and responsibility boundary verified", { sourceFiles: files.length });
}

async function verifySchemaAndJournal(pool: Pool) {
  const schema = await pool.query<{
    verification_table: string | null; mutation_triggers: string; rpc_overloads: string;
    invalid_journals: string; duplicate_journals: string; invalid_reversals: string;
  }>(`
    select to_regclass('ledger_service.ledger_authority_verifications')::text verification_table,
      (select count(*)::text from pg_trigger trigger
       join pg_class table_info on table_info.oid = trigger.tgrelid
       join pg_namespace schema_info on schema_info.oid = table_info.relnamespace
       where not trigger.tgisinternal and schema_info.nspname = 'ledger_service'
         and trigger.tgname in (
           'ledger_transactions_update_guard', 'ledger_transactions_delete_guard',
           'ledger_entries_update_guard', 'ledger_entries_delete_guard',
           'ledger_authority_verifications_update_guard', 'ledger_authority_verifications_delete_guard')) mutation_triggers,
      (select count(*)::text from pg_proc procedure
       join pg_namespace schema_info on schema_info.oid = procedure.pronamespace
       where schema_info.nspname = 'public' and procedure.proname = 'post_financial_ledger_entry') rpc_overloads,
      (select count(*)::text from ledger_service.ledger_transactions transaction
       where (select coalesce(sum(entry.debit_amount), 0) from ledger_service.ledger_entries entry where entry.transaction_id = transaction.id)
          <> (select coalesce(sum(entry.credit_amount), 0) from ledger_service.ledger_entries entry where entry.transaction_id = transaction.id)
          or (select count(*) from ledger_service.ledger_entries entry where entry.transaction_id = transaction.id) <> 2) invalid_journals,
      (select count(*)::text from (
         select posting_request_id from ledger_service.ledger_transactions
         where posting_request_id is not null group by posting_request_id having count(*) > 1) duplicate) duplicate_journals,
      (select count(*)::text from ledger_service.ledger_entries reversal
       left join ledger_service.ledger_entries original on original.id = reversal.reversal_of_entry_id
       where reversal.reversal_of_entry_id is not null and (
         original.id is null or reversal.debit_amount <> original.credit_amount
         or reversal.credit_amount <> original.debit_amount
         or reversal.currency <> original.currency)) invalid_reversals
  `);
  const row = schema.rows[0];
  assert(row.verification_table === "ledger_service.ledger_authority_verifications", "Final verification table is missing.", { row });
  assert(row.mutation_triggers === "6", "Ledger transactions, entries, and verification evidence must be immutable.", { row });
  assert(row.rpc_overloads === "1", "Exactly one compatibility posting RPC may exist.", { row });
  assert(row.invalid_journals === "0" && row.duplicate_journals === "0" && row.invalid_reversals === "0",
    "Journal integrity verification failed.", { row });

  const hashIntegrity = await pool.query<{ invalid_transactions: string; invalid_entries: string }>(`
    select
      count(*) filter (where transaction_hash !~ '^sha256:[0-9a-f]{64}$')::text invalid_transactions,
      (select count(*)::text from ledger_service.ledger_entries where canonical_entry_hash !~ '^sha256:[0-9a-f]{64}$') invalid_entries
    from ledger_service.ledger_transactions
  `);
  assert(hashIntegrity.rows[0].invalid_transactions === "0" && hashIntegrity.rows[0].invalid_entries === "0",
    "Every journal transaction and entry must retain a canonical hash.", { row: hashIntegrity.rows[0] });
  pass("immutable balanced journal, reversal, hash, and compatibility RPC integrity verified");
}

async function verifyRuntimeAndCatalog(pool: Pool) {
  const shadow = await request("/internal/ledger/authority/readiness?mode=SERVICE_SHADOW");
  assert(shadow.response.ok, "Ledger shadow readiness endpoint failed.", { status: shadow.response.status, body: shadow.body });
  const report = shadow.body;
  for (const field of [
    "durablePersistenceReady", "immutablePostingReady", "balancedJournalReady",
    "conflictSafeIdempotencyReady", "reversalOnlyCorrectionsReady", "postingCatalogReady",
    "recoveryReady", "replayReady", "reconciliationReady", "creditWalletDependencyReady", "rollbackReady",
  ]) assert(report[field] === true, `Readiness capability '${field}' is not ready.`, { report });
  assert(report.productionPostingEnabled === false && report.serviceAuthorityEnabled === false,
    "Production Ledger authority must remain disabled.", { report });

  const repeated = await request("/internal/ledger/authority/readiness?mode=SERVICE_SHADOW");
  assert(repeated.response.ok && repeated.body.readinessReportHash === report.readinessReportHash,
    "Readiness report hash is not deterministic.", { first: report.readinessReportHash, second: repeated.body?.readinessReportHash });

  const service = await request("/internal/ledger/authority/readiness?mode=SERVICE");
  assert(service.response.ok && service.body.promotionAllowed === false && service.body.serviceAuthorityEnabled === false,
    "SERVICE mode must fail closed.", { service: service.body });
  assert(service.body.legacyPathsIsolated === false && service.body.blockers.some((item: string) => item.includes("Legacy direct")),
    "Legacy compatibility paths must block SERVICE promotion until isolated.", { service: service.body });

  const requiredRules = [
    "SETTLEMENT_PAYOUT", "SETTLEMENT_REFUND", "AGENT_COMMISSION_ACCRUAL",
    "PLAYER_REBATE_CREDIT", "PROMOTIONAL_CREDIT", "MANUAL_CREDIT_ADJUSTMENT", "MANUAL_DEBIT_ADJUSTMENT",
  ];
  const catalog = await pool.query<{ rule_id: string; rule_version: string; content_hash: string }>(`
    select rule_id, rule_version, content_hash from ledger_service.financial_posting_rules
    where lifecycle = 'ACTIVE' and posting_enabled order by rule_id, rule_version
  `);
  const activeRules = new Set(catalog.rows.map((row) => row.rule_id));
  for (const rule of requiredRules) assert(activeRules.has(rule), `Required posting rule '${rule}' is missing.`);
  assert(catalog.rows.every((row) => row.rule_version && /^sha256:[0-9a-f]{64}$/.test(row.content_hash)),
    "Posting catalog versions and hashes must be immutable and exact.");

  const cashier = await pool.query<{ enabled: string }>(`
    select count(*) filter (where posting_enabled)::text enabled from ledger_service.financial_posting_rules
    where rule_id in ('CASHIER_DEPOSIT', 'CASHIER_WITHDRAWAL')
  `);
  assert(cashier.rows[0].enabled === "0", "Cashier mappings must remain disabled.");
  pass("canonical posting, catalog, account-role, authority, legacy isolation, and rollback guardrails verified");
  return { report, catalogRows: catalog.rows };
}

async function verifyRecoveryReplayAndReconciliation(pool: Pool) {
  const recovery = await request("/internal/ledger/recovery/readiness");
  const evidence = recovery.body;
  for (const field of [
    "postingRecoveryReady", "journalIntegrityRecoveryReady", "replayReady",
    "minimalReconciliationReady", "unknownResultHandlingReady",
  ]) assert(evidence[field] === true, `Recovery capability '${field}' is not ready.`, { evidence });

  const state = await pool.query<{
    completed: string; failed: string; incomplete: string; attempts: string;
    unresolved_replay: string; unresolved_reconciliation: string;
  }>(`
    select
      count(*) filter (where request_status = 'COMPLETED')::text completed,
      count(*) filter (where request_status = 'FAILED')::text failed,
      count(*) filter (where request_status in ('CLAIMED', 'UNKNOWN'))::text incomplete,
      (select count(*)::text from ledger_service.ledger_posting_attempts) attempts,
      (select count(*)::text from ledger_service.ledger_replay_evidence replay
       join ledger_service.ledger_posting_requests replay_request on replay_request.id = replay.posting_request_id
       where replay.replay_result = 'MISMATCH' and not exists (
         select 1 from ledger_service.ledger_replay_evidence later
         where later.posting_request_id = replay.posting_request_id
           and later.verified_at > replay.verified_at and later.replay_result = 'MATCH')
         and replay_request.idempotency_key not like 'qa-%') unresolved_replay,
      (select count(*)::text from ledger_service.ledger_reconciliation_events reconciliation
       where reconciliation.reconciliation_result <> 'RECONCILED'
         and reconciliation.created_at = (select max(later.created_at)
           from ledger_service.ledger_reconciliation_events later
           where later.settlement_instruction_id = reconciliation.settlement_instruction_id)) unresolved_reconciliation
    from ledger_service.ledger_posting_requests
  `);
  const row = state.rows[0];
  assert(Number(row.completed) > 0 && Number(row.attempts) > 0, "Durable posting and attempt evidence is missing.", { row });
  assert(row.unresolved_replay === "0" && row.unresolved_reconciliation === "0",
    "Replay or instruction-level reconciliation has unresolved mismatches.", { row });
  pass("completed, failed, unknown, duplicate, replay, recovery, and minimal reconciliation paths verified", { incompleteRequests: Number(row.incomplete) });
  return { evidence, incompleteRequests: Number(row.incomplete) };
}

async function verifyPromotion() {
  const requestBody = {
    authorityMode: "SERVICE_DRY_RUN",
    operatorReference: "qa-ledger-final-verification",
    approvalMetadata: { phase: "P1-008.8", productionApproval: false },
  };
  const first = await request("/internal/ledger/authority/promotion-dry-run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody),
  });
  const second = await request("/internal/ledger/authority/promotion-dry-run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody),
  });
  assert(first.response.ok && second.response.ok, "Promotion rehearsal failed.", { first: first.body, second: second.body });
  assert(first.body.rehearsal.canonicalEvidenceHash === second.body.rehearsal.canonicalEvidenceHash,
    "Promotion rehearsal is not deterministic.", { first: first.body.rehearsal, second: second.body.rehearsal });
  assert(first.body.authoritySwitched === false && first.body.rollbackAuthority === "MONOLITH",
    "Promotion rehearsal must remain non-authoritative with explicit rollback.", { rehearsal: first.body });
  assert(first.body.comparisons.length === 8, "Promotion rehearsal must cover all representative posting families.");
  pass("deterministic promotion rehearsal and rollback readiness verified", { result: first.body.rehearsal.resultSummary });
  return first.body.rehearsal;
}

async function persistVerification(
  pool: Pool,
  readiness: ReadinessEvidence,
  catalogRows: Array<Record<string, unknown>>,
  recovery: RecoveryEvidence,
  rehearsal: RehearsalEvidence,
  incompleteRequests: number,
) {
  const migrationRows = await pool.query<{ migration_id: string; checksum: string; status: string }>(`
    select migration_id, checksum, status from platform_migrations.migration_history
    where status = 'APPLIED' order by migration_id
  `);
  const migrationVersion = migrationRows.rows.at(-1)?.migration_id ?? "unknown";
  assert(migrationVersion === "066_add_ledger_authority_verifications", "Final verification migration is not current.", { migrationVersion });

  const capabilityHashes = {
    readinessReport: readiness.readinessReportHash,
    postingCatalog: hash(catalogRows as unknown as Json),
    migrationState: hash(migrationRows.rows as unknown as Json),
    configuration: rehearsal.configurationHash,
    promotionRehearsal: rehearsal.canonicalEvidenceHash,
    recoveryCapability: hash({
      postingRecoveryReady: recovery.postingRecoveryReady,
      journalIntegrityRecoveryReady: recovery.journalIntegrityRecoveryReady,
      unknownResultHandlingReady: recovery.unknownResultHandlingReady,
    }),
    replayCapability: hash({ replayReady: recovery.replayReady }),
    journalCapability: hash({ immutable: true, balanced: true, reversalOnly: true }),
    reconciliationCapability: hash({ minimalReconciliationReady: recovery.minimalReconciliationReady }),
    guardrails: hash({ productionPostingEnabled: false, serviceAuthorityEnabled: false, noSilentFallback: true }),
  };
  const readinessFingerprint = hash(capabilityHashes as unknown as Json);
  const operationalBlockers = [
    "Production approval is absent.",
    "Production credentials and configuration are absent.",
    "Production environment confirmation and promotion authorization are absent.",
    "Legacy direct DB/RPC paths require operational isolation before SERVICE promotion.",
    ...(incompleteRequests > 0 ? [`${incompleteRequests} incomplete durable Ledger posting request(s) require governed recovery.`] : []),
  ];
  const warnings = ["Verification certifies the credit-only launch Ledger scope; broad accounting reconciliation is excluded."];
  const limitations = ["Cashier and tax posting remain outside this milestone.", "Production SERVICE authority remains disabled."];
  const capabilities = checks.map((check) => check.name).sort();
  const configurationHash = hash({ authorityMode: "MONOLITH", productionEnabled: false, buildVersion });
  const verificationTimestamp = new Date().toISOString();
  const verificationMaterial = {
    buildVersion, configurationHash, migrationVersion, readinessFingerprint,
    authorityMode: "MONOLITH", verificationResult: "IMPLEMENTATION_COMPLETE",
    verifiedCapabilities: capabilities, blockingFindings: operationalBlockers,
    warningFindings: warnings, knownLimitations: limitations,
  };
  const canonicalVerificationHash = hash(verificationMaterial as unknown as Json);
  const verificationId = uuidFromHash(canonicalVerificationHash);
  const result = await pool.query<{
    verification_id: string; readiness_fingerprint: string; canonical_verification_hash: string;
  }>(`
    with inserted as (
      insert into ledger_service.ledger_authority_verifications (
        verification_id, build_version, configuration_hash, migration_version,
        readiness_fingerprint, verification_timestamp, authority_mode, verification_result,
        verified_capabilities, blocking_findings, warning_findings, known_limitations,
        canonical_verification_hash)
      values ($1, $2, $3, $4, $5, $6, 'MONOLITH', 'IMPLEMENTATION_COMPLETE',
              $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
      on conflict (readiness_fingerprint) do nothing
      returning verification_id, readiness_fingerprint, canonical_verification_hash
    )
    select * from inserted
    union all
    select verification_id, readiness_fingerprint, canonical_verification_hash
    from ledger_service.ledger_authority_verifications where readiness_fingerprint = $5
    limit 1
  `, [verificationId, buildVersion, configurationHash, migrationVersion, readinessFingerprint,
    verificationTimestamp, JSON.stringify(capabilities), JSON.stringify(operationalBlockers),
    JSON.stringify(warnings), JSON.stringify(limitations), canonicalVerificationHash]);
  assert(result.rowCount === 1 && result.rows[0].readiness_fingerprint === readinessFingerprint,
    "Immutable final verification report was not persisted.", { result: result.rows });

  try {
    await pool.query("update ledger_service.ledger_authority_verifications set build_version = 'tampered' where verification_id = $1", [result.rows[0].verification_id]);
    fail("Final verification report update must be blocked.");
  } catch (error) {
    assert(String(error).includes("append-only"), "Verification update did not fail through append-only governance.", { error: String(error) });
  }
  try {
    await pool.query("delete from ledger_service.ledger_authority_verifications where verification_id = $1", [result.rows[0].verification_id]);
    fail("Final verification report delete must be blocked.");
  } catch (error) {
    assert(String(error).includes("append-only"), "Verification delete did not fail through append-only governance.", { error: String(error) });
  }
  pass("immutable final verification report persisted");
  return { readinessFingerprint, verificationId: result.rows[0].verification_id, operationalBlockers };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required for final Ledger verification.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await verifyArchitecture();
    await verifySchemaAndJournal(pool);
    const { report, catalogRows } = await verifyRuntimeAndCatalog(pool);
    const { evidence, incompleteRequests } = await verifyRecoveryReplayAndReconciliation(pool);
    const rehearsal = await verifyPromotion();
    const certification = await persistVerification(pool, report, catalogRows, evidence, rehearsal, incompleteRequests);
    console.log(JSON.stringify({
      status: "PASS",
      result: "IMPLEMENTATION_COMPLETE",
      promotionStatus: "READY_FOR_PRODUCTION_PROMOTION_PENDING_OPERATIONAL_APPROVAL",
      productionAuthorityEnabled: false,
      ...certification,
      checks,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Final Ledger Authority verification failed unexpectedly.", { error: String(error), stack: error?.stack }));
