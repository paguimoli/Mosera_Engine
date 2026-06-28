import "../qa/load-session-env.mjs";

const appUrl =
  process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
let sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function ensureSessionToken() {
  if (sessionToken) {
    const { response } = await requestJson("/api/auth/me", {
      headers: { authorization: `Bearer ${sessionToken}` },
    });

    if (response.ok) return;
  }

  if (!adminPassword) {
    fail("OPS_ADMIN_SESSION_TOKEN, QA_ADMIN_SESSION_TOKEN, or QA_ADMIN_PASSWORD is required.");
  }

  const { response, body } = await requestJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  if (!response.ok || body?.success !== true || !body.sessionToken) {
    fail("Unable to establish admin session.", { status: response.status, body });
  }

  sessionToken = body.sessionToken;
}

function likelySourceForStep(step) {
  switch (step) {
    case "AUTH_SESSION_CONTEXT":
      return "Supabase session context evidence read.";
    case "WALLET_EVIDENCE":
      return "Credit reservation evidence aggregation.";
    case "CREDIT_EVIDENCE":
      return "Credit reserve/release evidence aggregation.";
    case "TICKET_EVIDENCE":
      return "Ticket evidence aggregation.";
    case "SETTLEMENT_EVIDENCE":
      return "Credit settlement application evidence aggregation.";
    case "LEDGER_EVIDENCE":
      return "Ledger evidence aggregation.";
    case "OUTBOX_EVIDENCE":
    case "RABBITMQ_EVIDENCE":
      return "Outbox/RabbitMQ evidence aggregation.";
    case "WORKER_EVIDENCE":
      return "Worker heartbeat evidence aggregation.";
    case "DATABASE_EVIDENCE":
      return "Financial ledger database evidence read.";
    case "SERVICE_HEALTH_CALLS":
      return "Service health probe.";
    default:
      return "Unknown evidence source.";
  }
}

function recommendationForStep(step, p95LatencyMs) {
  if (typeof p95LatencyMs !== "number") {
    return {
      recommendation: "Continue measuring until P95 is available.",
      safeForCurrentPhase: false,
    };
  }

  if (p95LatencyMs < 1000) {
    return {
      recommendation: "No narrow fix required; retain measurement as baseline.",
      safeForCurrentPhase: false,
    };
  }

  if (step === "WALLET_EVIDENCE" || step === "CREDIT_EVIDENCE") {
    return {
      recommendation: "Already optimized in Phase 20.1; repeat measurement before additional changes.",
      safeForCurrentPhase: false,
    };
  }

  return {
    recommendation:
      "Defer narrow read-path optimization to Phase 20.3 after confirming repeatability.",
    safeForCurrentPhase: false,
  };
}

await ensureSessionToken();

const { response, body } = await requestJson("/api/operations/concurrency-baseline", {
  headers: { authorization: `Bearer ${sessionToken}` },
});

if (!response.ok || body?.success !== true) {
  fail("Concurrency baseline endpoint failed.", { status: response.status, body });
}

const baseline = body.concurrencyBaseline;
const ranked = baseline.scenarios
  .flatMap((scenario) =>
    scenario.stepMeasurements.map((step) => {
      const guidance = recommendationForStep(step.step, step.p95LatencyMs);

      return {
        scenario: scenario.scenario,
        scenarioLabel: scenario.label,
        concurrency: scenario.concurrency,
        step: step.step,
        stepLabel: step.label,
        averageLatencyMs: step.averageLatencyMs,
        medianLatencyMs: step.medianLatencyMs,
        p95LatencyMs: step.p95LatencyMs,
        p99LatencyMs: step.p99LatencyMs,
        maxLatencyMs: step.maxLatencyMs,
        sampleCount: step.sampleCount,
        throughputPerSecond: step.throughputPerSecond,
        errorCount: step.errorCount,
        likelySource: likelySourceForStep(step.step),
        optimizationRecommendation: guidance.recommendation,
        safeForCurrentPhase: guidance.safeForCurrentPhase,
      };
    })
  )
  .sort((left, right) => {
    const p95Delta = (right.p95LatencyMs ?? -1) - (left.p95LatencyMs ?? -1);

    if (p95Delta !== 0) return p95Delta;

    return (right.p99LatencyMs ?? -1) - (left.p99LatencyMs ?? -1);
  });

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      measurementOnly: true,
      slowest: ranked[0] ?? null,
      topSlowestScenarioStepPairs: ranked.slice(0, 10),
      baselineBottleneckBreakdown: baseline.bottleneckBreakdown,
      bottlenecks: baseline.bottlenecks,
      authority: baseline.authority,
      queue: baseline.queue,
    },
    null,
    2
  )
);
