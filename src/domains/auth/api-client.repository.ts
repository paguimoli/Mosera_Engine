import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { API_CLIENT_STATUSES } from "./auth.constants";
import type {
  ApiAccessToken,
  ApiClient,
  ApiClientStatus,
} from "./api-client.types";

type ApiClientRow = {
  id: string;
  client_id: string;
  client_name: string;
  client_secret_hash: string;
  status: string;
  allowed_scopes?: string[] | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
};

type ApiAccessTokenRow = {
  id: string;
  oauth_client_id: string;
  access_token_hash: string;
  scopes?: string[] | null;
  created_at: string;
  expires_at: string;
  revoked_at?: string | null;
};

export type CreateApiClientRecordInput = {
  clientId: string;
  clientName: string;
  clientSecretHash: string;
  allowedScopes: string[];
};

export type CreateApiAccessTokenRecordInput = {
  apiClientId: string;
  accessTokenHash: string;
  scopes: string[];
  expiresAt: string;
};

export class ApiClientRepositoryError extends Error {
  constructor(message = "API client persistence operation failed.") {
    super(message);
    this.name = "ApiClientRepositoryError";
  }
}

function isApiClientStatus(value: string): value is ApiClientStatus {
  return Object.values(API_CLIENT_STATUSES).includes(value as ApiClientStatus);
}

function mapApiClientRow(row: ApiClientRow | null): ApiClient | null {
  if (!row || !isApiClientStatus(row.status)) {
    return null;
  }

  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientSecretHash: row.client_secret_hash,
    status: row.status,
    allowedScopes: row.allowed_scopes ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

function mapApiAccessTokenRow(
  row: ApiAccessTokenRow | null
): ApiAccessToken | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    apiClientId: row.oauth_client_id,
    accessTokenHash: row.access_token_hash,
    scopes: row.scopes ?? [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
  };
}

export async function createApiClient(
  input: CreateApiClientRecordInput
): Promise<ApiClient> {
  const { data, error } = await supabaseServerAdmin
    .from("oauth_clients")
    .insert({
      client_id: input.clientId,
      client_name: input.clientName,
      client_secret_hash: input.clientSecretHash,
      status: API_CLIENT_STATUSES.ACTIVE,
      allowed_scopes: input.allowedScopes,
    })
    .select(
      "id, client_id, client_name, client_secret_hash, status, allowed_scopes, created_at, updated_at, last_used_at"
    )
    .single();

  if (error) {
    throw new ApiClientRepositoryError();
  }

  const apiClient = mapApiClientRow(data as ApiClientRow | null);

  if (!apiClient) {
    throw new ApiClientRepositoryError();
  }

  return apiClient;
}

export async function findApiClientByClientId(
  clientId: string
): Promise<ApiClient | null> {
  const { data, error } = await supabaseServerAdmin
    .from("oauth_clients")
    .select(
      "id, client_id, client_name, client_secret_hash, status, allowed_scopes, created_at, updated_at, last_used_at"
    )
    .eq("client_id", clientId)
    .maybeSingle();

  if (error) {
    throw new ApiClientRepositoryError();
  }

  return mapApiClientRow(data as ApiClientRow | null);
}

export async function updateApiClientLastUsed(
  clientId: string,
  lastUsedAt = new Date().toISOString()
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("oauth_clients")
    .update({ last_used_at: lastUsedAt })
    .eq("client_id", clientId);

  if (error) {
    throw new ApiClientRepositoryError();
  }
}

export async function createApiAccessToken(
  input: CreateApiAccessTokenRecordInput
): Promise<ApiAccessToken> {
  const { data, error } = await supabaseServerAdmin
    .from("oauth_access_tokens")
    .insert({
      oauth_client_id: input.apiClientId,
      access_token_hash: input.accessTokenHash,
      scopes: input.scopes,
      expires_at: input.expiresAt,
      revoked_at: null,
    })
    .select(
      "id, oauth_client_id, access_token_hash, scopes, created_at, expires_at, revoked_at"
    )
    .single();

  if (error) {
    throw new ApiClientRepositoryError();
  }

  const apiAccessToken = mapApiAccessTokenRow(data as ApiAccessTokenRow | null);

  if (!apiAccessToken) {
    throw new ApiClientRepositoryError();
  }

  return apiAccessToken;
}

export async function findApiAccessTokenByHash(
  tokenHash: string
): Promise<ApiAccessToken | null> {
  const { data, error } = await supabaseServerAdmin
    .from("oauth_access_tokens")
    .select(
      "id, oauth_client_id, access_token_hash, scopes, created_at, expires_at, revoked_at"
    )
    .eq("access_token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    throw new ApiClientRepositoryError();
  }

  return mapApiAccessTokenRow(data as ApiAccessTokenRow | null);
}

export async function findApiClientById(
  apiClientId: string
): Promise<ApiClient | null> {
  const { data, error } = await supabaseServerAdmin
    .from("oauth_clients")
    .select(
      "id, client_id, client_name, client_secret_hash, status, allowed_scopes, created_at, updated_at, last_used_at"
    )
    .eq("id", apiClientId)
    .maybeSingle();

  if (error) {
    throw new ApiClientRepositoryError();
  }

  return mapApiClientRow(data as ApiClientRow | null);
}

export async function revokeApiAccessToken(
  tokenId: string,
  revokedAt = new Date().toISOString()
): Promise<void> {
  const { error } = await supabaseServerAdmin
    .from("oauth_access_tokens")
    .update({ revoked_at: revokedAt })
    .eq("id", tokenId)
    .is("revoked_at", null);

  if (error) {
    throw new ApiClientRepositoryError();
  }
}
