import type { QueueWorkloadCategory } from "@/src/lib/queue/queue-topology";
import type { OutboxHealthSummary, RabbitMqQueueHealth } from "./queue-health.types";

export type WorkerHeartbeatStatus = "ACTIVE" | "IDLE" | "DEGRADED" | "STOPPED";

export type WorkerHeartbeat = {
  id: string;
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  instanceId: string;
  status: WorkerHeartbeatStatus;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string | null;
};

export type WorkerProcessingMetric = {
  id: string;
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  eventType: string;
  processedCount: number;
  failedCount: number;
  retryCount: number;
  totalProcessingMs: number;
  maxProcessingMs: number;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
};

export type WorkerFailure = {
  id: string;
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  eventType: string;
  entityId: string | null;
  correlationId: string | null;
  errorCode: string | null;
  errorMessage: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RecordWorkerHeartbeatInput = {
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  instanceId: string;
  status: WorkerHeartbeatStatus;
  lastSeenAt?: string;
  metadata?: Record<string, unknown>;
};

export type RecordWorkerProcessingMetricInput = {
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  eventType: string;
  processedCount?: number;
  failedCount?: number;
  retryCount?: number;
  totalProcessingMs?: number;
  maxProcessingMs?: number;
  windowStart?: string;
  windowEnd?: string;
};

export type RecordWorkerFailureInput = {
  workerName: string;
  workloadCategory: QueueWorkloadCategory;
  eventType: string;
  entityId?: string | null;
  correlationId?: string | null;
  errorCode?: string | null;
  errorMessage: string;
  metadata?: Record<string, unknown>;
};

export type LagSeverity = "HEALTHY" | "WARNING" | "CRITICAL" | "DEGRADED";

export type LagClassification = {
  severity: LagSeverity;
  reasons: string[];
  thresholds: {
    outboxWarningAgeSeconds: number;
    outboxCriticalAgeSeconds: number;
    queueWarningReadyCount: number;
    criticalQueueCriticalReadyCount: number;
    heartbeatStaleSeconds: number;
  };
};

export type OutboxObservabilitySummary = OutboxHealthSummary & {
  retryCount: number;
  publishedCount: number;
  averagePublishLatencyMs: number | null;
  maxPublishLatencyMs: number | null;
  dispatchLatency: {
    averageMs: number | null;
    maxMs: number | null;
  };
  oldestUnpublishedEvent: {
    createdAt: string | null;
    ageSeconds: number | null;
  };
  stalledPublisher: {
    detected: boolean;
    reason: string;
  };
  recommendation: "READY" | "WARNING" | "ACTION_REQUIRED";
  workloadDistribution: Array<{
    workloadCategory: QueueWorkloadCategory;
    pendingCount: number;
    failedCount: number;
    deadLetterCount: number;
  }>;
};

export type WorkerObservabilitySummary = {
  generatedAt: string;
  heartbeats: WorkerHeartbeat[];
  freshHeartbeats: WorkerHeartbeat[];
  recentMetrics: WorkerProcessingMetric[];
  recentFailures: WorkerFailure[];
  staleWorkers: WorkerHeartbeat[];
  staleHeartbeatEvidence: WorkerHeartbeat[];
  lastHeartbeat: WorkerHeartbeat | null;
  activeWorkerObserved: boolean;
  processedJobs: number;
  workerDetails: Array<{
    workerName: string;
    instanceId: string;
    workloadCategory: QueueWorkloadCategory;
    status: WorkerHeartbeatStatus;
    lastSeenAt: string;
    workerVersion: string | null;
    hostname: string | null;
    uptimeSeconds: number | null;
    processedJobs: number;
  }>;
};

export type OperationsMetricsSummary = {
  generatedAt: string;
  outbox: OutboxObservabilitySummary;
  queues: RabbitMqQueueHealth[];
  workers: WorkerObservabilitySummary;
  lag: LagClassification;
  bestEffortMetrics: true;
};
