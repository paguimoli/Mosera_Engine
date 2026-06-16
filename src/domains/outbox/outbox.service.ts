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
  return markOutboxEventRecordPublished(input);
}

export async function markOutboxEventFailed(
  input: MarkOutboxEventFailedInput
): Promise<OutboxEvent> {
  return markOutboxEventRecordFailed(input);
}

export async function markOutboxEventDeadLetter(
  input: MarkOutboxEventDeadLetterInput
): Promise<OutboxEvent> {
  return markOutboxEventRecordDeadLetter(input);
}
