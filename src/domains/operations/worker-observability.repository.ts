import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import {
  createResilientPostgresPool,
  queryWithBoundedReconnect,
} from "@/src/lib/database/resilient-postgres-pool";
import type {
  RecordWorkerFailureInput,
  RecordWorkerHeartbeatInput,
  RecordWorkerProcessingMetricInput,
  WorkerFailure,
  WorkerHeartbeat,
  WorkerProcessingMetric,
} from "./worker-observability.types";

type Timestamp = Date | string;

type WorkerHeartbeatRow = QueryResultRow & {
  id: string;
  worker_name: string;
  workload_category: WorkerHeartbeat["workloadCategory"];
  instance_id: string;
  status: WorkerHeartbeat["status"];
  last_seen_at: Timestamp;
  metadata: Record<string, unknown> | null;
  created_at: Timestamp;
  updated_at: Timestamp | null;
};

type WorkerProcessingMetricRow = QueryResultRow & {
  id: string;
  worker_name: string;
  workload_category: WorkerProcessingMetric["workloadCategory"];
  event_type: string;
  processed_count: number;
  failed_count: number;
  retry_count: number;
  total_processing_ms: number;
  max_processing_ms: number;
  window_start: Timestamp;
  window_end: Timestamp;
  created_at: Timestamp;
};

type WorkerFailureRow = QueryResultRow & {
  id: string;
  worker_name: string;
  workload_category: WorkerFailure["workloadCategory"];
  event_type: string;
  entity_id: string | null;
  correlation_id: string | null;
  error_code: string | null;
  error_message: string;
  metadata: Record<string, unknown> | null;
  created_at: Timestamp;
};

export type OutboxObservabilityRow = {
  event_type: string;
  status: "PENDING" | "PUBLISHED" | "FAILED" | "DEAD_LETTER";
  attempt_count: number;
  created_at: string;
  published_at: string | null;
};

export type OutboxObservabilitySnapshot = {
  pendingCount: number;
  failedCount: number;
  deadLetterCount: number;
  publishedCount: number;
  failedJobCount: number;
  oldestCreatedAt: string | null;
  rows: OutboxObservabilityRow[];
};

let pool: ReturnType<typeof createResilientPostgresPool> | null = null;

export class WorkerObservabilityRepositoryError extends Error {
  constructor(message = "Worker observability persistence operation failed.") {
    super(message);
    this.name = "WorkerObservabilityRepositoryError";
  }
}

function iso(value: Timestamp | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function databasePool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new WorkerObservabilityRepositoryError(
      "DATABASE_URL is required for canonical worker observability."
    );
  }

  pool ??= createResilientPostgresPool("worker-observability", {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    max: 4,
  });
  return pool;
}

async function query<Row extends QueryResultRow>(
  statement: string,
  values: readonly unknown[] = []
) {
  try {
    return await queryWithBoundedReconnect<Row>(
      databasePool(),
      "worker-observability",
      statement,
      values
    );
  } catch (error) {
    throw new WorkerObservabilityRepositoryError(
      error instanceof Error ? error.message : undefined
    );
  }
}

function mapHeartbeat(row: WorkerHeartbeatRow): WorkerHeartbeat {
  return {
    id: row.id,
    workerName: row.worker_name,
    workloadCategory: row.workload_category,
    instanceId: row.instance_id,
    status: row.status,
    lastSeenAt: iso(row.last_seen_at)!,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at),
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
    windowStart: iso(row.window_start)!,
    windowEnd: iso(row.window_end)!,
    createdAt: iso(row.created_at)!,
  };
}

function mapFailure(row: WorkerFailureRow): WorkerFailure {
  return {
    id: row.id,
    workerName: row.worker_name,
    workloadCategory: row.workload_category,
    eventType: row.event_type,
    entityId: row.entity_id,
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
  };
}

