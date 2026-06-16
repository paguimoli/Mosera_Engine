import {
  completeIdempotentOperation as completeIdempotentOperationRecord,
  failIdempotentOperation as failIdempotentOperationRecord,
  findIdempotencyKey as findIdempotencyKeyRecord,
  startIdempotentOperation as startIdempotentOperationRecord,
} from "./idempotency.repository";
import type {
  CompleteIdempotentOperationInput,
  FailIdempotentOperationInput,
  FindIdempotencyKeyInput,
  IdempotencyKey,
  StartIdempotentOperationInput,
} from "./idempotency.types";

export async function startIdempotentOperation(
  input: StartIdempotentOperationInput
): Promise<IdempotencyKey> {
  return startIdempotentOperationRecord(input);
}

export async function completeIdempotentOperation(
  input: CompleteIdempotentOperationInput
): Promise<IdempotencyKey> {
  return completeIdempotentOperationRecord(input);
}

export async function failIdempotentOperation(
  input: FailIdempotentOperationInput
): Promise<IdempotencyKey> {
  return failIdempotentOperationRecord(input);
}

export async function findIdempotencyKey(
  input: FindIdempotencyKeyInput
): Promise<IdempotencyKey | null> {
  return findIdempotencyKeyRecord(input);
}
