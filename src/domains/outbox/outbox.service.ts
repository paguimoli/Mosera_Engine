import {
  createOutboxEvent as createOutboxEventRecord,
  listPendingOutboxEvents as listPendingOutboxEventRecords,
  markOutboxEventDeadLetter as markOutboxEventRecordDeadLetter,
  markOutboxEventFailed as markOutboxEventRecordFailed,
  markOutboxEventPublished as markOutboxEventRecordPublished,
} from "./outbox.repository";
import type {
  CreateOutboxEventInput,
  ListPendingOutboxEventsInput,
  OutboxEvent,
} from "./outbox.types";

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

export async function markOutboxEventPublished(
  id: string
): Promise<OutboxEvent> {
  return markOutboxEventRecordPublished(id);
}

export async function markOutboxEventFailed(input: {
  id: string;
  lastError: string;
  nextAttemptAt?: string | null;
}): Promise<OutboxEvent> {
  return markOutboxEventRecordFailed(input);
}

export async function markOutboxEventDeadLetter(input: {
  id: string;
  lastError: string;
}): Promise<OutboxEvent> {
  return markOutboxEventRecordDeadLetter(input);
}
