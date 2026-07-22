import { Pool } from "pg";

type Check = { name: string; status: "PASS" };
type AuthorityFinding = {
  code: string;
  classification: "READY" | "BLOCKED" | "WARNING" | "INFORMATION";
  reason: string;
  authority: string;
  requiredAction: string;
  evidenceReference: string;
};
const checks: Check[] = [];
const serviceUrl = (process.env.CREDIT_SERVICE_URL ?? "http://localhost:5300").replace(/\/$/, "");
const apiKey = process.env.CREDIT_WALLET_INTERNAL_API_KEY ?? "local-credit-wallet-internal-key";

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({ status: "FAIL", message, metadata, checks }, null, 2));
  process.exit(1);
}
function assert(value: unknown, message: string, metadata: Record<string, unknown> = {}): asserts value {
  if (!value) fail(message, metadata);
}
function pass(name: string) { checks.push({ name, status: "PASS" }); }
async function body(response: Response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}
function headers() {
  return {
    "content-type": "application/json",
    "x-internal-service-name": "app",
    authorization: `Bearer ${apiKey}`,
    "x-correlation-id": "qa-credit-wallet-authority-guardrails",
  };
}
async function get(path: string, authenticated = true) {
  const response = await fetch(`${serviceUrl}${path}`, { headers: authenticated ? headers() : {} });
  return { response, body: await body(response) };
}
async function post(path: string, payload: Record<string, unknown>, authenticated = true) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method: "POST", headers: authenticated ? headers() : { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { response, body: await body(response) };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const unauthorized = await get("/v1/credit-wallets/internal/authority/readiness", false);
    assert(unauthorized.response.status === 401, "Authority readiness must require internal authentication.", { unauthorized });
    pass("internal authentication enforced");

    const monolith = await get("/v1/credit-wallets/internal/authority/readiness?mode=MONOLITH");
    assert(monolith.response.ok && monolith.body?.configuredAuthorityMode === "MONOLITH",
      "Configured authority must remain MONOLITH.", { monolith });
    assert(monolith.body?.serviceAuthorityEnabled === false
      && monolith.body?.productionAuthorityActivationEnabled === false
      && monolith.body?.noSilentFallback === true,
    "Authority routing must remain explicit, disabled, and without silent fallback.", { monolith: monolith.body });
    pass("MONOLITH remains configured with no silent fallback");

    for (const mode of ["SERVICE_SHADOW", "SERVICE_DRY_RUN"]) {
      const readiness = await get(`/v1/credit-wallets/internal/authority/readiness?mode=${mode}`);
      assert(readiness.response.ok && readiness.body?.evaluatedAuthorityMode === mode,
        `${mode} must be a supported evaluation mode.`, { readiness });
      assert(readiness.body?.serviceAuthorityEnabled === false,
        `${mode} must not enable SERVICE authority.`, { readiness: readiness.body });
    }
    pass("SERVICE_SHADOW and SERVICE_DRY_RUN modes validate without switching");

    const production = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE");
    assert(production.response.ok && production.body?.promotionAllowed === false,
      "SERVICE mode must fail closed.", { production });
    assert(production.body?.findings?.some((item: AuthorityFinding) => item.code === "PRODUCTION_AUTHORITY_DISABLED"
      && item.classification === "BLOCKED"),
    "SERVICE mode must report the explicit production activation blocker.", { findings: production.body?.findings });
    pass("SERVICE mode fails closed");

    const firstFingerprint = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE_DRY_RUN");
    const secondFingerprint = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE_DRY_RUN");
    assert(firstFingerprint.body?.readinessFingerprint === secondFingerprint.body?.readinessFingerprint,
      "Readiness fingerprint must be deterministic.", {
        first: firstFingerprint.body?.readinessFingerprint,
        second: secondFingerprint.body?.readinessFingerprint,
      });
    assert(firstFingerprint.body?.projectionRepairPolicy === "INTENTIONALLY_MANUAL",
      "Projection repair policy must remain intentionally manual.", { readiness: firstFingerprint.body });
    const serialized = JSON.stringify(firstFingerprint.body);
    assert(!serialized.includes("operator acknowledgement") && !serialized.includes("automated compensation blocker"),
      "Operator acknowledgement and automated compensation must not be Credit Wallet blockers.");
    pass("fingerprint stable and roadmap corrections visible");

    const blockers = await get("/v1/credit-wallets/internal/authority/blockers?mode=SERVICE_DRY_RUN");
    assert(blockers.response.ok && Array.isArray(blockers.body?.findings)
      && blockers.body.findings.every((item: AuthorityFinding) =>
        ["READY", "BLOCKED", "WARNING", "INFORMATION"].includes(item.classification)
        && item.reason && item.authority && item.requiredAction && item.evidenceReference),
    "Operational findings must be classified and evidence-linked.", { blockers: blockers.body });
    pass("authoritative blocker reporting is structured");

    const invalidRehearsal = await post("/v1/credit-wallets/internal/authority/promotion-rehearsal", {
      authorityMode: "SERVICE", operatorReference: "qa-credit-wallet-authority",
    });
    assert(invalidRehearsal.response.status === 400,
      "Promotion rehearsal must reject SERVICE authority.", { invalidRehearsal });
    pass("production authority rehearsal request rejected");

    const rehearsalRequest = { authorityMode: "SERVICE_DRY_RUN", operatorReference: "qa-credit-wallet-authority" };
    const rehearsal = await post("/v1/credit-wallets/internal/authority/promotion-rehearsal", rehearsalRequest);
    assert(rehearsal.response.ok && ["PASS", "BLOCKED"].includes(rehearsal.body?.evidence?.result)
      && rehearsal.body?.authoritySwitched === false && rehearsal.body?.rollbackAuthority === "MONOLITH",
    "Promotion rehearsal must persist evidence without changing authority.", { rehearsal });
    const repeatedRehearsal = await post("/v1/credit-wallets/internal/authority/promotion-rehearsal", rehearsalRequest);
    assert(repeatedRehearsal.response.ok
      && repeatedRehearsal.body?.evidence?.evidenceId === rehearsal.body?.evidence?.evidenceId
      && repeatedRehearsal.body?.evidence?.evidencePayloadHash === rehearsal.body?.evidence?.evidencePayloadHash,
    "Repeated promotion rehearsal must return deterministic evidence.", { rehearsal, repeatedRehearsal });
    const afterPromotion = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE_DRY_RUN");
    assert(afterPromotion.body?.readinessFingerprint !== firstFingerprint.body?.readinessFingerprint
      || firstFingerprint.body?.latestPromotionRehearsal?.evidencePayloadHash === rehearsal.body?.evidence?.evidencePayloadHash,
    "Changed promotion evidence must change readiness fingerprint; unchanged evidence may preserve it.", {
      before: firstFingerprint.body?.readinessFingerprint,
      after: afterPromotion.body?.readinessFingerprint,
    });
    assert(afterPromotion.body?.latestPromotionRehearsal?.evidencePayloadHash
      === rehearsal.body?.evidence?.evidencePayloadHash,
    "Readiness must bind the latest promotion evidence hash.", { afterPromotion: afterPromotion.body });
    pass("promotion rehearsal is durable, repeatable, and non-authoritative");

    const rollbackRequest = {
      sourceAuthority: "SERVICE", targetAuthority: "MONOLITH", operatorReference: "qa-credit-wallet-authority",
    };
    const rollback = await post("/v1/credit-wallets/internal/authority/rollback-rehearsal", rollbackRequest);
    assert(rollback.response.ok && rollback.body?.rollbackAuthority === "MONOLITH"
      && rollback.body?.automaticFallbackEnabled === false && rollback.body?.authoritySwitched === false,
    "Rollback rehearsal must target MONOLITH without automatic fallback or switching.", { rollback });
    const repeatedRollback = await post("/v1/credit-wallets/internal/authority/rollback-rehearsal", rollbackRequest);
    assert(repeatedRollback.body?.evidence?.evidenceId === rollback.body?.evidence?.evidenceId,
      "Repeated rollback rehearsal must return the same immutable evidence.", { rollback, repeatedRollback });
    const afterRollback = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE_DRY_RUN");
    assert(afterRollback.body?.readinessFingerprint !== afterPromotion.body?.readinessFingerprint
      || afterPromotion.body?.latestRollbackRehearsal?.evidencePayloadHash === rollback.body?.evidence?.evidencePayloadHash,
    "Changed rollback evidence must change readiness fingerprint; unchanged evidence may preserve it.", {
      before: afterPromotion.body?.readinessFingerprint,
      after: afterRollback.body?.readinessFingerprint,
    });
    assert(afterRollback.body?.latestRollbackRehearsal?.evidencePayloadHash
      === rollback.body?.evidence?.evidencePayloadHash,
    "Readiness must bind the latest rollback evidence hash.", { afterRollback: afterRollback.body });
    const stableAfterRollback = await get("/v1/credit-wallets/internal/authority/readiness?mode=SERVICE_DRY_RUN");
    assert(stableAfterRollback.body?.readinessFingerprint === afterRollback.body?.readinessFingerprint,
      "Fingerprint must remain stable after rehearsal evidence stops changing.");
    pass("SERVICE to MONOLITH rollback rehearsal is deterministic");

    const verification = await post(
      "/v1/credit-wallets/internal/authority/verify?mode=SERVICE_DRY_RUN&operatorReference=qa-credit-wallet-authority", {});
    assert(verification.response.ok && verification.body?.authoritySwitched === false
      && verification.body?.readinessEvidence && verification.body?.guardrailEvidence
      && verification.body?.blockerEvidence,
    "Readiness, guardrail, and blocker evidence must persist together.", { verification });
    pass("readiness, guardrail, and blocker evidence persisted");

    const evidence = await pool.query(
      `select evidence_id, evidence_type, evidence_payload_hash
       from credit_wallet_service.wallet_authority_evidence
       where operator_reference = 'qa-credit-wallet-authority'`);
    assert(new Set(evidence.rows.map(row => row.evidence_type)).size >= 5,
      "All required operational evidence categories must be append-only persisted.", { evidence: evidence.rows });
    let mutationBlocked = false;
    try {
      await pool.query(
        `update credit_wallet_service.wallet_authority_evidence set result='PASS' where evidence_id=$1`,
        [evidence.rows[0].evidence_id]
      );
    } catch { mutationBlocked = true; }
    assert(mutationBlocked, "Authority evidence updates must be blocked.");
    pass("authority evidence is append-only");

    console.log(JSON.stringify({
      status: "PASS",
      checks,
      configuredAuthority: monolith.body.configuredAuthorityMode,
      productionAuthorityEnabled: false,
      rehearsalResult: rehearsal.body.evidence.result,
      rollbackResult: rollback.body.result,
      readinessFingerprint: firstFingerprint.body.readinessFingerprint,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => fail("Credit Wallet authority guardrail QA failed.", { error: String(error?.stack ?? error) }));
