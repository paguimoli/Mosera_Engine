import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
  serializeAuthContext,
} from "@/src/domains/auth/auth-middleware";

export const runtime = "nodejs";

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

export async function GET(request: Request) {
  const permissionKey = new URL(request.url).searchParams
    .get("permission")
    ?.trim();

  if (!permissionKey) {
    return NextResponse.json(
      {
        success: false,
        error: "Permission key is required.",
      },
      { status: 400 }
    );
  }

  try {
    const context = await requireAuthenticatedUser(request);

    return NextResponse.json({
      success: true,
      allowed: context.hasPermission(permissionKey),
      permission: permissionKey,
      ...serializeAuthContext(context),
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "Authentication failed.",
      },
      { status: 401 }
    );
  }
}
