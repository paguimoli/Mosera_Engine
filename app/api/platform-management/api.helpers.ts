import { NextResponse } from "next/server";

import { AuthMiddlewareError } from "@/src/domains/auth/auth-middleware";
import { PlatformManagementAuthorizationError } from "@/src/domains/platform-management/platform-management-auth";
import {
  PlatformManagementConflictError,
  PlatformManagementDatabaseUnavailableError,
  PlatformManagementValidationError,
} from "@/src/domains/platform-management/platform-management.repository";

export function successJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ success: true, ...body }, { status });
}

export function errorJson(error: unknown, fallbackMessage: string) {
  if (
    error instanceof AuthMiddlewareError ||
    error instanceof PlatformManagementAuthorizationError
  ) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status }
    );
  }

  if (error instanceof PlatformManagementDatabaseUnavailableError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 503 }
    );
  }

  if (error instanceof PlatformManagementValidationError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 400 }
    );
  }

  if (error instanceof PlatformManagementConflictError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: fallbackMessage,
    },
    { status: 500 }
  );
}

export async function readObjectBody(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new PlatformManagementValidationError("Invalid JSON body.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformManagementValidationError("Invalid platform management payload.");
  }

  return body as Record<string, unknown>;
}
