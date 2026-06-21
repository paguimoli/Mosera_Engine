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

async function authRequest(path, options = {}) {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  return requestJson(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      authorization: `Bearer ${sessionToken}`,
    },
  });
}

async function getShadowAnalysis() {
  const result = await authRequest("/api/shadow-analysis/summary?window=all");

  assert(result.response.status === 200 && result.body.success, "Shadow analysis failed.", {
    status: result.response.status,
    body: result.body,
  });

  return result.body.analysis;
}

async function getLifecycleSummary() {
  const result = await authRequest("/api/shadow-evidence/lifecycle/summary");

  assert(
    result.response.status === 200 && result.body.success,
    "Lifecycle summary failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.summary;
}

async function getLifecycleEvents() {
  const result = await authRequest("/api/shadow-evidence/lifecycle/events");

  assert(
    result.response.status === 200 && result.body.success,
    "Lifecycle events failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.events;
}

async function excludeQaEvidence() {
  const result = await authRequest(
    "/api/shadow-evidence/lifecycle/exclude-classified-qa",
    {
      method: "POST",
      headers: {
        "x-correlation-id": `qa-shadow-evidence-lifecycle-${Date.now()}`,
      },
    }
  );

  assert(
    result.response.status === 200 && result.body.success,
    "Exclude classified QA action failed.",
    { status: result.response.status, body: result.body }
  );

  return result.body.result;
}

const unauthenticated = await requestJson("/api/shadow-evidence/lifecycle/summary");
assert(
  unauthenticated.response.status === 401,
  "Lifecycle summary should require auth.",
  { status: unauthenticated.response.status, body: unauthenticated.body }
);
pass("Protected lifecycle APIs require auth.");

const beforeAnalysis = await getShadowAnalysis();
const beforeSummary = await getLifecycleSummary();
const beforeEvents = await getLifecycleEvents();
const originalIntentionalCount =
  beforeAnalysis.rootCause.mismatchCountsByCategory.QA_INTENTIONAL_MISMATCH +
  beforeAnalysis.rootCause.failureCountsByCategory.QA_INTENTIONAL_FAILURE;

assert(
  originalIntentionalCount > 0,
  "QA intentional evidence must exist before lifecycle exclusion.",
  { rootCause: beforeAnalysis.rootCause }
);
pass("Original classified QA evidence is present.", {
  originalIntentionalCount,
  raw: beforeAnalysis.platform.raw,
  promotionBefore: beforeAnalysis.platform.promotion,
});

const firstExclusion = await excludeQaEvidence();
assert(
  firstExclusion.consideredEvidence >= originalIntentionalCount,
  "Lifecycle exclusion did not consider classified QA evidence.",
  { firstExclusion, originalIntentionalCount }
);
pass("Classified QA evidence exclusion executed.", { firstExclusion });

const afterFirstAnalysis = await getShadowAnalysis();
const afterFirstEvents = await getLifecycleEvents();
assert(
  afterFirstEvents.length >= beforeEvents.length + firstExclusion.createdEvents,
  "Lifecycle events should be append-only.",
  {
    beforeEvents: beforeEvents.length,
    afterEvents: afterFirstEvents.length,
    firstExclusion,
  }
);
assert(
  afterFirstAnalysis.platform.promotion.mismatchRate <=
    beforeAnalysis.platform.promotion.mismatchRate,
  "Promotion mismatch rate should not increase after QA exclusion.",
  { before: beforeAnalysis.platform.promotion, after: afterFirstAnalysis.platform.promotion }
);
assert(
  afterFirstAnalysis.platform.promotion.failureRate <=
    beforeAnalysis.platform.promotion.failureRate,
  "Promotion failure rate should not increase after QA exclusion.",
  { before: beforeAnalysis.platform.promotion, after: afterFirstAnalysis.platform.promotion }
);

const secondExclusion = await excludeQaEvidence();
assert(
  secondExclusion.createdEvents === 0,
  "Lifecycle exclusion should be idempotent on repeated execution.",
  { secondExclusion }
);
pass("Lifecycle exclusion is idempotent.", { secondExclusion });

const afterSummary = await getLifecycleSummary();
const afterAnalysis = await getShadowAnalysis();
const afterIntentionalCount =
  afterAnalysis.rootCause.mismatchCountsByCategory.QA_INTENTIONAL_MISMATCH +
  afterAnalysis.rootCause.failureCountsByCategory.QA_INTENTIONAL_FAILURE;

assert(
  afterIntentionalCount === originalIntentionalCount,
  "Original shadow evidence should remain present after lifecycle exclusion.",
  { originalIntentionalCount, afterIntentionalCount }
);
assert(
  afterSummary.totalEvents >= beforeSummary.totalEvents,
  "Lifecycle summary should preserve append-only event history.",
  { beforeSummary, afterSummary }
);
pass("Original evidence remains present and lifecycle summary is append-only.", {
  promotionBefore: beforeAnalysis.platform.promotion,
  promotionAfter: afterAnalysis.platform.promotion,
  lifecycleSummary: afterSummary,
});

pass("Shadow evidence lifecycle QA completed.", {
  promotionBefore: beforeAnalysis.platform.promotion,
  promotionAfter: afterAnalysis.platform.promotion,
});
