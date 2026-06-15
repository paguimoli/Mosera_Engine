import type { API_CLIENT_SCOPES, API_CLIENT_STATUSES } from "./auth.constants";

export type ApiClientStatus =
  (typeof API_CLIENT_STATUSES)[keyof typeof API_CLIENT_STATUSES];

export type ApiClientScope =
  (typeof API_CLIENT_SCOPES)[keyof typeof API_CLIENT_SCOPES];

export type ApiClient = {
  id: string;
  clientId: string;
  clientName: string;
  clientSecretHash: string;
  status: ApiClientStatus;
  allowedScopes: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
};

export type ApiAccessToken = {
  id: string;
  apiClientId: string;
  accessTokenHash: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};

export type CreateApiClientInput = {
  clientName: string;
  allowedScopes: string[];
};

export type CreateApiClientResult = {
  clientId: string;
  clientSecret: string;
};

export type IssueClientCredentialsTokenInput = {
  clientId: string;
  clientSecret: string;
  requestedScopes: string[];
};

export type ClientCredentialsTokenResult =
  | {
      success: true;
      accessToken: string;
      tokenType: "Bearer";
      expiresIn: number;
      scopes: string[];
    }
  | {
      success: false;
      error: string;
    };

export type ApiClientAuthContext = {
  clientId: string;
  clientName: string;
  scopes: string[];
  hasScope(scope: string): boolean;
};
