import { NextResponse } from "next/server";

import { checkAuthRateLimit } from "@/src/domains/auth/auth-rate-limit";
import { confirmPasswordResetController } from "@/src/domains/auth/auth.controller";

export const runtime = "nodejs";

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      success: false,
      errors: ["Password reset request is invalid."],
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
    return NextResponse.json(
      {
        success: false,
        errors: ["Password reset request is invalid."],
      },
      { status: 400 }
    );
  }

  const token =
    typeof (body as { token?: unknown })?.token === "string"
      ? (body as { token: string }).token
      : null;
  const rateLimit = checkAuthRateLimit({
    area: "PASSWORD_RESET_CONFIRM",
    request,
    identifiers: [token],
  });

  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const result = await confirmPasswordResetController({ body });

  if (!result.success || !result.data) {
    return NextResponse.json(
      {
        success: false,
        errors: result.errors ?? ["Password reset request is invalid."],
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
  });
}
