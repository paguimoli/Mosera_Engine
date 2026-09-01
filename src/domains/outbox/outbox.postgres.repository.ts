import type { Pool, QueryResultRow } from "pg";

import {
  closeWorkerPostgresPool,
  createWorkerPostgresPool,
} from "@/src/lib/database/resilient-postgres-pool";

import type {
  CreateOutboxEventInput,
  ListPendingOutboxEventsInput,
  ListRecentOutboxEventsInput,
  MarkOutboxEventDeadLetterInput,
  MarkOutboxEventFailedInput,
  MarkOutboxEventPublishedInput,
  MarkOutboxEventsPublishedInput,
  OutboxEvent,
} from "./outbox.types";

type OutboxRow = QueryResultRow & {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  status: OutboxEvent["status"];
  attempt_count: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  last_error: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
};

let pool: Pool | null = null;

function getPool() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for durable outbox dispatch.");
  }
  pool ??= createWorkerPostgresPool("outbox-postgres-repository", {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    max: 4,
  });
  return pool;
}

export async function createPostgresOutboxEvent(
  input: CreateOutboxEventInput
): Promise<OutboxEvent> {
  const result = await getPool().query<OutboxRow>(
    `
insert into public.outbox_events (
  event_type,
  aggregate_type,
  aggregate_id,
  payload,
  status,
  correlation_id,
  next_attempt_at
)
values ($1, $2, $3, $4::jsonb, 'PENDING', $5, $6)
returning *
`,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload ?? {}),
      input.correlationId ?? null,
      input.nextAttemptAt ? new Date(input.nextAttemptAt) : null,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Outbox event was not persisted.");
  return mapRow(row);
}

export async function listPendingPostgresOutboxEvents(
  input: ListPendingOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  return listDispatchablePostgresOutboxEvents(input);
}

export async function listRecentPostgresOutboxEvents(
  input: ListRecentOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 250);
  const values: unknown[] = [limit];
  const statusClause = input.status ? "where status = $2" : "";
  if (input.status) values.push(input.status);
  const result = await getPool().query<OutboxRow>(
    `
select *
from public.outbox_events
${statusClause}
order by created_at desc, id desc
limit $1
`,
    values
  );
  return result.rows.map(mapRow);
}

function mapRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
    lastError: row.last_error,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function updateOne(statement: string, values: unknown[]) {
  const result = await getPool().query<OutboxRow>(statement, values);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Outbox event was not found.");
  }
  return mapRow(row);
}

export async function listDispatchablePostgresOutboxEvents(
  input: ListPendingOutboxEventsInput = {},
): Promise<OutboxEvent[]> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 250);
  const now = input.now ? new Date(input.now) : new Date();
  const claimLeaseMs = Math.min(Math.max(input.claimLeaseMs ?? 120_000, 1_000), 600_000);
  const claimUntil = new Date(now.getTime() + claimLeaseMs);
  const result = await getPool().query<OutboxRow>(
    `
with claimed as (
  select id
  from public.outbox_events
  where status in ('PENDING', 'FAILED')
    and (next_attempt_at is null or next_attempt_at <= $1)
  order by
    case when lower(event_type) = 'settlement.requested' then 0 else 1 end,
    created_at,
    id
  for update skip locked
  limit $2
)
update public.outbox_events event
set next_attempt_at = $3
from claimed
where event.id = claimed.id
returning event.*
`,
    [now, limit, claimUntil],
  );
  return result.rows
    .map(mapRow)
    .sort((left, right) => {
      const priority = Number(left.eventType.toLowerCase() !== "settlement.requested") -
        Number(right.eventType.toLowerCase() !== "settlement.requested");
      return priority || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
}

export async function wakeFailedSettlementOutboxEvents(
  now: Date = new Date(),
): Promise<number> {
  const result = await getPool().query(
    `
update public.outbox_events
set next_attempt_at = $1
where status = 'FAILED'
  and lower(event_type) like 'settlement.%'
  and next_attempt_at > $1
`,
    [now],
  );
  return result.rowCount ?? 0;
}

export function markPostgresOutboxEventPublished(
  input: MarkOutboxEventPublishedInput | string,
): Promise<OutboxEvent> {
  const value = typeof input === "string" ? { id: input } : input;
  return updateOne(
    `
update public.outbox_events
set status = 'PUBLISHED',
    published_at = $2,
    next_attempt_at = null,
    last_error = null
where id = $1::uuid
  and status in ('PENDING', 'FAILED')
  and ($3::timestamptz is null or next_attempt_at = $3::timestamptz)
returning *
`,
    [
      value.id,
      value.publishedAt ? new Date(value.publishedAt) : new Date(),
      value.claimUntil ? new Date(value.claimUntil) : null,
    ],
  );
}

export async function markPostgresOutboxEventsPublished(
  input: MarkOutboxEventsPublishedInput,
): Promise<number> {
  if (input.ids.length === 0) return 0;
  const result = await getPool().query(
    `
update public.outbox_events
set status = 'PUBLISHED',
    published_at = $2,
    next_attempt_at = null,
    last_error = null
where id = any($1::uuid[])
  and status in ('PENDING', 'FAILED')
  and ($3::timestamptz is null or next_attempt_at = $3::timestamptz)
`,
    [
      input.ids,
      input.publishedAt ? new Date(input.publishedAt) : new Date(),
      input.claimUntil ? new Date(input.claimUntil) : null,
    ],
  );
  return result.rowCount ?? 0;
}

export function markPostgresOutboxEventFailed(
  input: MarkOutboxEventFailedInput,
): Promise<OutboxEvent> {
  return updateOne(
    `
update public.outbox_events
set status = 'FAILED',
    attempt_count = $2,
    next_attempt_at = $3,
    last_error = $4
where id = $1::uuid
  and status in ('PENDING', 'FAILED')
  and ($5::timestamptz is null or next_attempt_at = $5::timestamptz)
returning *
`,
    [
      input.id,
      input.attemptCount,
      input.nextAttemptAt ? new Date(input.nextAttemptAt) : null,
      input.lastError,
      input.claimUntil ? new Date(input.claimUntil) : null,
    ],
  );
}

export function markPostgresOutboxEventDeadLetter(
  input: MarkOutboxEventDeadLetterInput,
): Promise<OutboxEvent> {
  return updateOne(
    `
update public.outbox_events
set status = 'DEAD_LETTER',
    attempt_count = $2,
    next_attempt_at = null,
    last_error = $3
where id = $1::uuid
  and status in ('PENDING', 'FAILED')
  and ($4::timestamptz is null or next_attempt_at = $4::timestamptz)
returning *
`,
    [
      input.id,
      input.attemptCount,
      input.lastError,
      input.claimUntil ? new Date(input.claimUntil) : null,
    ],
  );
}

export async function closePostgresOutboxPool() {
  const current = pool;
  pool = null;
  await closeWorkerPostgresPool(current);
}
