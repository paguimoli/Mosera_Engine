export type QueueMessage<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id?: string;
  type: string;
  payload: TPayload;
  correlationId?: string | null;
};

export interface QueuePublisher {
  publish(message: QueueMessage): Promise<void>;
}
