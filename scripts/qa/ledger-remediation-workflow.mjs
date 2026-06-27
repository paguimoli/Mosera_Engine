import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function authHeaders(extra = {}) {
  if (!sessionToken) fail("QA_ADMIN_SESSION_TOKEN or OPS_ADMIN_SESSION_TOKEN is required.");

  return {
    authorization: `Bearer ${sessionToken}`,
    ...extra,
  };
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function assertProtected(path) {
  const result = await requestJson(path);

  assert(result.response.status === 401, `${path} should require auth.`, {
    status: result.response.status,
    body: result.body,
  });
}

async function assertPostProtected(path) {
  const result = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert(result.response.status === 401, `${path} should require auth.`, {
    status: result.response.status,
    body: result.body,
  });
}

async function authGet(path) {
  const result = await requestJson(path, { headers: authHeaders() });

  assert(result.response.status === 200 && result.body.success, `${path} failed.`, {
    status: result.response.status,
    body: result.body,
  });

  return result.body;
}

async function authPost(path, body) {
  const result = await requestJson(path, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

  return result;
}

function createQaSupabaseClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    fail("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket,
    },
  });
}

async function countRows(supabase, table) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) fail(`Unable to count ${table}.`, { error: error.message });

  return count ?? 0;
}

async function snapshotFinancialCounts() {
  const supabase = createQaSupabaseClient();
  const [
    ledgerEntries,
    creditSettlementApplications,
    creditReservations,
    financialWallets,
  ] = await Promise.all([
    countRows(supabase, "financial_ledger_entries"),
    countRows(supabase, "credit_settlement_applications"),
    countRows(supabase, "credit_reservations"),
    countRows(supabase, "financial_wallets"),
  ]);

  return {
    ledgerEntries,
    creditSettlementApplications,
    creditReservations,
    financialWallets,
  };
}

async function findOutboxEvent(outboxEventId) {
  const supabase = createQaSupabaseClient();
  const { data, error } = await supabase
    .from("outbox_events")
    .select("id, event_type, aggregate_type, aggregate_id, status, payload")
    .eq("id", outboxEventId)
    .maybeSingle();

  if (error) fail("Unable to query outbox event.", { error: error.message });

  return data;
}

function assertPlatformState(baseline) {
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
      `${domain} comparison changed.`,
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
  assertProtected("/api/operations/ledger-reference-remediation/queue"),
  assertProtected("/api/operations/ledger-reference-remediation/summary"),
  assertPostProtected("/api/operations/ledger-reference-remediation/approvals"),
]);
pass("Ledger remediation workflow APIs require auth.");

const beforeCounts = await snapshotFinancialCounts();
const baselineBefore = (await authGet("/api/authority/baseline-status")).baselineStatus;
const queuePayload = await authGet("/api/operations/ledger-reference-remediation/queue");
const summaryPayload = await authGet("/api/operations/ledger-reference-remediation/summary");
const queue = queuePayload.remediationQueue;
const summary = summaryPayload.remediationSummary;

assertPlatformState(baselineBefore);
assert(queue.appendOnly === true, "Remediation queue must be append-only.", { queue });
assert(queue.mutationAllowed === false, "Remediation queue must not allow mutation.", {
  queue,
});
assert(
  summary.totalCount === queue.totalCount,
  "Remediation summary should match queue count.",
  { summary, queue }
);

if (queue.totalCount === 0) {
  pass("Ledger remediation workflow QA completed with empty queue.", {
    queueStatus: queue.status,
    summaryStatus: summary.status,
  });
  process.exit(0);
}

const candidate = queue.candidates[0];
const candidatePayload = await authGet(
  `/api/operations/ledger-reference-remediation/queue/${candidate.remediationId}`
);
const planPayload = await authGet(
  `/api/operations/ledger-reference-remediation/execution-plan/${candidate.remediationId}`
);

assert(
  candidatePayload.remediationCandidate.remediationId === candidate.remediationId,
  "Candidate detail endpoint returned the wrong candidate.",
  { candidatePayload, candidate }
);
assert(
  planPayload.executionPlan.advisoryOnly === true &&
    planPayload.executionPlan.mutationAllowed === false,
  "Execution plan must be advisory-only.",
  { executionPlan: planPayload.executionPlan }
);

const missingJustification = await authPost(
  "/api/operations/ledger-reference-remediation/approvals",
  {
    remediationId: candidate.remediationId,
    remediationDecision: "APPROVE",
    correlationId: `qa-ledger-remediation-missing-${candidate.remediationId}`,
  }
);

assert(
  missingJustification.response.status >= 400,
  "Ledger remediation approval should reject missing justification.",
  { status: missingJustification.response.status, body: missingJustification.body }
);

const correlationId = `qa-ledger-remediation-workflow-${candidate.remediationId}`;
const approval = await authPost(
  "/api/operations/ledger-reference-remediation/approvals",
  {
    remediationId: candidate.remediationId,
    remediationDecision: "APPROVE",
    justification:
      "QA operator review records advisory approval for remediation planning only.",
    correlationId,
  }
);

assert(
  approval.response.status === 200 && approval.body.success,
  "Ledger remediation approval failed.",
  { status: approval.response.status, body: approval.body }
);
assert(
  approval.body.approval.metadata.approvalSemanticType ===
    "LEDGER_REFERENCE_REMEDIATION_APPROVAL",
  "Approval semantic type is missing.",
  { approval: approval.body.approval }
);
assert(
  approval.body.candidateAfter.status === "APPROVED" ||
    approval.body.candidateBefore.status === "APPROVED",
  "Approval should produce APPROVED workflow status.",
  { body: approval.body }
);

const repeatedApproval = await authPost(
  "/api/operations/ledger-reference-remediation/approvals",
  {
    remediationId: candidate.remediationId,
    remediationDecision: "APPROVE",
    justification:
      "QA operator review records advisory approval for remediation planning only.",
    correlationId,
  }
);

assert(
  repeatedApproval.response.status === 200 &&
    repeatedApproval.body.success &&
    repeatedApproval.body.idempotent === true &&
    repeatedApproval.body.approval.id === approval.body.approval.id,
  "Ledger remediation approval should be idempotent by correlationId.",
  { first: approval.body, repeated: repeatedApproval.body }
);

const outboxEvent = await findOutboxEvent(approval.body.outboxEventId);

assert(Boolean(outboxEvent), "Ledger remediation approval outbox event was not found.", {
  outboxEventId: approval.body.outboxEventId,
});
assert(
  outboxEvent.event_type ===
    "operations.ledger_reference_remediation.review_recorded",
  "Unexpected remediation outbox event type.",
  { outboxEvent }
);

const baselineAfter = (await authGet("/api/authority/baseline-status")).baselineStatus;
const afterCounts = await snapshotFinancialCounts();

assertPlatformState(baselineAfter);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
  "Ledger remediation workflow mutated financial evidence counts.",
  { beforeCounts, afterCounts }
);

pass("Ledger remediation workflow QA completed.", {
  candidateId: candidate.remediationId,
  approvalId: approval.body.approval.id,
  outboxEventId: approval.body.outboxEventId,
  statusBefore: approval.body.candidateBefore.status,
  statusAfter: approval.body.candidateAfter.status,
  beforeCounts,
  afterCounts,
});
