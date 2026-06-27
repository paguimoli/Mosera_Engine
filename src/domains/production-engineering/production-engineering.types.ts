import type { AuthorityBaselineStatus } from "../authority-baseline/authority-baseline.types";
import type { OperationsMetricsSummary } from "../operations/worker-observability.types";

export type MeasurementStatus = "READY" | "WARNING" | "UNAVAILABLE";

export type LatencyMeasurement = {
  averageMs: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  samples: number;
};

export type EndpointLatency = {
  endpoint: string;
  method: "GET";
  status: MeasurementStatus;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
};

export type HttpLatencyProfile = LatencyMeasurement & {
  fastestEndpoints: EndpointLatency[];
  slowestEndpoints: EndpointLatency[];
  measuredEndpoints: EndpointLatency[];
};

export type DatabaseQueryMeasurement = {
  label: string;
  table: string;
  operation: "COUNT" | "SAMPLE";
  durationMs: number | null;
  rowCount: number | null;
  status: MeasurementStatus;
  error: string | null;
};

export type DatabaseLatencyProfile = {
  averageQueryDurationMs: number | null;
  longestQueries: DatabaseQueryMeasurement[];
  sampledQueries: DatabaseQueryMeasurement[];
  connectionPoolUsage: MeasurementStatus;
  concurrentConnections: number | null;
  readWriteRatio: {
    reads: number;
    writes: number;
    ratio: string;
    methodology: string;
  };
  transactionDurationMs: number | null;
};

export type ThroughputDomainProfile = {
  windowSeconds: number;
  count: number;
  perSecond: number;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
};

export type SystemThroughputProfile = {
  generatedAt: string;
  windowSeconds: number;
  settlement: ThroughputDomainProfile & {
    shadowComparisonAverageMs: number | null;
  };
  ledger: ThroughputDomainProfile & {
    postingLatencyMs: number | null;
  };
  credit: {
    reservations: ThroughputDomainProfile;
    exposureUpdates: ThroughputDomainProfile;
    walletOperations: ThroughputDomainProfile;
  };
  rabbitmq: {
    publishRate: number | null;
    consumeRate: number | null;
    ackRate: number | null;
    queueDepth: number | null;
    consumerLag: number | null;
    messageThroughput: number | null;
  };
  outbox: {
    pending: number;
    publishedPerSecond: number | null;
    publishLatencyMs: number | null;
    retryRate: number | null;
    failedPublishes: number;
    oldestUnpublishedEventAgeSeconds: number | null;
  };
  workers: {
    runningWorkers: number;
    idleWorkers: number;
    staleWorkers: number;
    averageProcessingDurationMs: number | null;
    averageQueueWaitMs: number | null;
  };
};

export type RuntimeProfile = {
  generatedAt: string;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  cpu: {
    userMicroseconds: number;
    systemMicroseconds: number;
    loadAverage: number[];
  };
  uptime: {
    nodeUptimeSeconds: number;
    dockerUptimeSeconds: number | null;
    processStartedAt: string;
  };
  build: {
    buildDurationMs: number | null;
    containerStartupDurationMs: number | null;
    measurement: "ENV_PROVIDED" | "RUNTIME_APPROXIMATION" | "UNAVAILABLE";
  };
};

export type ProductionBottleneck = {
  rank: number;
  area:
    | "HTTP"
    | "DATABASE"
    | "RABBITMQ"
    | "OUTBOX"
    | "SETTLEMENT"
    | "LEDGER"
    | "CREDIT"
    | "WORKERS"
    | "RUNTIME"
    | "BUILD";
  impact: "HIGH" | "MEDIUM" | "LOW";
  metric: string;
  observedValue: string;
  recommendation: string;
};

export type PerformanceBaselineReport = {
  generatedAt: string;
  measurementOnly: true;
  authorityBaseline: AuthorityBaselineStatus;
  http: HttpLatencyProfile;
  database: DatabaseLatencyProfile;
  throughput: SystemThroughputProfile;
  runtime: RuntimeProfile;
  operationsMetrics: OperationsMetricsSummary;
  bottlenecks: ProductionBottleneck[];
  recommendedOptimizationPriority: string[];
};
