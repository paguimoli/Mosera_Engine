import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CompleteIdempotentOperationInput,
  FailIdempotentOperationInput,
  FindIdempotencyKeyInput,
  IdempotencyKey,
  IdempotencyKeyStatus,
  IdempotencyResponsePayload,
  StartIdempotentOperationInput,
} from "./idempotency.types";

type IdempotencyKeyRow = {
  id: string;
  idempotency_key: string;
  scope: string;
  request_hash?: string | null;
  response_payload?: IdempotencyResponsePayload | null;
  status: IdempotencyKeyStatus;
  created_at: string;
  completed_at?: string | null;
  expires_at?: string | null;
};

const IDEMPOTENCY_KEY_SELECT =
  "id, idempotency_key, scope, request_hash, response_payload, status, created_at, completed_at, expires_at";

export class IdempotencyRepositoryError extends Error {
  constructor(message = "Idempotency persistence operation failed.") {
    super(message);
    this.name = "IdempotencyRepositoryError";
  }
}

function mapIdempotencyKeyRow(
  row: IdempotencyKeyRow | null
): IdempotencyKey | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scope: row.scope,
    requestHash: row.request_hash ?? null,
    responsePayload: row.response_payload ?? null,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

export async function startIdempotentOperation(
  input: StartIdempotentOperationInput
): Promise<IdempotencyKey> {
  const { data, error } = await supabaseServerAdmin
    .from("idempotency_keys")
    .upsert(
      {
        idempotency_key: input.idempotencyKey,
        scope: input.scope,
        request_hash: input.requestHash ?? null,
        status: "IN_PROGRESS",
        expires_at: input.expiresAt ?? null,
      },
      {
        onConflict: "idempotency_key",
        ignoreDuplicates: true,
      }
    )
    .select(IDEMPOTENCY_KEY_SELECT)
    .maybeSingle();

  if (error) {
    throw new IdempotencyRepositoryError();
  }

  const started = mapIdempotencyKeyRow(data as IdempotencyKeyRow | null);

  if (started) {
    return started;
  }

  const existing = await findIdempotencyKey({
    idempotencyKey: input.idempotencyKey,
    scope: input.scope,
  });

  if (!existing) {
    throw new IdempotencyRepositoryError();
  }

  return existing;
}

export async function completeIdempotentOperation(
  input: CompleteIdempotentOperationInput
): Promise<IdempotencyKey> {
  const { data, error } = await supabaseServerAdmin
    .from("idempotency_keys")
    .update({
      status: "COMPLETED",
      response_payload: input.responsePayload ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("idempotency_key", input.idempotencyKey)
    .eq("scope", input.scope)
    .select(IDEMPOTENCY_KEY_SELECT)
    .single();

  if (error) {
    throw new IdempotencyRepositoryError();
  }

  const key = mapIdempotencyKeyRow(data as IdempotencyKeyRow | null);

  if (!key) {
    throw new IdempotencyRepositoryError();
  }

  return key;
}

export async function failIdempotentOperation(
  input: FailIdempotentOperationInput
): Promise<IdempotencyKey> {
  const { data, error } = await supabaseServerAdmin
    .from("idempotency_keys")
    .update({
      status: "FAILED",
      completed_at: new Date().toISOString(),
    })
    .eq("idempotency_key", input.idempotencyKey)
    .eq("scope", input.scope)
    .select(IDEMPOTENCY_KEY_SELECT)
    .single();

  if (error) {
    throw new IdempotencyRepositoryError();
  }

  const key = mapIdempotencyKeyRow(data as IdempotencyKeyRow | null);

  if (!key) {
    throw new IdempotencyRepositoryError();
  }

  return key;
}

export async function findIdempotencyKey(
  input: FindIdempotencyKeyInput
): Promise<IdempotencyKey | null> {
  let query = supabaseServerAdmin
    .from("idempotency_keys")
    .select(IDEMPOTENCY_KEY_SELECT)
    .eq("idempotency_key", input.idempotencyKey);

  if (input.scope) {
    query = query.eq("scope", input.scope);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new IdempotencyRepositoryError();
  }

  return mapIdempotencyKeyRow(data as IdempotencyKeyRow | null);
}
