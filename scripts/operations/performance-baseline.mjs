import "../qa/load-session-env.mjs";

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

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

const response = await fetch(`${appUrl}/api/operations/performance-baseline`, {
  headers: { authorization: `Bearer ${sessionToken}` },
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || !payload.success) {
  fail("Performance baseline endpoint failed.", {
    status: response.status,
    error: payload.error ?? "unknown",
  });
}

const baseline = payload.performanceBaseline;

console.log(`generatedAt: ${baseline.generatedAt}`);
console.log(`measurementOnly: ${baseline.measurementOnly}`);
console.log(`httpAverageMs: ${baseline.http.averageMs ?? "unavailable"}`);
console.log(`httpP95Ms: ${baseline.http.p95Ms ?? "unavailable"}`);
console.log(`databaseAverageMs: ${baseline.database.averageQueryDurationMs ?? "unavailable"}`);
console.log(`settlementPerSecond: ${baseline.throughput.settlement.perSecond}`);
console.log(`ledgerPerSecond: ${baseline.throughput.ledger.perSecond}`);
console.log(`creditReservationsPerSecond: ${baseline.throughput.credit.reservations.perSecond}`);
console.log(`outboxPending: ${baseline.throughput.outbox.pending}`);
console.log(`outboxPublishedPerSecond: ${baseline.throughput.outbox.publishedPerSecond}`);
console.log(`rabbitmqQueueDepth: ${baseline.throughput.rabbitmq.queueDepth ?? "unavailable"}`);
console.log(`runningWorkers: ${baseline.throughput.workers.runningWorkers}`);
console.log(`staleWorkers: ${baseline.throughput.workers.staleWorkers}`);
console.log(`rssBytes: ${baseline.runtime.memory.rssBytes}`);
console.log("bottlenecks:");
for (const bottleneck of baseline.bottlenecks) {
  console.log(
    `${bottleneck.rank}. ${bottleneck.area} ${bottleneck.impact} ${bottleneck.metric}: ${bottleneck.observedValue}`
  );
}
console.log("recommendedOptimizationPriority:");
for (const item of baseline.recommendedOptimizationPriority) {
  console.log(`- ${item}`);
}
