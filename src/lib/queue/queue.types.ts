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
};

export const CANONICAL_EVENT_CONTRACT_VERSION = "1.0.0";

export interface QueuePublisher {
  publish(message: QueueMessage): Promise<void>;
  close?(): Promise<void>;
}
