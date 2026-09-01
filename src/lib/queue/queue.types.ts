export type QueueMessage<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = {
  id?: string;
  type: string;
  contractVersion?: string;
  payload: TPayload;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  occurredAt?: string;
  transportPublishedAt?: string;
  transportDispatcherSeenAt?: string;
  transportPublishStartedAt?: string;
  transportReceivedAt?: string;
  transportConsumerCallbackEnteredAt?: string;
  transportExecutionSlotRequestedAt?: string;
  transportExecutionSlotAcquiredAt?: string;
  transportHandlerStartedAt?: string;
  transportConsumerInstanceId?: string;
  transportConsumerPrefetch?: number;
  transportConsumerExecutionConcurrency?: number;
  transportActiveHandlersAtStart?: number;
  transportWaitingHandlersAtStart?: number;
};

export const CANONICAL_EVENT_CONTRACT_VERSION = "1.0.0";

export type QueueTransportReadiness = {
  ready: boolean;
  recovered: boolean;
  checkedAt: string;
  unavailableSince: string | null;
  consecutiveFailures: number;
  retryAfterMs: number;
  error: string | null;
};

export interface QueuePublisher {
  publish(message: QueueMessage): Promise<void>;
  publishBatch?(messages: readonly QueueMessage[]): Promise<void>;
  probeReadiness?(eventTypes: readonly string[]): Promise<QueueTransportReadiness>;
  close?(): Promise<void>;
}
