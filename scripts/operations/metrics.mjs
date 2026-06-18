const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

async function main() {
  if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

  const response = await fetch(`${appUrl}/api/operations/metrics`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Operations metrics endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const { metrics } = payload;

  console.log(`generatedAt: ${metrics.generatedAt}`);
  console.log(`lagSeverity: ${metrics.lag.severity}`);
  console.log(`lagReasons: ${metrics.lag.reasons.join("; ") || "none"}`);
  console.log(`outboxPending: ${metrics.outbox.pendingCount}`);
  console.log(`outboxFailed: ${metrics.outbox.failedCount}`);
  console.log(`outboxDeadLetter: ${metrics.outbox.deadLetterCount}`);
  console.log(`outboxRetryCount: ${metrics.outbox.retryCount}`);
  console.log(`workerHeartbeats: ${metrics.workers.heartbeats.length}`);
  console.log(`recentWorkerFailures: ${metrics.workers.recentFailures.length}`);
  console.log(`queueCount: ${metrics.queues.length}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Operations metrics failed.");
});
