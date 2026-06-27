import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  RecordWorkerFailureInput,
  RecordWorkerHeartbeatInput,
  RecordWorkerProcessingMetricInput,
  WorkerFailure,
  WorkerHeartbeat,
  WorkerProcessingMetric,
} from "./worker-observability.types";

type WorkerHeartbeatRow = {
  id: string;
  worker_name: string;
  workload_category: WorkerHeartbeat["workloadCategory"];
  instance_id: string;
  status: WorkerHeartbeat["status"];
  last_seen_at: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
};

type WorkerProcessingMetricRow = {
  id: string;
  worker_name: string;
  workload_category: WorkerProcessingMetric["workloadCategory"];
  event_type: string;
  processed_count: number;
  failed_count: number;
  retry_count: number;
  total_processing_ms: number;
  max_processing_ms: number;
  window_start: string;
  window_end: string;
  created_at: string;
};

type WorkerFailureRow = {
  id: string;
  worker_name: string;
  workload_category: WorkerFailure["workloadCategory"];
  event_type: string;
  entity_id?: string | null;
  correlation_id?: string | null;
  error_code?: string | null;
  error_message: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

const HEARTBEAT_SELECT =
  "id, worker_name, workload_category, instance_id, status, last_seen_at, metadata, created_at, updated_at";
const METRIC_SELECT =
  "id, worker_name, workload_category, event_type, processed_count, failed_count, retry_count, total_processing_ms, max_processing_ms, window_start, window_end, created_at";
const FAILURE_SELECT =
  "id, worker_name, workload_category, event_type, entity_id, correlation_id, error_code, error_message, metadata, created_at";

export class WorkerObservabilityRepositoryError extends Error {
  constructor(message = "Worker observability persistence operation failed.") {
    super(message);
    this.name = "WorkerObservabilityRepositoryError";
  }
}

function isMissingRelationError(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.message?.includes("does not exist") ||
    error.message?.includes("schema cache") ||
    error.message?.includes("column")
  );
}

function mapHeartbeat(row: WorkerHeartbeatRow): WorkerHeartbeat {
  return {
    id: row.id,
    workerName: row.worker_name,
    workloadCategory: row.workload_category,
    instanceId: row.instance_id,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

function mapMetric(row: WorkerProcessingMetricRow): WorkerProcessingMetric {
  return {
    id: row.id,
    workerName: row.worker_name,
    workloadCategory: row.workload_category,
    eventType: row.event_type,
    processedCount: row.processed_count,
    failedCount: row.failed_count,
    retryCount: row.retry_count,
    totalProcessingMs: row.total_processing_ms,
    maxProcessingMs: row.max_processing_ms,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    createdAt: row.created_at,
  };
}

function mapFailure(row: WorkerFailureRow): WorkerFailure {
  return {
    id: row.id,
    workerName: row.worker_name,
    workloadCategory: row.workload_category,
    eventType: row.event_type,
    entityId: row.entity_id ?? null,
    correlationId: row.correlation_id ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function upsertWorkerHeartbeat(
  input: RecordWorkerHeartbeatInput
): Promise<WorkerHeartbeat | null> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_heartbeats")
    .upsert(
      {
        worker_name: input.workerName,
        workload_category: input.workloadCategory,
        instance_id: input.instanceId,
        status: input.status,
        last_seen_at: input.lastSeenAt ?? new Date().toISOString(),
        metadata: input.metadata ?? {},
      },
      {
        onConflict: "worker_name,instance_id",
      }
    )
    .select(HEARTBEAT_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error)) {
      return null;
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return mapHeartbeat(data as WorkerHeartbeatRow);
}

export async function insertWorkerProcessingMetric(
  input: RecordWorkerProcessingMetricInput
): Promise<WorkerProcessingMetric | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseServerAdmin
    .from("worker_processing_metrics")
    .insert({
      worker_name: input.workerName,
      workload_category: input.workloadCategory,
      event_type: input.eventType,
      processed_count: input.processedCount ?? 0,
      failed_count: input.failedCount ?? 0,
      retry_count: input.retryCount ?? 0,
      total_processing_ms: input.totalProcessingMs ?? 0,
      max_processing_ms: input.maxProcessingMs ?? 0,
      window_start: input.windowStart ?? now,
      window_end: input.windowEnd ?? now,
    })
    .select(METRIC_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error)) {
      return null;
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return mapMetric(data as WorkerProcessingMetricRow);
}

export async function insertWorkerFailure(
  input: RecordWorkerFailureInput
): Promise<WorkerFailure | null> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_failures")
    .insert({
      worker_name: input.workerName,
      workload_category: input.workloadCategory,
      event_type: input.eventType,
      entity_id: input.entityId ?? null,
      correlation_id: input.correlationId ?? null,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage,
      metadata: input.metadata ?? {},
    })
    .select(FAILURE_SELECT)
    .single();

  if (error) {
    if (isMissingRelationError(error)) {
      return null;
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return mapFailure(data as WorkerFailureRow);
}

export async function listWorkerHeartbeats(
  limit = 100
): Promise<WorkerHeartbeat[]> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_heartbeats")
    .select(HEARTBEAT_SELECT)
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return ((data ?? []) as WorkerHeartbeatRow[]).map(mapHeartbeat);
}

export async function listFreshWorkerHeartbeats({
  since,
  limit = 50,
}: {
  since: string;
  limit?: number;
}): Promise<WorkerHeartbeat[]> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_heartbeats")
    .select(HEARTBEAT_SELECT)
    .gte("last_seen_at", since)
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return ((data ?? []) as WorkerHeartbeatRow[]).map(mapHeartbeat);
}

export async function listStaleWorkerHeartbeats({
  before,
  limit = 50,
}: {
  before: string;
  limit?: number;
}): Promise<WorkerHeartbeat[]> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_heartbeats")
    .select(HEARTBEAT_SELECT)
    .lt("last_seen_at", before)
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return ((data ?? []) as WorkerHeartbeatRow[]).map(mapHeartbeat);
}

export async function listRecentWorkerProcessingMetrics(
  limit = 100
): Promise<WorkerProcessingMetric[]> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_processing_metrics")
    .select(METRIC_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return ((data ?? []) as WorkerProcessingMetricRow[]).map(mapMetric);
}

export async function listRecentWorkerFailures(
  limit = 100
): Promise<WorkerFailure[]> {
  const { data, error } = await supabaseServerAdmin
    .from("worker_failures")
    .select(FAILURE_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }

    throw new WorkerObservabilityRepositoryError(error.message);
  }

  return ((data ?? []) as WorkerFailureRow[]).map(mapFailure);
}
