import { NextResponse } from "next/server";

import { issueClientCredentialsToken } from "@/src/domains/auth/api-client.service";
import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";

export const runtime = "nodejs";

type OAuthTokenRequestBody = {
  grant_type?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  scope?: unknown;
};

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseScopes(scope: unknown) {
  if (typeof scope !== "string" || scope.trim() === "") {
    return [];
  }

  return Array.from(
    new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean))
  );
}

function oauthError(error: string, status: number) {
  return NextResponse.json(
    {
      error,
    },
    { status }
  );
}

export async function POST(request: Request) {
  let body: OAuthTokenRequestBody;

  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_request", 400);
  }

  if (body.grant_type !== "client_credentials") {
    return oauthError("unsupported_grant_type", 400);
  }

  const clientId = getString(body.client_id);
  const clientSecret = getString(body.client_secret);
  const rateLimit = checkAuthRateLimit({
    area: "OAUTH_TOKEN",
    request,
    identifiers: [clientId],
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      }
    );
  }

  if (!clientId || !clientSecret) {
    return oauthError("invalid_client", 401);
  }

  let result: Awaited<ReturnType<typeof issueClientCredentialsToken>>;

  try {
    result = await issueClientCredentialsToken({
      clientId,
      clientSecret,
      requestedScopes: parseScopes(body.scope),
    });
  } catch {
    return oauthError("invalid_client", 401);
  }

  if (!result.success) {
    return oauthError(
      result.error === "Invalid requested scope."
        ? "invalid_scope"
        : "invalid_client",
      result.error === "Invalid requested scope." ? 400 : 401
    );
  }

  return NextResponse.json({
    access_token: result.accessToken,
    token_type: result.tokenType,
    expires_in: result.expiresIn,
    scope: result.scopes.join(" "),
  });
}
