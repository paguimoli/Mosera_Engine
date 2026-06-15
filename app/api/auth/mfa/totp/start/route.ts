import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
} from "@/src/domains/auth/auth-middleware";
import { startTotpEnrollment } from "@/src/domains/auth/mfa.service";

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
    const enrollment = await startTotpEnrollment(authContext);

    return NextResponse.json({
      success: true,
      ...enrollment,
    });
  } catch (error) {
    if (error instanceof AuthMiddlewareError) {
      return authErrorResponse(error);
    }

    return NextResponse.json(
      {
        success: false,
        error: "MFA enrollment failed.",
      },
      { status: 400 }
    );
  }
}
