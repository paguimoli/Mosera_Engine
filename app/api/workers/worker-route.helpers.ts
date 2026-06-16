import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
} from "@/src/domains/auth/auth-middleware";

export function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function requireAnyPermission(
  request: Request,
  permissionKeys: string[]
) {
  const authContext = await requireAuthenticatedUser(request);

  if (
    !permissionKeys.some((permissionKey) =>
      authContext.hasPermission(permissionKey)
    )
  ) {
    throw new AuthMiddlewareError(403, "Permission denied.");
  }

  return authContext;
}

export function getPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}
