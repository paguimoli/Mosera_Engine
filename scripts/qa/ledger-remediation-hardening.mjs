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

async function snapshotFinancialEvidenceCounts() {
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
  assertProtected("/api/operations/ledger-immutability-verification"),
  assertProtected("/api/operations/ledger-reference-remediation"),
]);
pass("Ledger remediation hardening APIs require auth.");

const beforeCounts = await snapshotFinancialEvidenceCounts();
const beforeBaseline = (await authGet("/api/authority/baseline-status")).baselineStatus;
const [
  immutabilityPayload,
  referenceAuditPayload,
  remediationPayload,
  platformEvidencePayload,
] = await Promise.all([
  authGet("/api/operations/ledger-immutability-verification"),
  authGet("/api/operations/ledger-reference-audit"),
  authGet("/api/operations/ledger-reference-remediation"),
  authGet("/api/operations/platform-evidence"),
]);
const afterBaseline = (await authGet("/api/authority/baseline-status")).baselineStatus;
const afterCounts = await snapshotFinancialEvidenceCounts();

assertDomainState(beforeBaseline);
assertDomainState(afterBaseline);
assert(
  JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
  "Ledger remediation hardening QA mutated financial evidence counts.",
  { beforeCounts, afterCounts }
);

const immutability = immutabilityPayload.immutabilityVerification;
const referenceAudit = referenceAuditPayload.ledgerReferenceAudit;
const remediation = remediationPayload.remediationReport;
const platformEvidence = platformEvidencePayload.platformEvidence;

assert(
  immutability.verificationScope === "EVIDENCE_ONLY" &&
    immutability.destructiveProbeAttempted === false &&
    immutability.destructiveTriggerCreated === false,
  "Immutability verification attempted destructive behavior.",
  { immutability }
);
assert(
  immutability.guarantees.reversalChainIntact &&
    immutability.guarantees.adjustmentChainIntact,
  "Ledger chain integrity was not verified.",
  { immutability }
);
assert(
  referenceAudit.sampledCreditBackedSettlements >= 0 &&
    referenceAudit.orphanLedgerRecordCount >= 0,
  "Ledger reference audit summary is incomplete.",
  { referenceAudit }
);
assert(
  remediation.appendOnly === true &&
    remediation.persistence.persisted === false &&
    remediation.items.every((item) => item.mutationAllowed === false),
  "Reference remediation report is not evidence-only append-only output.",
  { remediation }
);
assert(
  remediation.itemCount === referenceAudit.issues.length,
  "Remediation report does not correspond to reference audit issues.",
  { remediation, referenceAudit }
);
assert(
  platformEvidence.ledgerReferenceRemediation.reportId === remediation.reportId,
  "Platform evidence did not include remediation report.",
  { platformEvidence, remediation }
);

pass("Ledger immutability and reference remediation hardening QA completed.", {
  immutabilityStatus: immutability.status,
  enforcementMode: immutability.enforcementMode,
  referenceAuditStatus: referenceAudit.status,
  remediationStatus: remediation.status,
  remediationItems: remediation.itemCount,
  platformEvidenceStatus: platformEvidence.status,
  beforeCounts,
  afterCounts,
});