export async function upsertWorkerHeartbeat(
  input: RecordWorkerHeartbeatInput
): Promise<WorkerHeartbeat> {
  const result = await query<WorkerHeartbeatRow>(
    `
insert into public.worker_heartbeats (
  worker_name, workload_category, instance_id, status, last_seen_at, metadata
)
values ($1, $2, $3, $4, $5, $6::jsonb)
on conflict (worker_name, instance_id) do update set
  workload_category = excluded.workload_category,
  status = excluded.status,
  last_seen_at = excluded.last_seen_at,
  metadata = excluded.metadata
returning *
`,
    [
      input.workerName,
      input.workloadCategory,
      input.instanceId,
      input.status,
      input.lastSeenAt ?? new Date().toISOString(),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return mapHeartbeat(result.rows[0]);
}

export async function insertWorkerProcessingMetric(
  input: RecordWorkerProcessingMetricInput
): Promise<WorkerProcessingMetric> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = await query<WorkerProcessingMetricRow>(
    `
with inserted as (
  insert into public.worker_processing_metrics (
    id, worker_name, workload_category, event_type, processed_count,
    failed_count, retry_count, total_processing_ms, max_processing_ms,
    window_start, window_end
  ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  on conflict (id) do nothing
  returning *
)
select * from inserted
union all
select * from public.worker_processing_metrics where id = $1::uuid
limit 1
`,
    [
      id,
      input.workerName,
      input.workloadCategory,
      input.eventType,
      input.processedCount ?? 0,
      input.failedCount ?? 0,
      input.retryCount ?? 0,
      input.totalProcessingMs ?? 0,
      input.maxProcessingMs ?? 0,
      input.windowStart ?? now,
      input.windowEnd ?? now,
    ]
  );
  return mapMetric(result.rows[0]);
}

export async function insertWorkerFailure(
  input: RecordWorkerFailureInput
): Promise<WorkerFailure> {
  const id = randomUUID();
  const result = await query<WorkerFailureRow>(
    `
with inserted as (
  insert into public.worker_failures (
    id, worker_name, workload_category, event_type, entity_id,
    correlation_id, error_code, error_message, metadata
  ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  on conflict (id) do nothing
  returning *
)
select * from inserted
union all
select * from public.worker_failures where id = $1::uuid
limit 1
`,
    [
      id,
      input.workerName,
      input.workloadCategory,
      input.eventType,
      input.entityId ?? null,
      input.correlationId ?? null,
      input.errorCode ?? null,
      input.errorMessage,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return mapFailure(result.rows[0]);
}

export async function listWorkerHeartbeats(limit = 100) {
  const result = await query<WorkerHeartbeatRow>(
    "select * from public.worker_heartbeats order by last_seen_at desc limit $1",
    [limit]
  );
  return result.rows.map(mapHeartbeat);
}

export async function listFreshWorkerHeartbeats({
  since,
  limit = 50,
}: {
  since: string;
  limit?: number;
}) {
  const result = await query<WorkerHeartbeatRow>(
    "select * from public.worker_heartbeats where last_seen_at >= $1 order by last_seen_at desc limit $2",
    [since, limit]
  );
  return result.rows.map(mapHeartbeat);
}

export async function listStaleWorkerHeartbeats({
  before,
  limit = 50,
}: {
  before: string;
  limit?: number;
}) {
  const result = await query<WorkerHeartbeatRow>(
    "select * from public.worker_heartbeats where last_seen_at < $1 order by last_seen_at desc limit $2",
    [before, limit]
  );
  return result.rows.map(mapHeartbeat);
}

export async function listRecentWorkerProcessingMetrics(limit = 100) {
  const result = await query<WorkerProcessingMetricRow>(
    "select * from public.worker_processing_metrics order by created_at desc limit $1",
    [limit]
  );
  return result.rows.map(mapMetric);
}

export async function listRecentWorkerFailures(limit = 100) {
  const result = await query<WorkerFailureRow>(
    "select * from public.worker_failures order by created_at desc limit $1",
    [limit]
  );
  return result.rows.map(mapFailure);
}

export async function getOutboxObservabilitySnapshot(): Promise<OutboxObservabilitySnapshot> {
  const [summary, rows] = await Promise.all([
    query<{
      pending_count: string;
      failed_count: string;
      dead_letter_count: string;
      published_count: string;
      failed_job_count: string;
      oldest_created_at: Timestamp | null;
    }>(`
select
  count(*) filter (where status = 'PENDING')::text as pending_count,
  count(*) filter (where status = 'FAILED')::text as failed_count,
  count(*) filter (where status = 'DEAD_LETTER')::text as dead_letter_count,
  count(*) filter (where status = 'PUBLISHED')::text as published_count,
  (select count(*)::text from public.worker_failures where event_type = 'outbox.dispatch') as failed_job_count,
  min(created_at) filter (where status in ('PENDING', 'FAILED')) as oldest_created_at
from public.outbox_events
`),
    query<{
      event_type: string;
      status: OutboxObservabilityRow["status"];
      attempt_count: number;
      created_at: Timestamp;
      published_at: Timestamp | null;
    }>(`
select event_type, status, attempt_count, created_at, published_at
from public.outbox_events
order by created_at desc
limit 1000
`),
  ]);
  const value = summary.rows[0];
  return {
    pendingCount: Number(value.pending_count),
    failedCount: Number(value.failed_count),
    deadLetterCount: Number(value.dead_letter_count),
    publishedCount: Number(value.published_count),
    failedJobCount: Number(value.failed_job_count),
    oldestCreatedAt: iso(value.oldest_created_at),
    rows: rows.rows.map((row) => ({
      event_type: row.event_type,
      status: row.status,
      attempt_count: row.attempt_count,
      created_at: iso(row.created_at)!,
      published_at: iso(row.published_at),
    })),
  };
}

export async function closeWorkerObservabilityPool() {
  const activePool = pool;
  pool = null;
  await activePool?.end();
}
