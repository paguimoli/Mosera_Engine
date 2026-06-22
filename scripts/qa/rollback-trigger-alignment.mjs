import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

function authHeaders(extra = {}) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

const unauthenticated = await requestJson(
  "/api/authority/settlement-post-promotion-status"
);
assert(
  unauthenticated.response.status === 401,
  "Rollback trigger analysis should require authentication.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Rollback trigger analysis endpoint requires auth.");

const [statusResult, lifecycleResult, analysisResult] = await Promise.all([
  requestJson("/api/authority/settlement-post-promotion-status", {
    headers: authHeaders(),
  }),
  requestJson("/api/shadow-evidence/lifecycle/summary", {
    headers: authHeaders(),
  }),
  requestJson("/api/shadow-analysis/summary?window=all", {
    headers: authHeaders(),
  }),
]);

assert(
  statusResult.response.status === 200 && statusResult.body.success,
  "Post-promotion status endpoint failed.",
  { status: statusResult.response.status, body: statusResult.body }
);
assert(
  lifecycleResult.response.status === 200 && lifecycleResult.body.success,
  "Lifecycle summary endpoint failed.",
  { status: lifecycleResult.response.status, body: lifecycleResult.body }
);
assert(
  analysisResult.response.status === 200 && analysisResult.body.success,
  "Shadow analysis summary endpoint failed.",
  { status: analysisResult.response.status, body: analysisResult.body }
);

const status = statusResult.body.postPromotionStatus;
const lifecycle = lifecycleResult.body.summary;
const analysis = analysisResult.body.analysis;

assert(status.authority === "SERVICE", "Settlement authority must remain SERVICE.", {
  status,
});
assert(
  status.comparisonMode === "ENABLED",
  "Settlement comparison mode must remain ENABLED.",
  { status }
);
pass("Authority remains in promoted monitored state.", {
  authority: status.authority,
  comparisonMode: status.comparisonMode,
});

assert(
  lifecycle.effectiveStatusCounts.EXCLUDED_FROM_PROMOTION > 0,
  "Historical excluded QA evidence should remain visible.",
  { lifecycle }
);
assert(
  status.rawEvidenceSummary.excludedMismatchCount +
    status.rawEvidenceSummary.excludedFailureCount >
    0,
  "Raw evidence summary should expose excluded historical evidence counts.",
  { rawEvidenceSummary: status.rawEvidenceSummary }
);
assert(
  status.rawEvidenceSummary.readiness !== "READY",
  "Raw historical evidence should remain visible as non-ready.",
  { rawEvidenceSummary: status.rawEvidenceSummary }
);
pass("Historical excluded QA evidence remains visible.", {
  lifecycleExcluded:
    lifecycle.effectiveStatusCounts.EXCLUDED_FROM_PROMOTION,
  rawEvidence: status.rawEvidenceSummary,
});

assert(
  status.promotionEvidenceSummary.readiness === "READY",
  "Promotion lifecycle evidence should be READY.",
  { promotionEvidenceSummary: status.promotionEvidenceSummary }
);
assert(
  status.postPromotionEvidenceSummary.readiness === "READY",
  "Post-promotion evidence should be READY.",
  { postPromotionEvidenceSummary: status.postPromotionEvidenceSummary }
);
assert(
  status.postPromotionMismatchCount === 0 &&
    status.postPromotionFailureCount === 0,
  "Post-promotion evidence should have no mismatches or failures.",
  {
    postPromotionMismatchCount: status.postPromotionMismatchCount,
    postPromotionFailureCount: status.postPromotionFailureCount,
  }
);
pass("Promotion and post-promotion evidence are ready.", {
  promotion: status.promotionEvidenceSummary,
  postPromotion: status.postPromotionEvidenceSummary,
});

assert(
  status.triggerSource === "POST_PROMOTION_EVIDENCE",
  "Rollback trigger should prioritize post-promotion evidence while SERVICE is authoritative.",
  { triggerSource: status.triggerSource }
);
assert(
  status.rollbackEvaluationDetails.rawTriggerActive === true,
  "Raw trigger should remain visible for audit.",
  { details: status.rollbackEvaluationDetails }
);
assert(
  status.rollbackEvaluationDetails.promotionTriggerActive === false &&
    status.rollbackEvaluationDetails.postPromotionTriggerActive === false,
  "Lifecycle-effective and post-promotion evidence should not trigger rollback.",
  { details: status.rollbackEvaluationDetails }
);
assert(
  status.rollbackTrigger.shouldTriggerRollback === false,
  "Rollback trigger should not fire solely because of excluded QA evidence.",
  { rollbackTrigger: status.rollbackTrigger }
);
assert(
  status.rollbackTrigger.status === "READY" ||
    status.rollbackTrigger.status === "WARNING",
  "Aligned rollback trigger should not be BLOCKED by excluded QA evidence.",
  { rollbackTrigger: status.rollbackTrigger }
);
pass("Rollback trigger is aligned with lifecycle-effective and post-promotion evidence.", {
  rollbackTrigger: status.rollbackTrigger,
  details: status.rollbackEvaluationDetails,
});

assert(
  analysis.domains.settlement.promotionReadiness.readinessStatus === "READY",
  "Shadow analysis promotion readiness should remain READY.",
  { settlementAnalysis: analysis.domains.settlement }
);
pass("Shadow analysis agrees with promotion readiness.", {
  promotionReadiness: analysis.domains.settlement.promotionReadiness,
});

pass("Rollback trigger alignment QA completed.", {
  recommendation: status.recommendation,
});
