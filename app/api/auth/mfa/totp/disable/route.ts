import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
} from "@/src/domains/auth/auth-middleware";
import { disableTotp } from "@/src/domains/auth/mfa.service";

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

export async function POST(request: Request) {
  try {
    const authContext = await requireAuthenticatedUser(request);
    await disableTotp(authContext);

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "MFA disable failed.",
      },
      { status: 400 }
    );
  }
}
