import "../qa/load-session-env.mjs";

const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;
const compareWindowMs = parseCompareWindowMs();

function parseCompareWindowMs() {
  const index = process.argv.indexOf("--compare-window-ms");
  const rawValue =
    index >= 0 ? process.argv[index + 1] : process.env.PERFORMANCE_COMPARE_WINDOW_MS;
  const value = Number(rawValue ?? 10000);

  return Number.isFinite(value) && value >= 0 ? value : 10000;
}

function fail(message, metadata = {}) {
  console.error(message);
  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }
  process.exit(1);
}

if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits = 3) {
  const multiplier = 10 ** digits;

  return Math.round(value * multiplier) / multiplier;
}

function delta(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) {
    return null;
  }

  return round(after - before);
}

function improvementPercent(before, after, direction = "increase") {
  if (
    before === null ||
    before === undefined ||
    after === null ||
    after === undefined ||
    before === 0
  ) {
    return null;
  }

  const raw =
    direction === "decrease"
      ? ((before - after) / before) * 100
      : ((after - before) / before) * 100;

  return round(raw);
}

async function fetchBaseline() {
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

  return payload.performanceBaseline;
}

const before = await fetchBaseline();
if (compareWindowMs > 0) {
  await sleep(compareWindowMs);
}
const after = await fetchBaseline();

const elapsedSeconds = compareWindowMs / 1000;
const pendingDelta = delta(before.throughput.outbox.pending, after.throughput.outbox.pending);
const queueDepthDelta = delta(
  before.throughput.rabbitmq.queueDepth,
  after.throughput.rabbitmq.queueDepth
);
const processedDelta = delta(
  before.operationsMetrics.workers.processedJobs,
  after.operationsMetrics.workers.processedJobs
);
const publishedDelta = delta(
  before.operationsMetrics.outbox.publishedCount,
  after.operationsMetrics.outbox.publishedCount
);
const latestHeartbeatAgeSeconds = after.operationsMetrics.workers.lastHeartbeat?.lastSeenAt
  ? round(
      (Date.now() -
        new Date(after.operationsMetrics.workers.lastHeartbeat.lastSeenAt).getTime()) /
        1000
    )
  : null;

