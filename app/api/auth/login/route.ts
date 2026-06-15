import { NextResponse } from "next/server";

import { loginController } from "@/src/domains/auth/auth.controller";
import type { AuthRequestMetadata } from "@/src/domains/auth/auth.types";

export const runtime = "nodejs";

const INVALID_CREDENTIALS_ERROR = "Invalid username or password.";

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

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return loginFailureResponse();
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
