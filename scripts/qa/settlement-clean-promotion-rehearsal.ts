import { Pool } from "pg";

const settlementServiceUrl = (process.env.SETTLEMENT_SERVICE_URL ?? "http://localhost:5400").replace(/\/$/, "");
const databaseUrl = process.env.DATABASE_URL;

type ReadinessResponse = {
  authorityMode: string;
  canonicalScopeBindingReady: boolean;
  historicalEvidenceGovernanceReady: boolean;
  legacyPathIsolated: boolean;
  canonicalScopeViolationCount: number;
  unresolvedHistoricalEvidenceCount: number;
  orphanedSettlementIntentCount: number;
  governedPromotionExclusionCount: number;
  blockers: string[];
  productionPostingEnabled: boolean;
  authorityActivationEnabled: boolean;
};

type PromotionComparison = {
  status: string;
};

type PromotionResponse = {
  rehearsal: {
    resultSummary: string;
    unresolvedBlockerCount: number;
    canonicalEvidenceHash: string;
  };
  remainingPromotionBlockers: string[];
  comparisons: PromotionComparison[];
  authoritySwitched: boolean;
  rollbackAuthority: string;
};

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) {
    fail(message, metadata);
  }
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${settlementServiceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": `qa-clean-promotion-${crypto.randomUUID()}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${path}: ${text}`);
  }
  return { response, body };
}

async function main() {
  assert(Boolean(databaseUrl), "DATABASE_URL is required for clean promotion rehearsal QA.");
  const readiness = await request<ReadinessResponse>("/v1/settlement/authority/readiness?mode=SERVICE_DRY_RUN");
  assert(readiness.response.ok, "Settlement promotion readiness must be reachable.", { body: readiness.body });
  assert(readiness.body.canonicalScopeBindingReady === true, "Canonical scope binding must be ready.", {
    body: readiness.body,
  });
  assert(readiness.body.historicalEvidenceGovernanceReady === true, "Historical evidence governance must be ready.", {
    body: readiness.body,
  });
  assert(readiness.body.legacyPathIsolated === true, "Legacy mutation paths must be isolated.", {
    body: readiness.body,
  });
  assert(readiness.body.canonicalScopeViolationCount === 0, "Canonical scope violations must be zero.", {
    count: readiness.body.canonicalScopeViolationCount,
  });
  assert(readiness.body.unresolvedHistoricalEvidenceCount === 0, "Unresolved historical evidence must be zero.", {
    count: readiness.body.unresolvedHistoricalEvidenceCount,
  });
  assert(readiness.body.orphanedSettlementIntentCount === 0, "Orphaned settlement intent must be zero.", {
    count: readiness.body.orphanedSettlementIntentCount,
  });
  assert(Array.isArray(readiness.body.blockers) && readiness.body.blockers.length === 0, "Promotion readiness must have zero blockers.", {
    blockers: readiness.body.blockers,
  });
  assert(readiness.body.productionPostingEnabled === false, "Production posting must remain disabled.");
  assert(readiness.body.authorityActivationEnabled === false, "Settlement authority activation must remain disabled.");

  const rehearsal = await request<PromotionResponse>("/v1/settlement/authority/promotion-dry-run", {
    method: "POST",
    body: JSON.stringify({
      authorityMode: "SERVICE_DRY_RUN",
      operatorReference: "qa:settlement-clean-promotion-rehearsal",
    }),
  });
  assert(rehearsal.response.ok, "Clean promotion rehearsal must complete.", { body: rehearsal.body });
  assert(rehearsal.body.rehearsal?.resultSummary === "PASS", "Promotion rehearsal result must be PASS.", {
    rehearsal: rehearsal.body.rehearsal,
  });
  assert(rehearsal.body.rehearsal?.unresolvedBlockerCount === 0, "Promotion rehearsal must record zero blockers.", {
    rehearsal: rehearsal.body.rehearsal,
  });
  assert(
    Array.isArray(rehearsal.body.remainingPromotionBlockers) && rehearsal.body.remainingPromotionBlockers.length === 0,
    "Promotion rehearsal must have no remaining blockers.",
    { blockers: rehearsal.body.remainingPromotionBlockers }
  );
  assert(
    Array.isArray(rehearsal.body.comparisons) &&
      rehearsal.body.comparisons.every((comparison) => comparison.status === "MATCH"),
    "Every selected comparison must match.",
    { comparisons: rehearsal.body.comparisons }
  );
  assert(rehearsal.body.authoritySwitched === false, "Dry-run rehearsal must not switch authority.");
  assert(rehearsal.body.rollbackAuthority === "MONOLITH", "Rollback authority must remain MONOLITH.");

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query(
      `select
         (select count(*)::int
          from settlement_service.authoritative_settlement_records record
          join settlement_service.settlement_requests request
            on request.settlement_request_id = record.settlement_request_id
          where request.tenant_id is null
             or request.brand_id is null
             or record.tenant_id is null
             or record.brand_id is null
             or request.tenant_id <> record.tenant_id
             or request.brand_id <> record.brand_id) as scope_violations,
         (select count(*)::int
          from settlement_service.settlement_evidence_classifications
          where classification in ('UNKNOWN_OR_INCONSISTENT', 'RECOVERABLE_PRODUCTION_SHAPED')
            and recovery_required) as unresolved_evidence,
         (select count(*)::int
          from settlement_service.settlement_promotion_rehearsals
          where canonical_evidence_hash = $1
            and result_summary = 'PASS'
            and unresolved_blocker_count = 0) as rehearsal_evidence`,
      [rehearsal.body.rehearsal.canonicalEvidenceHash]
    );
    const evidence = result.rows[0];
    assert(Number(evidence.scope_violations) === 0, "Disposable rehearsal data must have no scope violations.", {
      evidence,
    });
    assert(Number(evidence.unresolved_evidence) === 0, "Disposable rehearsal data must have no unresolved governed evidence.", {
      evidence,
    });
    assert(Number(evidence.rehearsal_evidence) === 1, "Clean rehearsal evidence must persist append-only.", {
      evidence,
    });
  } finally {
    await pool.end();
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        authorityMode: readiness.body.authorityMode,
        blockers: readiness.body.blockers,
        canonicalScopeViolationCount: readiness.body.canonicalScopeViolationCount,
        unresolvedHistoricalEvidenceCount: readiness.body.unresolvedHistoricalEvidenceCount,
        governedPromotionExclusionCount: readiness.body.governedPromotionExclusionCount,
        comparisonCount: rehearsal.body.comparisons.length,
        rehearsalEvidenceHash: rehearsal.body.rehearsal.canonicalEvidenceHash,
        productionPostingEnabled: readiness.body.productionPostingEnabled,
        authoritySwitched: rehearsal.body.authoritySwitched,
      },
      null,
      2
    )
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
