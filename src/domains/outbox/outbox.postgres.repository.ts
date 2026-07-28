import { Pool, type QueryResultRow } from "pg";

import type {
  ListPendingOutboxEventsInput,
  MarkOutboxEventDeadLetterInput,
  MarkOutboxEventFailedInput,
  MarkOutboxEventPublishedInput,
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
  pool ??= new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    max: 4,
  });
  return pool;
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
  const result = await getPool().query<OutboxRow>(
    `
select *
from public.outbox_events
where status in ('PENDING', 'FAILED')
  and (next_attempt_at is null or next_attempt_at <= $1)
order by created_at, id
limit $2
`,
    [now, limit],
  );
  return result.rows.map(mapRow);
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
returning *
`,
    [value.id, value.publishedAt ? new Date(value.publishedAt) : new Date()],
  );
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
returning *
`,
    [
      input.id,
      input.attemptCount,
      input.nextAttemptAt ? new Date(input.nextAttemptAt) : null,
      input.lastError,
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
returning *
`,
    [input.id, input.attemptCount, input.lastError],
  );
}

export async function closePostgresOutboxPool() {
  const current = pool;
  pool = null;
  await current?.end();
}
