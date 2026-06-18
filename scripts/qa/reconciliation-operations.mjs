import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken = process.env.QA_ADMIN_SESSION_TOKEN;
const correlationId = `qa-reconciliation-ops-${Date.now()}`;

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const assertions = [];

function fail(message, metadata = {}) {
  console.error("QA assertion failed.");
  console.error(`correlationId: ${correlationId}`);
  console.error(`reason: ${message}`);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

function pass(message) {
  assertions.push(message);
  console.log(`PASS: ${message}`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      authorization: `Bearer ${sessionToken}`,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  return { response, payload };
}

function requireEnvironment() {
  if (!sessionToken) {
    fail("QA_ADMIN_SESSION_TOKEN is required.");
  }

  if (!supabaseUrl || !serviceRoleKey) {
    fail("SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
}

function createQaSupabaseClient() {
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

async function createControlledFinding() {
  const supabase = createQaSupabaseClient();

  const { data: run, error: runError } = await supabase
    .from("reconciliation_runs")
    .insert({
      run_type: "FULL",
      scope_type: "GLOBAL",
      currency: "CRC",
      status: "COMPLETED",
      total_checks: 1,
      passed_checks: 0,
      failed_checks: 0,
      warning_checks: 1,
      review_status: "REQUIRES_ATTENTION",
      severity_summary: { pass: 0, warning: 1, fail: 0 },
      correlation_id: correlationId,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (runError || !run) {
    fail("Unable to create controlled reconciliation run.", {
      error: runError?.message ?? "No run returned",
    });
  }

  const { data: finding, error: findingError } = await supabase
    .from("reconciliation_run_findings")
    .insert({
      run_id: run.id,
      severity: "WARNING",
      check_code: "QA_CONTROLLED_RECONCILIATION_FINDING",
      entity_type: "qa_reconciliation_operations",
      entity_id: correlationId,
      currency: "CRC",
      message: "Controlled QA finding for reconciliation operations workflow.",
      metadata: { correlationId },
    })
    .select("id")
    .single();

  if (findingError || !finding) {
    fail("Unable to create controlled reconciliation finding.", {
      runId: run.id,
      error: findingError?.message ?? "No finding returned",
    });
  }

  return finding.id;
}

async function getFindingForReview() {
  const open = await requestJson("/api/reconciliation/operations/open-findings?limit=50");

  if (!open.response.ok || !open.payload.success) {
    fail("Open findings endpoint failed.", {
      status: open.response.status,
      error: open.payload.error ?? "",
    });
  }

  const actionable = open.payload.findings?.find(
    (finding) => finding.severity === "WARNING" || finding.severity === "FAIL"
  );

  if (actionable?.id) {
    return actionable.id;
  }

  return createControlledFinding();
}

async function assertOutboxEvent(eventType, aggregateId) {
  const supabase = createQaSupabaseClient();
  const { data, error } = await supabase
    .from("outbox_events")
    .select("id")
    .eq("event_type", eventType)
    .eq("aggregate_id", aggregateId)
    .limit(1);

  if (error) {
    fail("Unable to verify reconciliation outbox event.", {
      eventType,
      aggregateId,
      error: error.message,
    });
  }

  if (!data || data.length === 0) {
    fail("Expected reconciliation outbox event was not found.", {
      eventType,
      aggregateId,
    });
  }
}

async function main() {
  requireEnvironment();

  const runResponse = await requestJson("/api/reconciliation/run", {
    method: "POST",
    body: JSON.stringify({
      runType: "FULL",
      scopeType: "GLOBAL",
      currency: "CRC",
    }),
  });

  if (!runResponse.response.ok || !runResponse.payload.success) {
    fail("Reconciliation run endpoint failed.", {
      status: runResponse.response.status,
      error: runResponse.payload.error ?? runResponse.payload.errors?.join(" ") ?? "",
    });
  }

  pass("Reconciliation run executed.");

  const summary = await requestJson("/api/reconciliation/operations/summary");

  if (!summary.response.ok || !summary.payload.success) {
    fail("Operations summary endpoint failed.", {
      status: summary.response.status,
      error: summary.payload.error ?? "",
    });
  }

  pass("Operations summary fetched.");

  const findingId = await getFindingForReview();
  const acknowledge = await requestJson(
    `/api/reconciliation/findings/${findingId}/acknowledge`,
    {
      method: "POST",
      body: JSON.stringify({
        notes: "QA acknowledgement for operational reconciliation workflow.",
      }),
    }
  );

  if (!acknowledge.response.ok || !acknowledge.payload.success) {
    fail("Finding acknowledgement failed.", {
      findingId,
      status: acknowledge.response.status,
      error: acknowledge.payload.error ?? acknowledge.payload.errors?.join(" ") ?? "",
    });
  }

  pass("Finding acknowledged.");

  const resolve = await requestJson(
    `/api/reconciliation/findings/${findingId}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        notes:
          "QA resolution confirms no financial state is modified by review metadata.",
      }),
    }
  );

  if (!resolve.response.ok || !resolve.payload.success) {
    fail("Finding resolution failed.", {
      findingId,
      status: resolve.response.status,
      error: resolve.payload.error ?? resolve.payload.errors?.join(" ") ?? "",
    });
  }

  pass("Finding resolved.");

  const reviewedRun = await requestJson(
    `/api/reconciliation/run/${runResponse.payload.run.id}/review`,
    {
      method: "POST",
      body: JSON.stringify({ reviewStatus: "REVIEWED" }),
    }
  );

  if (!reviewedRun.response.ok || !reviewedRun.payload.success) {
    fail("Run review failed.", {
      runId: runResponse.payload.run.id,
      status: reviewedRun.response.status,
      error: reviewedRun.payload.error ?? reviewedRun.payload.errors?.join(" ") ?? "",
    });
  }

  pass("Reconciliation run reviewed.");

  await assertOutboxEvent("reconciliation.finding.acknowledged", findingId);
  await assertOutboxEvent("reconciliation.finding.resolved", findingId);
  await assertOutboxEvent(
    "reconciliation.run.reviewed",
    runResponse.payload.run.id
  );
  pass("Outbox events verified.");

  console.log(`correlationId: ${correlationId}`);
  console.log(`assertionsPassed: ${assertions.length}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Reconciliation operations QA failed.");
});
