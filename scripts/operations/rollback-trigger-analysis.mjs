import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

if (!sessionToken) {
  console.error("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");
  process.exit(1);
}

const response = await fetch(
  `${appUrl}/api/authority/settlement-post-promotion-status`,
  {
    headers: { authorization: `Bearer ${sessionToken}` },
  }
);
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  console.error(
    JSON.stringify({ status: "FAIL", statusCode: response.status, payload }, null, 2)
  );
  process.exit(1);
}

const status = payload.postPromotionStatus;

console.log(
  JSON.stringify(
    {
      status: "PASS",
      authority: status.authority,
      comparisonMode: status.comparisonMode,
      rollbackTrigger: status.rollbackTrigger,
      triggerSource: status.triggerSource,
      blockers: status.rollbackEvaluationDetails.blockers,
      warnings: status.rollbackEvaluationDetails.warnings,
      evidenceCounts: {
        raw: {
          mismatches: status.rawEvidenceSummary.mismatches,
          failures: status.rawEvidenceSummary.failures,
          excludedMismatches: status.rawEvidenceSummary.excludedMismatchCount,
          excludedFailures: status.rawEvidenceSummary.excludedFailureCount,
          readiness: status.rawEvidenceSummary.readiness,
        },
        promotion: {
          mismatches: status.promotionEvidenceSummary.mismatches,
          failures: status.promotionEvidenceSummary.failures,
          readiness: status.promotionEvidenceSummary.readiness,
        },
        postPromotion: {
          mismatches: status.postPromotionEvidenceSummary.mismatches,
          failures: status.postPromotionEvidenceSummary.failures,
          readiness: status.postPromotionEvidenceSummary.readiness,
        },
      },
      evaluatedAt: status.evaluatedAt,
    },
    null,
    2
  )
);
