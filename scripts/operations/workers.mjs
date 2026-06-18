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

  const response = await fetch(`${appUrl}/api/operations/workers`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Worker observability endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const { workers } = payload;

  console.log(`generatedAt: ${workers.generatedAt}`);
  console.log(`heartbeats: ${workers.heartbeats.length}`);
  console.log(`staleWorkers: ${workers.staleWorkers.length}`);
  console.log(`recentMetrics: ${workers.recentMetrics.length}`);
  console.log(`recentFailures: ${workers.recentFailures.length}`);

  for (const heartbeat of workers.heartbeats.slice(0, 10)) {
    console.log(
      `${heartbeat.workerName} ${heartbeat.workloadCategory} ${heartbeat.status} lastSeen=${heartbeat.lastSeenAt}`
    );
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Worker observability failed.");
});
