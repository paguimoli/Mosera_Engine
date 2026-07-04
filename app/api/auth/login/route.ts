import { NextResponse } from "next/server";

import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";
import { loginController } from "@/src/domains/auth/auth.controller";
import { loginWithAuthService } from "@/src/domains/auth/auth-service.client";
import { isAuthServiceProviderEnabled } from "@/src/domains/auth/auth-provider";
import type { AuthRequestMetadata } from "@/src/domains/auth/auth.types";

export const runtime = "nodejs";

const INVALID_CREDENTIALS_ERROR = "Invalid username or password.";
const RATE_LIMITED_ERROR = "Too many authentication attempts. Try again later.";

function getRequestMetadata(request: Request): AuthRequestMetadata {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress =
    forwardedFor?.split(",").at(0)?.trim() ||
    request.headers.get("x-real-ip") ||
    null;

  return {
    ipAddress,
    userAgent: request.headers.get("user-agent"),
  };
}

function loginFailureResponse(error = INVALID_CREDENTIALS_ERROR) {
  return NextResponse.json(
    {
      success: false,
      error,
    },
    { status: 401 }
  );
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      success: false,
      error: RATE_LIMITED_ERROR,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    }
  );
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return loginFailureResponse();
  }

  const username =
    typeof (body as { username?: unknown })?.username === "string"
      ? (body as { username: string }).username
      : null;
  const rateLimit = checkAuthRateLimit({
    area: "LOGIN",
    request,
    identifiers: [username],
  });

  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  if (isAuthServiceProviderEnabled()) {
    const password =
      typeof (body as { password?: unknown })?.password === "string"
        ? (body as { password: string }).password
        : "";
    const result = await loginWithAuthService({
      username: username ?? "",
      password,
    });

    if (!result.success) {
      return loginFailureResponse(result.error);
    }

    return NextResponse.json(result);
  }

  const result = await loginController({
    body,
    metadata: getRequestMetadata(request),
  });

  if (!result.success || !result.data) {
    return loginFailureResponse(result.errors?.[0]);
  }

  return NextResponse.json(result.data);
}
