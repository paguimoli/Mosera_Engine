import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;

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
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN or OPS_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function assertProtected(path) {
  const result = await requestJson(path);

  assert(result.response.status === 401, `${path} should require auth.`, {
    status: result.response.status,
    body: result.body,
  });
}

async function authGet(path) {
  const result = await requestJson(path, {
    headers: authHeaders(),
  });

  assert(result.response.status === 200 && result.body.success, `${path} failed.`, {
    status: result.response.status,
    body: result.body,
  });

  return result.body;
}

function assertDomainState(baseline) {
  for (const domain of ["settlement", "ledger", "credit"]) {
    assert(baseline[domain].authority === "SERVICE", `${domain} authority changed.`, {
      baseline,
    });
    assert(
      baseline[domain].certificationStatus === "CERTIFIED",
      `${domain} certification changed.`,
      { baseline }
    );
    assert(
      baseline[domain].comparisonMode === "ENABLED",
      `${domain} comparison mode changed.`,
      { baseline }
    );
    assert(
      baseline[domain].rollbackReadiness === "READY",
      `${domain} rollback readiness changed.`,
      { baseline }
    );
  }
}

await Promise.all([
  assertProtected("/api/operations/platform-evidence"),
  assertProtected("/api/operations/ledger-reference-audit"),
  assertProtected("/api/operations/ledger-immutability"),
  assertProtected("/api/operations/outbox"),
  assertProtected("/api/operations/queues"),
  assertProtected("/api/operations/workers"),
]);
pass("Evidence hardening APIs require auth.");

const beforeBaseline = (await authGet("/api/authority/baseline-status")).baselineStatus;
const [
  platformPayload,
  referencePayload,
  immutabilityPayload,
  outboxPayload,
  queuePayload,
  workerPayload,
] = await Promise.all([
  authGet("/api/operations/platform-evidence"),
  authGet("/api/operations/ledger-reference-audit"),
  authGet("/api/operations/ledger-immutability"),
  authGet("/api/operations/outbox"),
  authGet("/api/operations/queues"),
  authGet("/api/operations/workers"),
]);
const afterBaseline = (await authGet("/api/authority/baseline-status")).baselineStatus;

assertDomainState(beforeBaseline);
assertDomainState(afterBaseline);

const platformEvidence = platformPayload.platformEvidence;
const referenceAudit = referencePayload.ledgerReferenceAudit;
const immutability = immutabilityPayload.ledgerImmutability;
const outbox = outboxPayload.outbox;
const queues = queuePayload.queues;
const workers = workerPayload.workers;

assert(platformEvidence.generatedAt, "Platform evidence missing generatedAt.", {
  platformEvidence,
});
assert(
  ["READY", "WARNING", "ACTION_REQUIRED"].includes(platformEvidence.status),
  "Platform evidence status is invalid.",
  { platformEvidence }
);
assert(
  referenceAudit.sampledCreditBackedSettlements >= 0 &&
    referenceAudit.missingLedgerPostingCount >= 0,
  "Ledger reference audit was not generated.",
  { referenceAudit }
);
assert(
  immutability.ledgerEntryCount >= 0 &&
    immutability.reversalIntegrity &&
    immutability.adjustmentChains,
  "Ledger immutability report was not generated.",
  { immutability }
);
assert(
  typeof outbox.pendingCount === "number" &&
    typeof outbox.failedCount === "number" &&
    outbox.dispatchLatency &&
    outbox.stalledPublisher,
  "Outbox hardening fields were not generated.",
  { outbox }
);
assert(
  Array.isArray(queues.rabbitmq) &&
    queues.rabbitmq.every((queue) => "queueDepth" in queue && "deadLetterStatus" in queue),
  "Queue hardening fields were not generated.",
  { queues }
);
assert(
  Array.isArray(workers.heartbeats) &&
    Array.isArray(workers.workerDetails) &&
    "activeWorkerObserved" in workers,
  "Worker hardening fields were not generated.",
  { workers }
);
assert(
  platformEvidence.ledgerReferenceAudit.status === referenceAudit.status,
  "Platform evidence did not include ledger reference audit.",
  { platformEvidence, referenceAudit }
);
assert(
  platformEvidence.ledgerImmutability.status === immutability.status,
  "Platform evidence did not include ledger immutability report.",
  { platformEvidence, immutability }
);
assert(
  beforeBaseline.settlement.authority === afterBaseline.settlement.authority &&
    beforeBaseline.ledger.authority === afterBaseline.ledger.authority &&
    beforeBaseline.credit.authority === afterBaseline.credit.authority,
  "Evidence hardening QA changed authority state.",
  { beforeBaseline, afterBaseline }
);

pass("Evidence hardening QA completed.", {
  platformEvidenceStatus: platformEvidence.status,
  ledgerReferenceAuditStatus: referenceAudit.status,
  ledgerImmutabilityStatus: immutability.status,
  outboxRecommendation: outbox.recommendation,
  queueCount: queues.rabbitmq.length,
  workerHeartbeatCount: workers.heartbeats.length,
  warnings: platformEvidence.warnings,
  blockers: platformEvidence.blockers,
});
