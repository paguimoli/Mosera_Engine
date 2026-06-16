import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CreateOutboxEventInput,
  ListPendingOutboxEventsInput,
  OutboxEvent,
  OutboxEventPayload,
  OutboxEventStatus,
} from "./outbox.types";

type OutboxEventRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: OutboxEventPayload | null;
  status: OutboxEventStatus;
  attempt_count: number;
  next_attempt_at?: string | null;
  published_at?: string | null;
  last_error?: string | null;
  correlation_id?: string | null;
  created_at: string;
  updated_at?: string | null;
};

const OUTBOX_EVENT_SELECT =
  "id, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, next_attempt_at, published_at, last_error, correlation_id, created_at, updated_at";

export class OutboxRepositoryError extends Error {
  constructor(message = "Outbox persistence operation failed.") {
    super(message);
    this.name = "OutboxRepositoryError";
  }
}

function mapOutboxEventRow(row: OutboxEventRow | null): OutboxEvent | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload ?? {},
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at ?? null,
    publishedAt: row.published_at ?? null,
    lastError: row.last_error ?? null,
    correlationId: row.correlation_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function createOutboxEvent(
  input: CreateOutboxEventInput
): Promise<OutboxEvent> {
  const { data, error } = await supabaseServerAdmin
    .from("outbox_events")
    .insert({
      event_type: input.eventType,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      payload: input.payload ?? {},
      status: "PENDING",
      correlation_id: input.correlationId ?? null,
      next_attempt_at: input.nextAttemptAt ?? null,
    })
    .select(OUTBOX_EVENT_SELECT)
    .single();

  if (error) {
    throw new OutboxRepositoryError();
  }

  const event = mapOutboxEventRow(data as OutboxEventRow | null);

  if (!event) {
    throw new OutboxRepositoryError();
  }

  return event;
}

export async function listPendingOutboxEvents(
  input: ListPendingOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  const now = input.now ?? new Date().toISOString();
  const limit = input.limit ?? 100;
  const { data, error } = await supabaseServerAdmin
    .from("outbox_events")
    .select(OUTBOX_EVENT_SELECT)
    .in("status", ["PENDING", "FAILED"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new OutboxRepositoryError();
  }

  return ((data ?? []) as OutboxEventRow[])
    .map(mapOutboxEventRow)
    .filter((event): event is OutboxEvent => Boolean(event));
}

async function updateOutboxEventStatus({
  id,
  status,
  updatePayload,
}: {
  id: string;
  status: OutboxEventStatus;
  updatePayload: Record<string, string | number | null>;
}): Promise<OutboxEvent> {
  const { data, error } = await supabaseServerAdmin
    .from("outbox_events")
    .update({
      ...updatePayload,
      status,
    })
    .eq("id", id)
    .select(OUTBOX_EVENT_SELECT)
    .single();

  if (error) {
    throw new OutboxRepositoryError();
  }

  const event = mapOutboxEventRow(data as OutboxEventRow | null);

  if (!event) {
    throw new OutboxRepositoryError();
  }

  return event;
}

export async function markOutboxEventPublished(id: string): Promise<OutboxEvent> {
  return updateOutboxEventStatus({
    id,
    status: "PUBLISHED",
    updatePayload: {
      published_at: new Date().toISOString(),
      last_error: null,
    },
  });
}

export async function markOutboxEventFailed({
  id,
  lastError,
  nextAttemptAt,
}: {
  id: string;
  lastError: string;
  nextAttemptAt?: string | null;
}): Promise<OutboxEvent> {
  const { data: existingData, error: existingError } = await supabaseServerAdmin
    .from("outbox_events")
    .select("attempt_count")
    .eq("id", id)
    .single();

  if (existingError) {
    throw new OutboxRepositoryError();
  }

  const existingAttemptCount = Number(
    (existingData as Pick<OutboxEventRow, "attempt_count"> | null)
      ?.attempt_count ?? 0
  );

  return updateOutboxEventStatus({
    id,
    status: "FAILED",
    updatePayload: {
      attempt_count: existingAttemptCount + 1,
      last_error: lastError,
      next_attempt_at: nextAttemptAt ?? null,
    },
  });
}

export async function markOutboxEventDeadLetter({
  id,
  lastError,
}: {
  id: string;
  lastError: string;
}): Promise<OutboxEvent> {
  return updateOutboxEventStatus({
    id,
    status: "DEAD_LETTER",
    updatePayload: {
      last_error: lastError,
      next_attempt_at: null,
    },
  });
}
