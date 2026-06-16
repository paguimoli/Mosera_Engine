export type OutboxEventStatus =
  | "PENDING"
  | "PUBLISHED"
  | "FAILED"
  | "DEAD_LETTER";

export type OutboxEventPayload = Record<string, unknown>;

export type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: OutboxEventPayload;
  status: OutboxEventStatus;
  attemptCount: number;
  nextAttemptAt?: string | null;
  publishedAt?: string | null;
  lastError?: string | null;
  correlationId?: string | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type CreateOutboxEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: OutboxEventPayload;
  correlationId?: string | null;
  nextAttemptAt?: string | null;
};

export type ListPendingOutboxEventsInput = {
  limit?: number;
  now?: string;
};
