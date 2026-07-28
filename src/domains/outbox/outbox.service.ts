import {
  createOutboxEvent as createOutboxEventRecord,
  listDispatchableOutboxEvents as listDispatchableOutboxEventRecords,
  listPendingOutboxEvents as listPendingOutboxEventRecords,
  listRecentOutboxEvents as listRecentOutboxEventRecords,
  markOutboxEventDeadLetter as markOutboxEventRecordDeadLetter,
  markOutboxEventFailed as markOutboxEventRecordFailed,
  markOutboxEventPublished as markOutboxEventRecordPublished,
} from "./outbox.repository";
import type {
  CreateOutboxEventInput,
  ListPendingOutboxEventsInput,
  ListRecentOutboxEventsInput,
  MarkOutboxEventDeadLetterInput,
  MarkOutboxEventFailedInput,
  MarkOutboxEventPublishedInput,
  OutboxEvent,
} from "./outbox.types";
import {
  listDispatchablePostgresOutboxEvents,
  markPostgresOutboxEventDeadLetter,
  markPostgresOutboxEventFailed,
  markPostgresOutboxEventPublished,
} from "./outbox.postgres.repository";

function shouldUseDurablePostgresOutbox() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export async function createOutboxEvent(
  input: CreateOutboxEventInput
): Promise<OutboxEvent> {
  return createOutboxEventRecord(input);
}

export async function listPendingOutboxEvents(
  input: ListPendingOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  return listPendingOutboxEventRecords(input);
}

export async function listDispatchableOutboxEvents(
  input: ListPendingOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  if (shouldUseDurablePostgresOutbox()) {
    return listDispatchablePostgresOutboxEvents(input);
  }
  return listDispatchableOutboxEventRecords(input);
}

export async function listRecentOutboxEvents(
  input: ListRecentOutboxEventsInput = {}
): Promise<OutboxEvent[]> {
  return listRecentOutboxEventRecords(input);
}

export async function markOutboxEventPublished(
  input: MarkOutboxEventPublishedInput | string
): Promise<OutboxEvent> {
  if (shouldUseDurablePostgresOutbox()) {
    return markPostgresOutboxEventPublished(input);
  }
  return markOutboxEventRecordPublished(input);
}

export async function markOutboxEventFailed(
  input: MarkOutboxEventFailedInput
): Promise<OutboxEvent> {
  if (shouldUseDurablePostgresOutbox()) {
    return markPostgresOutboxEventFailed(input);
  }
  return markOutboxEventRecordFailed(input);
}

export async function markOutboxEventDeadLetter(
  input: MarkOutboxEventDeadLetterInput
): Promise<OutboxEvent> {
  if (shouldUseDurablePostgresOutbox()) {
    return markPostgresOutboxEventDeadLetter(input);
  }
  return markOutboxEventRecordDeadLetter(input);
}
