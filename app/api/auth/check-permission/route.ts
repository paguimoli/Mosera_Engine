import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
  serializeAuthContext,
} from "@/src/domains/auth/auth-middleware";
import { extractSessionTokenFromRequest } from "@/src/domains/auth/auth-token.helpers";
import { isAuthServiceProviderEnabled } from "@/src/domains/auth/auth-provider";
import { getAuthServiceContext } from "@/src/domains/auth/auth-service.client";

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
    if (isAuthServiceProviderEnabled()) {
      const context = await getAuthServiceContext(
        extractSessionTokenFromRequest(request)
      );

      if (!context) {
        throw new AuthMiddlewareError(401, "Authentication required.");
      }

      return NextResponse.json({
        success: true,
        allowed: context.hasPermission(permissionKey),
        permission: permissionKey,
        ...serializeAuthContext(context),
      });
    }

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
