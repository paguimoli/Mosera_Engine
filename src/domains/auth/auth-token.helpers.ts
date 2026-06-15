import type { SessionToken } from "./session.types";

const BEARER_PREFIX = "Bearer ";

export function extractBearerToken(value?: string | null): SessionToken | null {
  if (!value?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = value.slice(BEARER_PREFIX.length).trim();

  return token || null;
}

export function extractSessionTokenFromRequest(
  request: Request
): SessionToken | null {
  return extractBearerToken(request.headers.get("authorization"));
}