console.log(`measurementWindowMs: ${compareWindowMs}`);
console.log(`beforeGeneratedAt: ${before.generatedAt}`);
console.log(`afterGeneratedAt: ${after.generatedAt}`);
console.log(`measurementOnly: ${after.measurementOnly}`);
console.log(`authoritySettlement: ${after.authorityBaseline.settlement.authority}/${after.authorityBaseline.settlement.certificationStatus}`);
console.log(`authorityLedger: ${after.authorityBaseline.ledger.authority}/${after.authorityBaseline.ledger.certificationStatus}`);
console.log(`authorityCredit: ${after.authorityBaseline.credit.authority}/${after.authorityBaseline.credit.certificationStatus}`);
console.log(`httpAverageMsBefore: ${before.http.averageMs ?? "unavailable"}`);
console.log(`httpAverageMsAfter: ${after.http.averageMs ?? "unavailable"}`);
console.log(`httpAverageImprovementPercent: ${improvementPercent(before.http.averageMs, after.http.averageMs, "decrease") ?? "unavailable"}`);
console.log(`databaseAverageMsBefore: ${before.database.averageQueryDurationMs ?? "unavailable"}`);
console.log(`databaseAverageMsAfter: ${after.database.averageQueryDurationMs ?? "unavailable"}`);
console.log(`databaseAverageImprovementPercent: ${improvementPercent(before.database.averageQueryDurationMs, after.database.averageQueryDurationMs, "decrease") ?? "unavailable"}`);
console.log("databaseSummary:");
console.log(`databaseTelemetryAverageMs: ${after.databasePerformance?.latency?.averageMs ?? "unavailable"}`);
console.log(`databaseTelemetryMedianMs: ${after.databasePerformance?.latency?.medianMs ?? "unavailable"}`);
console.log(`databaseTelemetryP95Ms: ${after.databasePerformance?.latency?.p95Ms ?? "unavailable"}`);
console.log(`databaseTelemetryP99Ms: ${after.databasePerformance?.latency?.p99Ms ?? "unavailable"}`);
console.log(`databaseTelemetryMaxMs: ${after.databasePerformance?.latency?.maxMs ?? "unavailable"}`);
console.log(`databaseReadWriteRatio: ${after.databasePerformance?.latency?.readWriteRatio ?? "unavailable"}`);
console.log("connectionPoolSummary:");
console.log(`connectionPoolStatus: ${after.databasePerformance?.connections?.status ?? "unavailable"}`);
console.log(`poolUtilization: ${after.databasePerformance?.connections?.poolUtilization ?? "unavailable"}`);
console.log(`activeConnections: ${after.databasePerformance?.connections?.activeConnections ?? "unavailable"}`);
console.log(`waitingConnections: ${after.databasePerformance?.connections?.waitingConnections ?? "unavailable"}`);
console.log("nativeDbTelemetry:");
console.log(`nativeTelemetryStatus: ${after.databaseObservability?.nativeStatus?.status ?? "unavailable"}`);
console.log(`nativeTelemetrySource: ${after.databaseObservability?.nativeStatus?.source ?? "unavailable"}`);
console.log(`nativeActiveSessions: ${after.databaseObservability?.nativeStatus?.sessions?.active ?? "unavailable"}`);
console.log(`nativeIdleSessions: ${after.databaseObservability?.nativeStatus?.sessions?.idle ?? "unavailable"}`);
console.log(`nativeWaitingSessions: ${after.databaseObservability?.nativeStatus?.sessions?.waiting ?? "unavailable"}`);
console.log(`nativeLockWaits: ${after.databaseObservability?.lockAnalysis?.lockWaits ?? "unavailable"}`);
console.log("sessionStatistics:");
console.log(`sessionStatus: ${after.databaseObservability?.sessionAnalysis?.status ?? "unavailable"}`);
console.log(`activeSessions: ${after.databaseObservability?.sessionAnalysis?.activeSessions ?? "unavailable"}`);
console.log(`idleSessions: ${after.databaseObservability?.sessionAnalysis?.idleSessions ?? "unavailable"}`);
console.log(`waitingSessions: ${after.databaseObservability?.sessionAnalysis?.waitingSessions ?? "unavailable"}`);
console.log("explainPlanSummary:");
console.log(`explainStatus: ${after.databaseObservability?.explainPlans?.status ?? "unavailable"}`);
for (const plan of after.databaseObservability?.explainPlans?.plans?.slice(0, 5) ?? []) {
  console.log(`- ${plan.label} ${plan.status} table=${plan.table} planAvailable=${plan.planAvailable}`);
}
console.log("repositoryTiming:");
for (const item of after.databaseObservability?.timing?.repositoryTiming?.slice(0, 5) ?? []) {
  console.log(`- ${item.rank}. ${item.name} cumulativeDbTimeMs=${item.cumulativeDbTimeMs ?? "unavailable"}`);
}
console.log("endpointTiming:");
for (const item of after.databaseObservability?.timing?.endpointTiming?.slice(0, 5) ?? []) {
  console.log(`- ${item.rank}. ${item.name} dbTimeMs=${item.dbTimeMs ?? "unavailable"} totalRequestTimeMs=${item.totalRequestTimeMs ?? "unavailable"}`);
}
console.log("visibilityLimitations:");
for (const limitation of after.databaseObservability?.limitations?.slice(0, 5) ?? []) {
  console.log(`- ${limitation}`);
}
console.log("transactionSummary:");
console.log(`transactionStatus: ${after.databasePerformance?.transactions?.status ?? "unavailable"}`);
console.log(`transactionCount: ${after.databasePerformance?.transactions?.transactionCount ?? "unavailable"}`);
console.log(`averageTransactionMs: ${after.databasePerformance?.transactions?.averageTransactionDurationMs ?? "unavailable"}`);
console.log("slowQuerySummary:");
for (const query of after.databasePerformance?.slowQueries?.topSlowQueries?.slice(0, 5) ?? []) {
  console.log(`- ${query.label} ${query.durationMs ?? "unavailable"}ms ${query.table}`);
}
console.log("repositoryHotspots:");
for (const hotspot of after.databasePerformance?.repositoryHotspots?.slice(0, 5) ?? []) {
  console.log(`- ${hotspot.rank}. ${hotspot.name} indicators=${hotspot.queryCount}`);
}
console.log("apiHotspots:");
for (const hotspot of after.databasePerformance?.apiHotspots?.slice(0, 5) ?? []) {
  console.log(`- ${hotspot.rank}. ${hotspot.name} indicators=${hotspot.queryCount}`);
}
console.log(`outboxPendingBefore: ${before.throughput.outbox.pending}`);
console.log(`outboxPendingAfter: ${after.throughput.outbox.pending}`);
console.log(`outboxPendingDelta: ${pendingDelta ?? "unavailable"}`);
console.log(`outboxBacklogImprovementPercent: ${improvementPercent(before.throughput.outbox.pending, after.throughput.outbox.pending, "decrease") ?? "unavailable"}`);
console.log(`outboxPublishedPerSecondBefore: ${before.throughput.outbox.publishedPerSecond}`);
console.log(`outboxPublishedPerSecondAfter: ${after.throughput.outbox.publishedPerSecond}`);
console.log(`outboxPublishedDelta: ${publishedDelta ?? "unavailable"}`);
console.log(`outboxThroughputDuringWindow: ${elapsedSeconds > 0 && publishedDelta !== null ? round(publishedDelta / elapsedSeconds, 6) : "unavailable"}`);
console.log(`dispatcherLatencyMs: ${after.operationsMetrics.outbox.dispatchLatency.averageMs ?? after.throughput.outbox.publishLatencyMs ?? "unavailable"}`);
console.log(`rabbitmqQueueDepthBefore: ${before.throughput.rabbitmq.queueDepth ?? "unavailable"}`);
console.log(`rabbitmqQueueDepthAfter: ${after.throughput.rabbitmq.queueDepth ?? "unavailable"}`);
console.log(`queueDepthDelta: ${queueDepthDelta ?? "unavailable"}`);
console.log(`queueDrainRateDuringWindow: ${elapsedSeconds > 0 && queueDepthDelta !== null ? round(-queueDepthDelta / elapsedSeconds, 6) : "unavailable"}`);
console.log(`runningWorkersBefore: ${before.throughput.workers.runningWorkers}`);
console.log(`runningWorkersAfter: ${after.throughput.workers.runningWorkers}`);
console.log(`staleWorkersBefore: ${before.throughput.workers.staleWorkers}`);
console.log(`staleWorkersAfter: ${after.throughput.workers.staleWorkers}`);
console.log(`workerProcessedJobsDelta: ${processedDelta ?? "unavailable"}`);
console.log(`workerThroughputDuringWindow: ${elapsedSeconds > 0 && processedDelta !== null ? round(processedDelta / elapsedSeconds, 6) : "unavailable"}`);
console.log(`heartbeatFreshnessSeconds: ${latestHeartbeatAgeSeconds ?? "unavailable"}`);
console.log(`rssBytes: ${after.runtime.memory.rssBytes}`);
console.log("bottlenecks:");
for (const bottleneck of after.bottlenecks) {
  console.log(
    `${bottleneck.rank}. ${bottleneck.area} ${bottleneck.impact} ${bottleneck.metric}: ${bottleneck.observedValue}`
  );
}
console.log("recommendedOptimizationPriority:");
for (const item of after.recommendedOptimizationPriority) {
  console.log(`- ${item}`);
}
