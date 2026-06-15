import {
  API_ACCESS_TOKEN_EXPIRATION_MINUTES,
  API_CLIENT_STATUSES,
  AUTHENTICATION_EVENT_TYPES,
} from "./auth.constants";
import {
  createApiAccessToken,
  createApiClient as createApiClientRecord,
  findApiAccessTokenByHash,
  findApiClientByClientId,
  findApiClientById,
  revokeApiAccessToken,
  updateApiClientLastUsed,
} from "./api-client.repository";
import type {
  ApiClientAuthContext,
  ClientCredentialsTokenResult,
  CreateApiClientInput,
  CreateApiClientResult,
  IssueClientCredentialsTokenInput,
} from "./api-client.types";
import {
  generateApiAccessToken,
  generateClientId,
  generateClientSecret,
  hashApiAccessToken,
  hashClientSecret,
  verifyClientSecret,
} from "./api-client.helpers";
import { extractBearerToken } from "./auth-token.helpers";
import { saveAuthAuditEvent } from "./auth.repository";

const INVALID_CLIENT_ERROR = "Invalid client credentials.";
const INVALID_SCOPE_ERROR = "Invalid requested scope.";

function addMinutes(date: Date, minutes: number): Date {
  const result = new Date(date);
  result.setMinutes(result.getMinutes() + minutes);
  return result;
}

function isExpired(expiresAt: string, now = new Date()) {
  return new Date(expiresAt).getTime() <= now.getTime();
}

function uniqueScopes(scopes: string[]) {
  return Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter(Boolean))
  );
}

function areScopesAllowed(requestedScopes: string[], allowedScopes: string[]) {
  return requestedScopes.every((scope) => allowedScopes.includes(scope));
}

async function recordApiAuditEvent(
  eventType: (typeof AUTHENTICATION_EVENT_TYPES)[keyof typeof AUTHENTICATION_EVENT_TYPES],
  metadata?: Record<string, unknown>
) {
  await saveAuthAuditEvent({
    userId: null,
    eventType,
    metadata,
  });
}

export async function createApiClient({
  clientName,
  allowedScopes,
}: CreateApiClientInput): Promise<CreateApiClientResult> {
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = hashClientSecret(clientSecret);
  const normalizedScopes = uniqueScopes(allowedScopes);

  await createApiClientRecord({
    clientId,
    clientName,
    clientSecretHash,
    allowedScopes: normalizedScopes,
  });
  await recordApiAuditEvent(AUTHENTICATION_EVENT_TYPES.API_CLIENT_CREATED, {
    clientId,
    clientName,
    allowedScopes: normalizedScopes,
  });

  return {
    clientId,
    clientSecret,
  };
}

export async function issueClientCredentialsToken({
  clientId,
  clientSecret,
  requestedScopes,
}: IssueClientCredentialsTokenInput): Promise<ClientCredentialsTokenResult> {
  const client = await findApiClientByClientId(clientId);

  if (
    !client ||
    client.status !== API_CLIENT_STATUSES.ACTIVE ||
    !verifyClientSecret(clientSecret, client.clientSecretHash)
  ) {
    await recordApiAuditEvent(AUTHENTICATION_EVENT_TYPES.API_TOKEN_REJECTED, {
      clientId,
      reason: "INVALID_CLIENT",
    });

    return {
      success: false,
      error: INVALID_CLIENT_ERROR,
    };
  }

  const scopes = uniqueScopes(requestedScopes);

  if (!areScopesAllowed(scopes, client.allowedScopes)) {
    await recordApiAuditEvent(AUTHENTICATION_EVENT_TYPES.API_TOKEN_REJECTED, {
      clientId,
      reason: "INVALID_SCOPE",
      requestedScopes: scopes,
    });

    return {
      success: false,
      error: INVALID_SCOPE_ERROR,
    };
  }

  const now = new Date();
  const accessToken = generateApiAccessToken();
  const accessTokenHash = hashApiAccessToken(accessToken);
  const expiresAt = addMinutes(
    now,
    API_ACCESS_TOKEN_EXPIRATION_MINUTES
  ).toISOString();

  await createApiAccessToken({
    apiClientId: client.id,
    accessTokenHash,
    scopes,
    expiresAt,
  });
  await updateApiClientLastUsed(client.clientId, now.toISOString());
  await recordApiAuditEvent(AUTHENTICATION_EVENT_TYPES.API_TOKEN_ISSUED, {
    clientId: client.clientId,
    scopes,
    expiresAt,
  });

  return {
    success: true,
    accessToken,
    tokenType: "Bearer",
    expiresIn: API_ACCESS_TOKEN_EXPIRATION_MINUTES * 60,
    scopes,
  };
}

export async function getApiClientAuthContext(
  request: Request
): Promise<ApiClientAuthContext | null> {
  const accessToken = extractBearerToken(request.headers.get("authorization"));

  if (!accessToken) {
    return null;
  }

  const accessTokenHash = hashApiAccessToken(accessToken);
  const token = await findApiAccessTokenByHash(accessTokenHash);

  if (!token || token.revokedAt || isExpired(token.expiresAt)) {
    return null;
  }

  const client = await findApiClientById(token.apiClientId);

  if (!client || client.status !== API_CLIENT_STATUSES.ACTIVE) {
    return null;
  }

  return {
    clientId: client.clientId,
    clientName: client.clientName,
    scopes: token.scopes,
    hasScope(scope: string) {
      return token.scopes.includes(scope);
    },
  };
}

export async function revokeIssuedApiAccessToken(tokenId: string): Promise<void> {
  await revokeApiAccessToken(tokenId);
  await recordApiAuditEvent(AUTHENTICATION_EVENT_TYPES.API_TOKEN_REVOKED, {
    tokenId,
  });
}
