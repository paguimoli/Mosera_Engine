export type QueueMessage<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = {
  id?: string;
  type: string;
  payload: TPayload;
  correlationId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
};

export interface QueuePublisher {
  publish(message: QueueMessage): Promise<void>;
}
