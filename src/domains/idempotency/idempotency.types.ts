export type IdempotencyKeyStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";

export type IdempotencyResponsePayload = Record<string, unknown>;

export type IdempotencyKey = {
  id: string;
  idempotencyKey: string;
  scope: string;
  requestHash?: string | null;
  responsePayload?: IdempotencyResponsePayload | null;
  status: IdempotencyKeyStatus;
  createdAt: string;
  completedAt?: string | null;
  expiresAt?: string | null;
};

export type StartIdempotentOperationInput = {
  idempotencyKey: string;
  scope: string;
  requestHash?: string | null;
  expiresAt?: string | null;
};

export type CompleteIdempotentOperationInput = {
  idempotencyKey: string;
  scope: string;
  responsePayload?: IdempotencyResponsePayload | null;
};

export type FailIdempotentOperationInput = {
  idempotencyKey: string;
  scope: string;
};

export type FindIdempotencyKeyInput = {
  idempotencyKey: string;
  scope?: string;
};
