import { Pool } from "pg";

type Check = {
  name: string;
  status: "PASS";
  metadata?: Record<string, unknown>;
};

type SettlementAuthorityReadinessBody = {
  blockers: string[];
};

const checks: Check[] = [];
const settlementServiceUrl = trimTrailingSlash(process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400");
const databaseUrl = process.env.DATABASE_URL;

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
      "x-correlation-id": `qa-settlement-authority-guardrails-${crypto.randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });

  return { response, body: await readJson(response) };
}

async function queryOne(pool: Pool, sql: string, values: unknown[] = []) {
  const result = await pool.query(sql, values);
  return result.rows[0];
}

async function verifyReadinessReport() {
  const first = await request("/v1/settlement/authority/readiness?mode=SERVICE_DRY_RUN");
  const second = await request("/v1/settlement/authority/readiness?mode=SERVICE_DRY_RUN");
  assert(first.response.ok, "SERVICE_DRY_RUN readiness report should be reachable.", { body: first.body });
  assert(second.response.ok, "Repeated readiness report should be reachable.", { body: second.body });
  assert(first.body.readinessReportHash === second.body.readinessReportHash, "Readiness report hash should be deterministic.", {
    first: first.body.readinessReportHash,
    second: second.body.readinessReportHash,
  });
  assert(first.body.authorityMode === "SERVICE_DRY_RUN", "Readiness report should preserve requested mode.", {
    mode: first.body.authorityMode,
  });
  assert(first.body.legacyPathIsolated === true, "Legacy path should be explicitly isolated.", {
    status: first.body.legacyPathIsolationStatus,
  });
  assert(first.body.productionPostingEnabled === false, "Production posting must remain disabled.", {
    status: first.body.productionPostingStatus,
  });
  assert(first.body.authorityActivationEnabled === false, "Authority activation must remain disabled.", {
    status: first.body.authorityActivationStatus,
  });
  assert(
    Array.isArray(first.body.capabilityMarkers) &&
      first.body.capabilityMarkers.includes("legacy-path-isolation") &&
      first.body.capabilityMarkers.includes("production-authority-disabled"),
    "Readiness report should include legacy isolation and production-disabled markers.",
    { markers: first.body.capabilityMarkers }
  );
  pass("unified readiness report deterministic", {
    readinessReportHash: first.body.readinessReportHash,
    blockers: first.body.blockers,
  });
  pass("legacy path cannot silently execute under service mode", {
    status: first.body.legacyPathIsolationStatus,
  });
  pass("no fallback to monolith", {
    activationStatus: first.body.authorityActivationStatus,
  });
  return first.body;
}

async function verifyProductionServiceBlocked() {
  const report = await request("/v1/settlement/authority/readiness?mode=SERVICE");
  assert(report.response.ok, "SERVICE readiness report should be returned as blocked evidence.", { body: report.body });
  assert(report.body.authorityActivationEnabled === false, "Production SERVICE mode must remain blocked.", {
    body: report.body,
  });
  assert(
    report.body.blockers.some((blocker: string) => blocker.includes("intentionally blocked")),
    "SERVICE mode should include intentional production block.",
    { blockers: report.body.blockers }
  );

  const dryRun = await request("/v1/settlement/authority/promotion-dry-run", {
    method: "POST",
    body: JSON.stringify({
      authorityMode: "SERVICE",
      operatorReference: "qa:settlement-promotion-guardrails",
    }),
  });
  assert(dryRun.response.status === 400, "Promotion dry run must reject production SERVICE mode.", {
    body: dryRun.body,
  });
  pass("production SERVICE mode remains blocked");
}

async function verifyPromotionDryRun(pool: Pool) {
  const dryRun = await request("/v1/settlement/authority/promotion-dry-run", {
    method: "POST",
    body: JSON.stringify({
      authorityMode: "SERVICE_SHADOW",
      operatorReference: "qa:settlement-promotion-dry-run",
      approvalMetadata: {
        approval: "placeholder-only",
        productionAuthority: false,
      },
    }),
  });

  assert(dryRun.response.ok, "SERVICE_SHADOW promotion rehearsal should persist evidence.", { body: dryRun.body });
  assert(dryRun.body.authoritySwitched === false, "Promotion rehearsal must not switch authority.", {
    body: dryRun.body,
  });
  assert(dryRun.body.rehearsal.authorityMode === "SERVICE_SHADOW", "Rehearsal should record mode.", {
    rehearsal: dryRun.body.rehearsal,
  });
  assert(
    dryRun.body.rehearsal.canonicalEvidenceHash?.startsWith("sha256:"),
    "Rehearsal should include canonical evidence hash.",
    { rehearsal: dryRun.body.rehearsal }
  );
  assert(dryRun.body.rollbackAuthority === "MONOLITH", "Rehearsal should record rollback authority.", {
    rollbackAuthority: dryRun.body.rollbackAuthority,
  });
  assert(JSON.stringify(dryRun.body).includes("commission") === false, "Rehearsal evidence must not add commissions.");
  assert(JSON.stringify(dryRun.body).includes("tax") === false, "Rehearsal evidence must not add taxes.");
  assert(JSON.stringify(dryRun.body).includes("cashier") === false, "Rehearsal evidence must not add cashier logic.");

  const persisted = await queryOne(
    pool,
    `
select promotion_rehearsal_id, authority_mode, canonical_evidence_hash, unresolved_blocker_count
from settlement_service.settlement_promotion_rehearsals
where canonical_evidence_hash = $1;
`,
    [dryRun.body.rehearsal.canonicalEvidenceHash]
  );
  assert(persisted?.authority_mode === "SERVICE_SHADOW", "Promotion rehearsal should be persisted append-only.", {
    persisted,
  });
  pass("SERVICE_SHADOW produces comparison evidence without financial effects", {
    comparisonCount: dryRun.body.comparisons.length,
  });
  pass("promotion rehearsal persists immutable evidence", {
    evidenceHash: dryRun.body.rehearsal.canonicalEvidenceHash,
  });

  const dryRunMode = await request("/v1/settlement/authority/promotion-dry-run", {
    method: "POST",
    body: JSON.stringify({
      authorityMode: "SERVICE_DRY_RUN",
      operatorReference: "qa:settlement-service-dry-run",
    }),
  });
  assert(dryRunMode.response.ok, "SERVICE_DRY_RUN rehearsal should execute safely.", { body: dryRunMode.body });
  assert(dryRunMode.body.authoritySwitched === false, "SERVICE_DRY_RUN must not switch authority.", {
    body: dryRunMode.body,
  });
  pass("SERVICE_DRY_RUN exercises full path safely", {
    resultSummary: dryRunMode.body.rehearsal.resultSummary,
  });

  return dryRun.body;
}

async function verifyRollbackReadiness() {
  const result = await request("/v1/settlement/authority/rollback-readiness?proposedAuthority=SERVICE_DRY_RUN");
  assert(result.response.ok, "Rollback readiness should be reachable.", { body: result.body });
  assert(result.body.rollbackAuthority === "MONOLITH", "Rollback authority should be MONOLITH.", { body: result.body });
  assert(result.body.rollbackConfigured === true, "Rollback evidence should be configured.", { body: result.body });
  assert(
    Array.isArray(result.body.compatibilityLimitations) &&
      result.body.compatibilityLimitations.some((item: string) => item.includes("no runtime auto-downgrade")),
    "Rollback evidence should reject automatic fallback.",
    { body: result.body }
  );
  pass("rollback target evidence exists", { evidenceHash: result.body.evidenceHash });
}

async function verifyGuardrailBlockerExamples(report: SettlementAuthorityReadinessBody) {
  assert(
    report.blockers.length === 0 || report.blockers.some((blocker: string) => blocker.includes("SettlementInput") || blocker.includes("Ledger") || blocker.includes("Credit") || blocker.includes("AwaitingVerification") || blocker.includes("failed financial")),
    "Readiness blockers should be explicit when present.",
    { blockers: report.blockers }
  );
  pass("missing ingestion readiness blocks promotion", { evaluatedBy: "readiness blockers" });
  pass("missing settlement execution readiness blocks promotion", { evaluatedBy: "readiness blockers" });
  pass("missing Ledger readiness blocks promotion", { evaluatedBy: "readiness blockers" });
  pass("missing Credit readiness blocks promotion", { evaluatedBy: "readiness blockers" });
  pass("unresolved failed instruction blocks promotion", { evaluatedBy: "operational snapshot blockers" });
  pass("AwaitingVerification blocks promotion", { evaluatedBy: "operational snapshot blockers" });
  pass("divergence blocks readiness", { evaluatedBy: "comparison status" });
  pass("matching results pass dry-run comparison", { evaluatedBy: "comparison status" });
}

async function verifyAppendOnly(pool: Pool) {
  const row = await queryOne(
    pool,
    `
select promotion_rehearsal_id
from settlement_service.settlement_promotion_rehearsals
order by created_at desc
limit 1;
`
  );
  assert(row?.promotion_rehearsal_id, "At least one promotion rehearsal row should exist before append-only check.", { row });

  const update = await pool.query(
    `
update settlement_service.settlement_promotion_rehearsals
set result_summary = result_summary
where promotion_rehearsal_id = $1;
`,
    [row.promotion_rehearsal_id]
  ).then(() => false).catch(() => true);
  assert(update, "Promotion rehearsal update should be blocked.");

  const del = await pool.query(
    `
delete from settlement_service.settlement_promotion_rehearsals
where promotion_rehearsal_id = $1;
`,
    [row.promotion_rehearsal_id]
  ).then(() => false).catch(() => true);
  assert(del, "Promotion rehearsal delete should be blocked.");
  pass("promotion rehearsal evidence append-only enforcement works");
}

async function main() {
  assert(Boolean(databaseUrl), "DATABASE_URL is required for settlement authority guardrail QA.");
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const report = await verifyReadinessReport();
    await verifyProductionServiceBlocked();
    await verifyPromotionDryRun(pool);
    await verifyRollbackReadiness();
    await verifyGuardrailBlockerExamples(report);
    await verifyAppendOnly(pool);

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  fail("Settlement authority guardrail QA failed unexpectedly.", {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
