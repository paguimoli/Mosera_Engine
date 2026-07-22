import { Pool } from "pg";

type Check = { name: string; status: "PASS"; metadata?: Record<string, unknown> };
const checks: Check[] = [];
const ledgerUrl = (process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:8080").replace(/\/$/, "");

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata, checks }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) fail(message, metadata);
}

function pass(name: string, metadata: Record<string, unknown> = {}) {
  checks.push({ name, status: "PASS", metadata });
}

async function json(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function verifySchema(pool: Pool) {
  const result = await pool.query<{
    table_name: string | null; trigger_count: string; manifest_count: string;
  }>(`
    select to_regclass('ledger_service.ledger_promotion_rehearsals')::text table_name,
      (select count(*)::text from pg_trigger where not tgisinternal and tgname in (
        'ledger_promotion_rehearsals_update_guard', 'ledger_promotion_rehearsals_delete_guard')) trigger_count,
      (select count(*)::text from pg_indexes where schemaname = 'ledger_service'
        and tablename = 'ledger_promotion_rehearsals') manifest_count
  `);
  assert(result.rows[0].table_name === "ledger_service.ledger_promotion_rehearsals",
    "Ledger promotion rehearsal persistence must exist.", { row: result.rows[0] });
  assert(result.rows[0].trigger_count === "2", "Ledger promotion evidence must be append-only.", { row: result.rows[0] });
  assert(Number(result.rows[0].manifest_count) >= 4, "Ledger promotion lookup indexes must exist.", { row: result.rows[0] });
  pass("append-only promotion evidence schema is ready");
}

async function verifyReadiness() {
  const shadowResponse = await fetch(`${ledgerUrl}/internal/ledger/authority/readiness?mode=SERVICE_SHADOW`);
  const shadow = await json(shadowResponse);
  assert(shadowResponse.ok && shadow.authorityMode === "SERVICE_SHADOW",
    "SERVICE_SHADOW readiness must be explicit.", { status: shadowResponse.status, shadow });
  assert(shadow.serviceAuthorityEnabled === false && shadow.productionPostingEnabled === false,
    "Readiness must not enable production posting or SERVICE authority.", { shadow });
  assert(Array.isArray(shadow.capabilityMarkers) && shadow.capabilityMarkers.includes("no-silent-fallback"),
    "Readiness must expose the no-silent-fallback marker.", { shadow });
  assert(Array.isArray(shadow.legacyPaths) && shadow.legacyPaths.length >= 5,
    "Readiness must inventory legacy and compatibility paths.", { legacyPaths: shadow.legacyPaths });

  const repeatedResponse = await fetch(`${ledgerUrl}/internal/ledger/authority/readiness?mode=SERVICE_SHADOW`);
  const repeated = await json(repeatedResponse);
  assert(repeatedResponse.ok && repeated.readinessReportHash === shadow.readinessReportHash,
    "Equivalent readiness evidence must hash deterministically.", { first: shadow.readinessReportHash, second: repeated.readinessReportHash });
  pass("unified deterministic Ledger readiness report is available", { blockers: shadow.blockers });

  const serviceResponse = await fetch(`${ledgerUrl}/internal/ledger/authority/readiness?mode=SERVICE`);
  const service = await json(serviceResponse);
  assert(serviceResponse.ok && service.authorityMode === "SERVICE" && service.promotionAllowed === false,
    "SERVICE authority must fail closed.", { service });
  assert(service.legacyPathsIsolated === false && service.blockers.some((value: string) => value.includes("Legacy direct")),
    "SERVICE readiness must identify unresolved legacy isolation.", { service });
  assert(service.blockers.some((value: string) => value.includes("Production Ledger posting"))
      && service.blockers.some((value: string) => value.includes("approval")),
    "SERVICE readiness must expose posting and approval blockers.", { blockers: service.blockers });
  pass("production promotion guardrails fail closed");
}

async function verifyPromotionRehearsal(pool: Pool) {
  const request = {
    authorityMode: "SERVICE_DRY_RUN",
    operatorReference: "qa-ledger-authority-guardrails",
    approvalMetadata: { phase: "P1-008.7", productionApproval: false },
  };
  const response = await fetch(`${ledgerUrl}/internal/ledger/authority/promotion-dry-run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  const result = await json(response);
  assert(response.ok && result.authoritySwitched === false && result.rollbackAuthority === "MONOLITH",
    "Dry-run must never switch authority and must preserve MONOLITH rollback.", { status: response.status, result });
  const expected = new Set([
    "SETTLEMENT_PAYOUT", "SETTLEMENT_REFUND", "SETTLEMENT_REVERSAL", "CORRECTED_SETTLEMENT",
    "PLAYER_REBATE_CREDIT", "PROMOTIONAL_CREDIT", "AGENT_COMMISSION_ACCRUAL", "GOVERNED_MANUAL_ADJUSTMENT",
  ]);
  assert(Array.isArray(result.comparisons) && result.comparisons.length === expected.size
      && result.comparisons.every((item: { instructionFamily: string }) => expected.has(item.instructionFamily)),
    "Dry-run must classify every representative credit-only instruction family.", { comparisons: result.comparisons });
  assert(result.comparisons.every((item: { status: string }) =>
    ["MATCH", "ACCEPTABLE_DIFFERENCE", "DIVERGENCE", "INCONCLUSIVE"].includes(item.status)),
    "Every comparison must use a governed classification.", { comparisons: result.comparisons });

  const repeatedResponse = await fetch(`${ledgerUrl}/internal/ledger/authority/promotion-dry-run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  const repeated = await json(repeatedResponse);
  assert(repeatedResponse.ok && repeated.rehearsal.canonicalEvidenceHash === result.rehearsal.canonicalEvidenceHash
      && repeated.rehearsal.promotionRehearsalId === result.rehearsal.promotionRehearsalId,
    "Repeated dry-run evidence must be idempotent.", { first: result.rehearsal, repeated: repeated.rehearsal });
  pass("representative promotion rehearsal is deterministic and non-authoritative");

  const blockedResponse = await fetch(`${ledgerUrl}/internal/ledger/authority/promotion-dry-run`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, authorityMode: "SERVICE" }),
  });
  assert(blockedResponse.status === 400, "Production SERVICE rehearsal must be rejected.", { body: await json(blockedResponse) });
  pass("SERVICE rehearsal is rejected");

  const id = result.rehearsal.promotionRehearsalId;
  try {
    await pool.query("update ledger_service.ledger_promotion_rehearsals set operator_reference = 'tampered' where promotion_rehearsal_id = $1", [id]);
    fail("Promotion evidence update must be blocked.");
  } catch (error) {
    assert(String(error).includes("append-only"), "Update must fail through append-only guard.", { error: String(error) });
  }
  try {
    await pool.query("delete from ledger_service.ledger_promotion_rehearsals where promotion_rehearsal_id = $1", [id]);
    fail("Promotion evidence delete must be blocked.");
  } catch (error) {
    assert(String(error).includes("append-only"), "Delete must fail through append-only guard.", { error: String(error) });
  }
  pass("promotion evidence update and delete are blocked");
}

async function verifyRollback() {
  const response = await fetch(`${ledgerUrl}/internal/ledger/authority/rollback-readiness?proposedMode=SERVICE_DRY_RUN`);
  const result = await json(response);
  assert(response.ok && result.rollbackAuthority === "MONOLITH" && result.rollbackConfigured === true,
    "Rollback readiness must name the explicit MONOLITH target.", { result });
  assert(result.automaticFallbackEnabled === false,
    "Rollback readiness must not enable automatic fallback.", { result });
  pass("explicit rollback is ready without silent fallback");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required for Ledger authority guardrail QA.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await verifySchema(pool);
    await verifyReadiness();
    await verifyPromotionRehearsal(pool);
    await verifyRollback();
    console.log(JSON.stringify({ status: "PASS", suite: "ledger-authority-guardrails", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => fail("Ledger authority guardrail QA failed unexpectedly.", { error: String(error), stack: error?.stack }));
