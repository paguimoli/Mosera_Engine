import { NextResponse } from "next/server";

import {
  AuthMiddlewareError,
  requireAuthenticatedUser,
} from "@/src/domains/auth/auth-middleware";
import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";
import { verifyTotpEnrollment } from "@/src/domains/auth/mfa.service";

export const runtime = "nodejs";

type VerifyTotpRequestBody = {
  code?: unknown;
};

function authErrorResponse(error: AuthMiddlewareError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
    },
    { status: error.status }
  );
}

function getTotpCode(body: VerifyTotpRequestBody): string | null {
  if (typeof body.code !== "string" || body.code.trim() === "") {
    return null;
  }

  return body.code.trim();
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      success: false,
      error: "MFA verification failed.",
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
  let body: VerifyTotpRequestBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid JSON body.",
      },
      { status: 400 }
    );
  }

  const code = getTotpCode(body);

  if (!code) {
    return NextResponse.json(
      {
        success: false,
        error: "MFA code is required.",
      },
      { status: 400 }
    );
  }

  const rateLimit = checkAuthRateLimit({
    area: "MFA_TOTP_VERIFY",
    request,
    identifiers: [code],
  });

  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  try {
    const authContext = await requireAuthenticatedUser(request);
    const result = await verifyTotpEnrollment(authContext, code);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          errors: result.errors,
        },
        { status: 400 }
      );
    }

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
        error: "MFA verification failed.",
      },
      { status: 400 }
    );
  }
}
